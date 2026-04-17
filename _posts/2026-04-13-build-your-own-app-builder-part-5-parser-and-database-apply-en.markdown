---
layout: post
title: 'Build your own X: A minimal AI app builder — Part 5: Parsing LLM output into database rows, safely'
date: '2026-04-13 12:00'
excerpt: >-
  The model can output anything. Your parser must handle repeated paths (last wins), path traversal attempts (reject silently), unclosed fences (discard), and parse failures that must not roll back an already-saved message. This post builds the full parse → normalize → upsert pipeline with intentional two-layer error isolation.
comments: false
---

## What's in this post?

`applyAssistantFileChangesFromText` was called in Part 4 but not implemented. This part fills it in. The pipeline has four pieces, each solving a distinct problem:

- **`parseAssistantFileBlocks`** — line-by-line scanner that handles mixed prose and open fences during streaming.
- **`normalizeProjectPath`** — path sanitizer that rejects traversal and Windows roots even in a database-only context.
- **`applyParsedFilesToProject`** — last-wins deduplication then all-or-nothing upsert inside a transaction.
- **`applyAssistantFileChangesFromText`** — two separate try/catch blocks that keep parse failures isolated from database failures and both isolated from the assistant message that already saved.

---

## Goal

After Part 4, assistant replies are stored as plain text. File fences inside those replies do nothing. After this part, every completed assistant message triggers a parse, and valid file blocks become `FileEntry` upserts.

---

## Prerequisites

Parts 1–4 working (streaming, message persistence).

**Estimated time:** about 90 minutes (parser edge cases + tests).

---

## Treating model output as adversarial

Even with a well-designed system prompt, the model is not fully under your control. In practice you will see:

- A path repeated twice in one reply (which version is correct?).
- A path like `../../.env` from a confused or misaligned model.
- A fence that opens but never closes because the model hit a token limit.
- A tutorial fence with a language tag like ` ```tsx ` rather than a path.
- Nested backtick blocks that terminate your scanner early.

Your parser must handle all of these without throwing. The output should be: "zero or more valid `{ path, content }` pairs." Any block that fails validation is silently skipped—the rest of the reply is still processed.

---

## The line scanner

```ts
// src/server/chat/parseAssistantFileBlocks.ts (simplified)
export function parseAssistantFileBlocks(text: string): Array<{ path: string; content: string }> {
  const lines = normalizeNewlines(text).split("\n");
  const out: Array<{ path: string; content: string }> = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith("```")) {
      i += 1;
      continue;
    }

    const rest = line.slice(3); // everything after the opening backticks
    if (!isValidOpenRest(rest)) {
      // Not a path-led fence — could be ```tsx or ``` (empty). Skip.
      i += 1;
      continue;
    }

    const body: string[] = [];
    let j = i + 1;
    let closed = false;

    while (j < lines.length) {
      const L = lines[j]!;
      if (isClosingFenceLine(L)) {
        const normalizedPath = normalizeProjectPath(rest);
        if (normalizedPath !== null) {
          out.push({ path: normalizedPath, content: body.join("\n") });
        }
        i = j + 1;
        closed = true;
        break;
      }
      body.push(L);
      j += 1;
    }

    if (!closed) break; // unclosed fence at end of text — discard and stop
  }

  return out;
}
```

**`isValidOpenRest(rest)`** — returns true only when `rest` looks like a file path: no spaces, contains a `/` or a `.`, does not match known language tags (`tsx`, `ts`, `js`, `bash`, `json`). This keeps the parser from treating ` ```tsx ` tutorial fences as file operations.

**Unclosed fence** — if the scanner reaches end of text without a closing ` ``` `, it discards the partial block and stops. You never write half a file. This matters less for saved messages (the full stream has landed) but the same scanner is reused for the streaming chat UI in Part 9, where open fences are expected and rendered differently.

---

## Path normalization

Even though paths live in a database, not the filesystem, you still sanitize them:

```ts
// src/server/files/projectPath.ts
export function normalizeProjectPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  let s = trimmed.replace(/\\/g, "/"); // Windows backslashes → forward slashes
  if (s.startsWith("/")) return null;  // reject absolute paths
  if (/^[a-zA-Z]:/.test(s)) return null; // reject Windows drive roots (C:\)

  s = s.replace(/\/+/g, "/").replace(/\/+$/, ""); // collapse double slashes, strip trailing
  if (s === "") return null;

  const segments = s.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return null; // reject traversal
  }

  return segments.join("/");
}
```

**Why sanitize paths in a database-only system?**

1. A future export-to-zip feature (Part 7's roadmap item) would write these paths to disk. Sanitizing now prevents a whole class of bugs later.
2. The workbench REST API (Part 7) uses the same `normalizeProjectPath`. Consistent validation means a path that the parser accepts will also pass the API's checks.
3. `..` in a path that later gets mounted into WebContainer (Part 10) could escape the virtual filesystem. Defence in depth.

When `normalizeProjectPath` returns `null`, the block is skipped silently—not thrown. The rest of the reply continues to be processed.

---

## Database write: last-wins and all-or-nothing

Two design choices before touching SQLite:

**Last-wins for duplicate paths:**

```ts
const lastWins = new Map<string, string>();
for (const row of files) {
  const path = normalizeProjectPath(row.path);
  if (path === null) throw new Error(`Invalid path after normalization: ${JSON.stringify(row.path)}`);
  lastWins.set(path, row.content);
}
```

If the model outputs `src/App.tsx` twice, the second fence's content wins. This matches the mental model of "the model's final answer for this file is the last one it wrote."

**All-or-nothing upsert in a transaction:**

```ts
// src/server/files/applyParsedFilesToProject.ts (excerpt)
export async function applyParsedFilesToProject(params: {
  projectId: string;
  files: ParsedFileForProject[];
}): Promise<{ upserted: number }> {
  const { projectId, files } = params;
  if (files.length === 0) return { upserted: 0 };

  const lastWins = new Map<string, string>();
  for (const row of files) {
    const path = normalizeProjectPath(row.path);
    if (path === null) throw new Error(`Invalid project path: ${JSON.stringify(row.path)}`);
    lastWins.set(path, row.content);
  }

  const rows = [...lastWins.entries()].map(([path, content]) => ({ path, content }));

  return prisma.$transaction(async (tx) => {
    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) throw new Error(`Project not found: ${projectId}`);

    for (const row of rows) {
      await tx.fileEntry.upsert({
        where: { projectId_path: { projectId, path: row.path } },
        create: { projectId, path: row.path, content: row.content },
        update: { content: row.content },
      });
    }

    return { upserted: rows.length };
  });
}
```

The transaction starts with a project existence check. The user might delete the project between stream end and parse completion (the background task can be seconds late). Without this check, upserts would fail with a foreign key constraint error—a confusing crash. With it, you get a clean "project not found" error you can log and ignore.

`projectId_path` is Prisma's generated name for the `@@unique([projectId, path])` constraint from Part 2. If you rename the fields in the schema, this key name changes too.

---

## Two-layer error isolation

```ts
// src/server/chat/applyAssistantFileChangesFromText.ts
export async function applyAssistantFileChangesFromText(
  projectId: string,
  assistantText: string,
): Promise<void> {
  let files;

  try {
    files = parseAssistantFileBlocks(assistantText);
  } catch (err) {
    console.error("[chat:apply-files] parse failed", err);
    return; // parse error never reaches DB layer
  }

  if (files.length === 0) return; // nothing to apply

  try {
    await applyParsedFilesToProject({ projectId, files });
  } catch (err) {
    console.error("[chat:apply-files] apply failed", err);
    // DB error is logged but does not propagate
  }
}
```

Two separate try/catch blocks serve two different isolation boundaries:

1. **Parse errors** — a bug in `parseAssistantFileBlocks` or unexpected model output never reaches the database. You log it and return.
2. **Database errors** — a failed transaction (network blip, deleted project) is logged but does not propagate. By the time `applyAssistantFileChangesFromText` runs, `createMessage(assistant)` has already succeeded. The message is safe in the database; file apply is best-effort.

Swallowing errors here is deliberate, not lazy. The assistant message is the user's chat history—that must never be lost. File apply failing silently means the user can still see the model's reply, read it, and manually apply the change if needed.

---

## Where the pipeline plugs in

In `persistAssistantFromStream` (Part 4):

```ts
await readOpenAiChatStream(stream, (delta) => { text += delta; });
await createMessage({ projectId, role: "assistant", content: text }); // must come first
await applyAssistantFileChangesFromText(projectId, text);              // best-effort
```

The order is strict:
1. Full text accumulated.
2. Message saved.
3. Files applied.

If you reverse 2 and 3, a crash after file apply but before message save produces files in the DB with no corresponding assistant message—a consistency hole that is hard to reason about.

---

## Check your work

- [ ] Ask the model to change `src/App.tsx`. After the stream completes, Prisma Studio shows updated `content` for that path, and `updatedAt` is newer than the template's creation time.
- [ ] A fence with `../../` in the path creates no row (check the server logs for "parse failed" or look for missing rows).
- [ ] A reply with the same path twice results in one row with the last fence's content.
- [ ] Run `npm run test:run` — parser unit tests pass.

---

## Troubleshooting

| Problem | What to check |
|---------|---------------|
| Files never update | Confirm `applyAssistantFileChangesFromText` is called after `createMessage`; read console.error output in terminal. |
| Partial file content | Nested backticks inside a file body terminate the block early—tighten the system prompt or accept this as MVP scope. |
| `upsert` errors | `@@unique([projectId, path])` must exist; run `npx prisma migrate dev`. |
| Parse finds zero files | Log `parseAssistantFileBlocks(text)` output; check that the model follows the fence format from Part 3. |

---

## What comes next

[Part 6](https://github.com/minhmannh2001/minhmannh2001.github.io/blob/master/_posts/2026-04-14-build-your-own-app-builder-part-6-workspace-snapshot-en.markdown) adds the workspace snapshot: the mechanism that tells the model what files currently exist before it replies. Without it, the model edits blind on every turn after the first.

---

*Next: [Part 6 — Context engineering: the workspace snapshot](https://github.com/minhmannh2001/minhmannh2001.github.io/blob/master/_posts/2026-04-14-build-your-own-app-builder-part-6-workspace-snapshot-en.markdown).*
