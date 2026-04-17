---
layout: post
title: 'Build your own X: A minimal AI app builder — Part 9: Rendering code that is still being written, and seeing what you sent the model'
date: '2026-04-17 12:00'
excerpt: >-
  While the model is streaming, a fenced code block is open—there is no closing fence yet. Your renderer must handle that state without crashing or showing raw backticks. This part builds the segment scanner with a closed:false state, the collapsible CodeMirror card, and the context strip that shows exactly how large the last workspace snapshot was.
comments: false
---

## What's in this post?

Two UX problems remain after Part 8:

1. **Streaming code blocks** — while the model is mid-reply, a file fence is open (no closing ` ``` `). Naively displaying raw markdown shows the user raw backticks and a path token.
2. **Context opacity** — when debugging "why did the model not know about my file?", you want to see exactly how many files and characters were in the snapshot sent with the last request.

This part adds:

- **`parseChatMessageSegments`** — splits assistant text into alternating prose and code segments; tracks `closed: false` while a fence is still open during streaming.
- **`ChatCodeBlockCard`** — short blocks auto-expand; long blocks start collapsed; streaming blocks show a distinct state until the closing fence arrives.
- **`GET /api/projects/[projectId]/last-ai-context`** — returns snapshot stats from the in-memory store built in Part 6.
- **`LastAiWorkspaceContextStrip`** — displays budget usage, file count, and truncation warnings; refreshes after each chat request.

---

## Goal

After this part, chat messages render cleanly: prose is styled normally, code blocks have syntax highlighting and expand/collapse controls, and a debug strip below the chat input shows how much context you are sending.

---

## Prerequisites

Parts 1–8 complete (snapshot logic from Part 6 already writes to the in-memory store).

**Estimated time:** about 60 minutes.

---

## The problem with rendering during streaming

When the model is mid-reply:

```text
"Here is the updated component:\n\n```src/App.tsx\nimport { useState } from \"react\";\n"
```

The fence has opened (` ```src/App.tsx `). The content is accumulating. The closing ` ``` ` has not arrived yet.

If you render this as a markdown string, you get raw backticks in the output. If you try to parse it with `parseAssistantFileBlocks` from Part 5, the unclosed fence is discarded—nothing renders.

You need a **display-specific parser** that is more permissive than the database parser:
- It handles ` ```tsx ` language fences (for tutorial examples the model might include).
- It tracks `closed: false` on the last segment when the stream is live.
- It renders a streaming placeholder instead of a code card for unclosed fences.

---

## The segment scanner

```ts
// src/lib/chat/parseChatMessageSegments.ts
export type ChatMessageSegment =
  | { type: "text"; text: string }
  | { type: "code"; label: string; code: string; closed: boolean };

export function parseChatMessageSegments(raw: string): ChatMessageSegment[] {
  const text = normalizeNewlines(raw);
  if (text === "") return [];

  const lines = text.split("\n");
  const out: ChatMessageSegment[] = [];
  let textBuf: string[] = [];
  let i = 0;

  const flushText = () => {
    if (textBuf.length === 0) return;
    const t = textBuf.join("\n");
    if (t.length > 0) out.push({ type: "text", text: t });
    textBuf = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      flushText();
      const label = line.slice(3).replace(/\s+$/u, ""); // strip trailing whitespace
      i += 1;
      const codeLines: string[] = [];
      let closed = false;

      while (i < lines.length) {
        const L = lines[i]!;
        if (isClosingFence(L)) {
          closed = true;
          i += 1;
          break;
        }
        codeLines.push(L);
        i += 1;
      }

      out.push({ type: "code", label, code: codeLines.join("\n"), closed });
    } else {
      textBuf.push(line);
      i += 1;
    }
  }

  flushText();
  return out;
}
```

When the stream is live, the last segment in the array will have `closed: false`. When the model finally emits the closing ` ``` `, the same text with the new token appended will parse the segment as `closed: true`.

### Why streaming can be gradual *and* well-formatted

At first this sounds contradictory: if text is still arriving in chunks, how can the UI already know where prose ends and code begins? The key is that the UI does **not** try to permanently format each tiny chunk in isolation. Instead, on every delta it appends to the current message string, then runs `parseChatMessageSegments` against the **entire accumulated text so far**.

That gives you two useful properties at once:

1. **Gradual display** — every `onDelta` callback still appends immediately, so the bubble keeps growing token by token.
2. **Stable structure** — each render recomputes segments from full current text, so once a fence opener appears, all following lines are treated as code until a closing fence arrives.

During that open-fence window, the parser marks the segment `closed: false`, and the UI intentionally shows a streaming code state instead of pretending the block is complete. When the closing fence token eventually arrives, the next parse flips the same segment to `closed: true`, and `ChatCodeBlockCard` switches to the final formatted code view.

In other words, formatting is not delayed until the very end; it is **continuously re-derived** from the latest complete prefix of the model output.

**This parser is intentionally more permissive than `parseAssistantFileBlocks`:**
- It accepts ` ```tsx ` language labels (the display should show them, even if the DB parser would skip them as non-path labels).
- It does not call `normalizeProjectPath`—that is not the display parser's job.
- It renders every segment, including blocks with labels that fail path validation.

---

## The `ChatCodeBlockCard` component

```tsx
function ChatCodeBlockCard({ segment, streaming }: {
  segment: Extract<ChatMessageSegment, { type: "code" }>;
  streaming: boolean;
}) {
  const isLong = segment.code.split("\n").length > 14 || segment.code.length > 2000;
  const [expanded, setExpanded] = useState(!isLong);

  // Reset expanded state when `closed` transitions true→false (new streaming block)
  const closedKey = segment.closed ? "closed" : "open";

  if (!segment.closed) {
    return (
      <div className="chat-code-block streaming">
        <span className="label">{segment.label || "code"}</span>
        <span className="streaming-indicator">Streaming…</span>
        <pre className="preview">{segment.code.slice(-200)}</pre>
      </div>
    );
  }

  return (
    <div className="chat-code-block" key={closedKey}>
      <div className="header">
        <span className="label">{segment.label || "code"}</span>
        {isLong && (
          <button onClick={() => setExpanded((e) => !e)}>
            {expanded ? "Collapse" : "Expand"}
          </button>
        )}
      </div>
      {expanded && (
        <WorkbenchCodeMirror
          value={segment.code}
          path={segment.label}
          readOnly
        />
      )}
    </div>
  );
}
```

**The `key={closedKey}` trick:** when the `closed` state transitions from `false` to `true`, React unmounts and remounts `WorkbenchCodeMirror`. This resets CodeMirror's internal state cleanly—otherwise the editor might retain scroll position or selection from the streaming preview into the closed view.

**Collapse rule:** blocks longer than 14 lines or 2000 characters start collapsed. A one-line fix should be immediately visible; a 200-line file should not fill the entire viewport.

**`streaming` prop:** the parent `ChatMessageBody` passes `streaming={true}` to the **last** code segment when the stream is live. This lets the card render a streaming state even when `closed` is still false.

---

## The context strip: seeing what you sent

**`GET /api/projects/[projectId]/last-ai-context`:**

```ts
// src/app/api/projects/[projectId]/last-ai-context/route.ts
export async function GET(_request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const lastRun = getLastAiWorkspaceSnapshot(projectId.trim());
  return NextResponse.json(
    { lastRun },
    { headers: { "Cache-Control": "no-store" } },
  );
}
```

Returns the `AiWorkspaceSnapshotLastRun` struct that Part 6's `buildWorkspaceSnapshotUserContent` populated. Fields include:
- `snapshotCodeUnits` — total characters in the snapshot.
- `maxSnapshotCodeUnits` — the configured budget cap.
- `includedFileCount` — how many files made it in.
- `totalProjectFileCount` — total files in the project.
- `truncatedByFileLimit` / `truncatedByChars` — whether limits were hit.
- `includedFiles` — array of `{ path, utf8Bytes }` for each included file.

**`Cache-Control: no-store`** is essential. Without it, the browser caches the JSON response and shows stale stats from the previous request for every subsequent chat turn.

**`LastAiWorkspaceContextStrip`:** fetches this endpoint after each successful chat POST. The `refreshKey` pattern triggers the fetch:

```tsx
// In useProjectChat, after the stream completes:
setLastAiContextRevision((n) => n + 1); // increment → triggers re-fetch

// In LastAiWorkspaceContextStrip:
useEffect(() => {
  fetch(`/api/projects/${projectId}/last-ai-context`, { cache: "no-store" })
    .then((r) => r.json())
    .then((data) => setLastRun(data.lastRun));
}, [projectId, refreshKey]); // refreshKey = lastAiContextRevision from chat hook
```

**In-memory limitation:** the map resets on server restart. If you restart `npm run dev` mid-session, the strip shows "No data yet" until the next chat request. This is acceptable for a local debug tool. Persisting `lastRun` to the database would cost an extra write per chat request for a debugging feature—not worth it for MVP.

---

## What the strip tells you

A typical strip for a 9-file Vite template project with a short chat history:

```text
Context sent: 12,450 / 120,000 chars · 9 / 9 files · No truncation
```

When you have many files and hit the budget:

```text
Context sent: 119,842 / 120,000 chars · 18 / 40 files · TRUNCATED (char limit)
```

This is the signal to either increase `CHAT_WORKSPACE_SNAPSHOT_MAX_CHARS`, split the project into smaller scopes, or add the relevant files to the spine list.

---

## Check your work

- [ ] A model reply containing a ` ```src/App.tsx ` fence shows syntax-highlighted code, not raw backticks.
- [ ] Long fences (>14 lines) start collapsed. Short fences expand automatically.
- [ ] While streaming, an open fence shows a "Streaming…" state with a preview of the last ~200 characters.
- [ ] After sending a message, the context strip updates with file count and character usage.
- [ ] Restarting the dev server clears the strip until the next chat turn.

---

## Troubleshooting

| Problem | What to check |
|---------|---------------|
| Strip always shows "No data" | Confirm `setLastAiWorkspaceSnapshot` runs in the route handler; confirm `GET` route reads the same projectId. |
| Highlighting wrong for `tsx` | `extensionsForChatFenceLabel` should map language tags to extensions, then delegate to `extensionsForPath` for path-like labels. |
| Streaming state never appears | Check that the last code segment receives `streaming={true}` only when the overall message is still streaming (not when `closed` is false on a finished message). |

---

## What comes next

[Part 10](https://github.com/minhmannh2001/minhmannh2001.github.io/blob/master/_posts/2026-04-18-build-your-own-app-builder-part-10-webcontainer-preview-en.markdown) adds the Preview panel: a full Vite dev server running inside the browser tab. It requires cross-origin isolation headers—but only on workspace routes, not globally, to avoid breaking third-party scripts on other pages.

---

*Next: [Part 10 — WebContainer: running Node.js in the browser tab](https://github.com/minhmannh2001/minhmannh2001.github.io/blob/master/_posts/2026-04-18-build-your-own-app-builder-part-10-webcontainer-preview-en.markdown).*
