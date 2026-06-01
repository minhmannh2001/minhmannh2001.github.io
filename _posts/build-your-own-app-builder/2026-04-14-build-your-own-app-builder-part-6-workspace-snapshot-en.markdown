---
layout: post
title: 'Build your own X: A minimal AI app builder — Part 6: Context engineering — what the model knows when it edits'
date: '2026-04-14 12:00'
excerpt: >-
  Without context, the model edits blind. On turn two it might rewrite a file it has never seen. This part builds the workspace snapshot: a selection algorithm that picks spine files first, fills remaining budget with the most recently edited files, and truncates gracefully—then records exactly what was sent so the UI can show it.
comments: false
---

## What's in this post?

Context engineering is the practice of deciding **what to put in the model's context window** when you cannot fit everything. This post builds the workspace snapshot system:

- **The selection problem** — you cannot send all files; you need a principled algorithm.
- **`selectFilesForWorkspaceSnapshot`** — spine files first, then recency, then budget cap.
- **`buildWorkspaceSnapshotMarkdown`** — formats the selection as fenced blocks the model already understands.
- **Why a `user` message, not `system`** — data versus rules.
- **Debug observability** — in-memory stats so the UI can show what was sent.

---

## Goal

After Part 5, the model can write files. But without context it may:
- Rewrite `src/App.tsx` without knowing what is already there.
- Reference imports that do not exist in the current `package.json`.
- Generate a file structure inconsistent with the existing Vite config.

You fix this by injecting a workspace snapshot—a serialized view of the current `FileEntry` rows—into every model request, positioned between the system prompt and the chat history.

---

## Prerequisites

Parts 1–5 complete.

**Estimated time:** 45–60 minutes.

---

## The selection problem

A project with 40 files at 2 KB each is 80 KB. Many models have a 128 K token limit, which seems plenty—but your workspace snapshot competes with:
- The system prompt (~1 KB).
- Chat history (up to 48 KB after trimming, from Part 3).
- The model's own reply space (reserve ~8 K for output).

You cannot afford to be careless. You need a selection policy.

**Three tiers:**

1. **Spine files** — always include these if they exist. They define the project's shape and are referenced by almost everything else:
   - `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`
2. **Recently modified** — after spine files, fill remaining slots with files sorted by `updatedAt DESC`. If the user just asked about `src/components/Counter.tsx`, that file was touched recently and is likely relevant.
3. **Budget cap** — stop adding files when you hit the character limit. Append a note ("Showing 12 of 40 files") so the model knows the view is partial.

```ts
// src/server/llm/workspaceSnapshotFileSelection.ts (excerpt)
export function selectFilesForWorkspaceSnapshot(
  rows: FileEntryRow[],
  maxFiles: number,
  options?: { activeFilePath?: string },
): WorkspaceSnapshotFileSelection {
  const SPINE_PATHS = new Set([
    "package.json",
    "vite.config.ts",
    "tsconfig.json",
    "index.html",
    "src/main.tsx",
    "src/App.tsx",
  ]);

  const spine: FileEntryRow[] = [];
  const rest: FileEntryRow[] = [];

  for (const row of rows) {
    if (SPINE_PATHS.has(row.path)) {
      spine.push(row);
    } else {
      rest.push(row);
    }
  }

  // If the active file is in `rest`, promote it to be included early
  if (options?.activeFilePath) {
    const idx = rest.findIndex((r) => r.path === options.activeFilePath);
    if (idx !== -1) {
      const [active] = rest.splice(idx, 1);
      rest.unshift(active!);
    }
  }

  // Sort remaining by most recently modified first
  rest.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const selected = [...spine, ...rest].slice(0, maxFiles);
  const truncatedByFileLimit = selected.length < rows.length;

  return {
    files: selected,
    totalInProject: rows.length,
    truncatedByFileLimit,
  };
}
```

The `activeFilePath` is the file currently open in the workbench. The client sends it with each chat request (Part 4). If you are editing `src/components/Counter.tsx` and ask a question about it, that file gets promoted in the snapshot even if it was not recently modified.

---

## Formatting the snapshot

The snapshot uses the same fence format as the model's output:

```ts
function formatFileFence(path: string, content: string): string {
  return `\`\`\`${path}\n${content}\n\`\`\``;
}
```

Using the same format serves two purposes:
1. The model has already seen this format in the system prompt (Part 3). One less syntax to learn.
2. When you are reading the outbound messages for debugging, the snapshot is visually consistent with the model's replies.

The full snapshot markdown looks like:

```text
## Workspace (read-only snapshot)
Files: 9 of 9

```package.json
{ ... }
```

```src/App.tsx
import { useState } from "react";
export default function App() { … }
```

… more files …
```

---

## Injecting the snapshot

```ts
// src/server/llm/buildWorkspaceSnapshot.ts (excerpt)
export async function buildWorkspaceSnapshotUserContent(
  projectId: string,
  options?: BuildWorkspaceSnapshotUserContentOptions,
): Promise<BuildWorkspaceSnapshotUserContentResult> {
  const rows = await prisma.fileEntry.findMany({
    where: { projectId },
    select: { path: true, content: true, updatedAt: true },
  });

  const limits = getWorkspaceSnapshotLimitsFromEnv();
  const selection = selectFilesForWorkspaceSnapshot(rows, limits.maxFiles, {
    activeFilePath: options?.activeFilePath,
  });

  const built = buildWorkspaceSnapshotMarkdown(
    selection.files,
    limits.maxChars,
    selection.totalInProject,
  );

  if (!built) return { markdown: null, lastRun: null };

  const lastRun: AiWorkspaceSnapshotLastRun = {
    capturedAt: new Date().toISOString(),
    includedFileCount: built.includedFiles,
    totalProjectFileCount: selection.totalInProject,
    snapshotCodeUnits: built.markdown.length,
    maxSnapshotCodeUnits: limits.maxChars,
    truncatedByFileLimit: selection.truncatedByFileLimit,
    truncatedByChars: built.truncatedByChars,
    includedFiles: built.includedFileDetails.map((f) => ({
      path: f.path,
      utf8Bytes: f.utf8Bytes,
    })),
    maxSnapshotFiles: limits.maxFiles,
  };

  return { markdown: built.markdown, lastRun };
}
```

In `buildOpenRouterMessages` (Part 3):

```ts
const messages = [{ role: "system", content: CHAT_SYSTEM_PROMPT }];

if (snapshotResult.markdown !== null) {
  messages.push({ role: "user", content: snapshotResult.markdown });
}

// … append trimmed history …
```

**Why a `user` message and not `system`?**

System messages are conventionally treated as persistent rules or persona instructions. The workspace snapshot is **data**—"here is what exists right now." Putting data in the system prompt blurs the line and may cause models to give the snapshot undue weight as a rule rather than as context. A `user` message position also means the snapshot is interleaved with the conversation in a way the model can reason about temporally ("the user showed me these files, then asked…").

---

## Tunable limits

```ts
export function getWorkspaceSnapshotLimitsFromEnv(): WorkspaceSnapshotLimits {
  return {
    maxFiles: parsePositiveInt(process.env.CHAT_WORKSPACE_SNAPSHOT_MAX_FILES, 48),
    maxChars: parsePositiveInt(process.env.CHAT_WORKSPACE_SNAPSHOT_MAX_CHARS, 120_000),
  };
}
```

Defaults are generous for local development. When debugging token pressure on a specific model, lower `CHAT_WORKSPACE_SNAPSHOT_MAX_CHARS` without changing code.

---

## Debug observability: the `lastRun` stats

After building the snapshot, the route stores stats in an in-memory map:

```ts
// In POST /api/chat route handler:
if (workspaceSnapshotLastRun) {
  setLastAiWorkspaceSnapshot(project.id, workspaceSnapshotLastRun);
}
```

A `GET /api/projects/[projectId]/last-ai-context` route reads from that map and returns the stats as JSON. Part 9 shows how to display this in the UI—a "context strip" that tells you how many files and characters you sent on the last chat turn.

**Important limitation:** this map lives in the Node.js process memory. Restarting the dev server clears it. This is acceptable for a local debugging tool; if you wanted persistence across restarts, you would write `lastRun` into the database. For MVP, in-memory is simpler.

---

## Check your work

- [ ] Add a temporary log before the `return` in `buildOpenRouterMessages` and print the message array. You should see the `## Workspace` block between the system message and the first history message.
- [ ] Edit a file manually via the workbench (Part 7, coming next). The next snapshot should reflect your edit.
- [ ] Set `CHAT_WORKSPACE_SNAPSHOT_MAX_FILES=2` and confirm the snapshot only includes spine files and one other.

---

## Troubleshooting

| Problem | What to check |
|---------|---------------|
| Snapshot always empty | `maxFiles`/`maxChars` too small; confirm `FileEntry` rows exist for the project. |
| Model "hallucinates" project structure | Ensure `package.json` and `vite.config.ts` are in the spine list and not being truncated by the char budget. |
| `lastRun` always null in API response | `setLastAiWorkspaceSnapshot` is called in the route handler; confirm the route is the current version. |

---

## What comes next

[Part 7](https://github.com/minhmannh2001/minhmannh2001.github.io/blob/master/_posts/2026-04-15-build-your-own-app-builder-part-7-file-tree-and-file-api-en.markdown) loads `FileEntry` rows into the workbench UI: a file tree, a REST API for save/delete/rename, and a CodeMirror editor that cannot import DOM APIs on the server.

---

*Next: [Part 7 — File tree UI, REST API, and CodeMirror without SSR](https://github.com/minhmannh2001/minhmannh2001.github.io/blob/master/_posts/2026-04-15-build-your-own-app-builder-part-7-file-tree-and-file-api-en.markdown).*
