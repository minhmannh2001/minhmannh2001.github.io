---
layout: post
title: 'Build your own X: A minimal AI app builder — Part 8: The sync problem — drafts, the 250 ms race, and "Updated" badges that do not lie'
date: '2026-04-16 12:00'
excerpt: >-
  Three things write to the same file simultaneously: the user types a draft, the AI applies changes via a background transaction, and router.refresh() reloads server props. Without a merge policy, the user loses their draft every time the AI edits. This part builds the algorithm that keeps all three in balance.
comments: false
---

## What's in this post?

This is the most complex coordination problem in the app. You have three concurrent writers:

1. **The user** — typing in the editor, unsaved.
2. **The AI** — `applyParsedFilesToProject` committing a transaction after the stream ends.
3. **`router.refresh()`** — reloading server props (new `workbenchFiles`) into the client component tree.

If you naively apply incoming server data, the user's draft disappears. If you always keep the draft, the AI's changes are invisible. This part builds:

- **`useWorkbenchDrafts`** — a merge hook that computes what to keep and what to drop when server data changes.
- **`useRecentlyUpdatedPaths`** — detects which paths changed on the server without mislabeling the user's own save as an AI update.
- **`scheduleWorkbenchRefresh`** — a 250 ms delayed `router.refresh()` that gives the background transaction time to commit before you read the database.
- **`GuardedProjectBackLink`** — warns the user before they navigate away with unsaved work.

---

## Goal

After this part:
- Chatting with the AI updates the workbench file list without erasing unsaved edits.
- Files touched by the AI show an "Updated" badge. Files you just saved yourself do not.
- Navigating away with unsaved drafts shows a confirmation prompt.

---

## Prerequisites

Part 7 complete (file tree + editor + REST save).

**Estimated time:** 60–90 minutes (state edge cases).

---

## The race condition

Here is the exact timeline after a chat turn ends:

```
t=0ms    Browser reads last SSE chunk. Stream complete.
t=0ms    Server: readOpenAiChatStream callback fires for last chunk.
t=~5ms   Server: createMessage(assistant) completes.
t=~15ms  Server: applyAssistantFileChangesFromText begins parsing.
t=~20ms  Server: transaction begins (upsert FileEntry rows).
t=0ms    Client: scheduleWorkbenchRefresh() sets a 250 ms timer.

t=250ms  Client: router.refresh() fires.
t=250ms  Server: handles the refresh request, queries FileEntry.
         ⬆ Was the upsert transaction committed yet?
         If yes: fresh data. If no: stale data from before the AI's changes.
```

The 250 ms delay is a heuristic. It is not guaranteed to be long enough on a slow machine or under load. But in practice on local dev it removes the race almost completely. The alternative—making the client wait for an explicit signal from the server that file apply is done—requires WebSockets or polling, which is out of scope for this series.

A second chat turn also triggers another refresh. If the first refresh was too early, the second one will catch up.

```ts
// src/components/project/chat/useProjectChat.ts (excerpt)
const FILES_SYNC_DELAY_MS = 250;

const scheduleWorkbenchRefresh = useCallback(() => {
  if (refreshTimeoutRef.current !== null) {
    clearTimeout(refreshTimeoutRef.current);
  }
  refreshTimeoutRef.current = setTimeout(() => {
    refreshTimeoutRef.current = null;
    router.refresh();
  }, FILES_SYNC_DELAY_MS);
}, [router]);
```

The timeout is **reset** if the user sends another message while it is pending. Only the last message's refresh timer fires—you do not queue multiple simultaneous refreshes.

---

## The draft merge algorithm

When new `workbenchFiles` arrive from the server (after `router.refresh()`), you need to decide for each draft whether to keep it or drop it.

**Rules:**

1. If the path was **deleted** on the server → drop the draft.
2. If the draft **equals** the new server content → drop the draft (it is redundant; the server caught up).
3. If the draft **differs** from the new server content → **keep** the draft and show a notice.

```ts
// src/components/project/workbench/useWorkbenchDrafts.ts (excerpt)
useEffect(() => {
  const pathToContent = Object.fromEntries(
    files.map((f) => [f.path, f.content] as const),
  );
  const previousKey = prevServerSyncKeyRef.current;
  prevServerSyncKeyRef.current = serverSyncKey;

  const prev = draftsRef.current;
  const next: Record<string, string> = {};

  for (const [path, draft] of Object.entries(prev)) {
    if (!(path in pathToContent)) continue;      // rule 1: deleted on server
    const server = pathToContent[path];
    if (draft === server) continue;              // rule 2: now matches server
    next[path] = draft;                          // rule 3: keep diverged draft
  }

  const hadServerSnapshotChange = previousKey !== null && previousKey !== serverSyncKey;
  const keptUnsaved = Object.keys(next).length > 0;

  setDrafts(next);

  if (hadServerSnapshotChange && keptUnsaved) {
    setServerSyncNotice(WORKBENCH_SERVER_SYNC_NOTICE);
  }
}, [serverSyncKey]); // eslint-disable-line react-hooks/exhaustive-deps
```

**`serverSyncKey`** is derived from the full server `workbenchFiles` array—a hash of all `path + content + updatedAt` values. It changes only when the server data actually changes, not on every render. This prevents the merge loop from running on every keystroke.

**The `eslint-disable` comment** is intentional. React's exhaustive-deps lint rule would require you to list `files` and `drafts` as dependencies, which would trigger the merge on every render. You deliberately only re-run when `serverSyncKey` changes—that is the design.

---

## The "Updated" badge problem

After `router.refresh()`, you compare each path's `updatedAt` between the previous server snapshot and the new one. If `updatedAt` increased, you flash "Updated" to indicate an AI change.

**The lie:** your own `PUT /api/projects/[projectId]/file` also increments `updatedAt`. Without special handling, saving a file manually would flash "Updated" as if the AI had changed it.

**The fix:** before calling `router.refresh()` after a save, add the path to a "skip flash" set:

```ts
const skipFlashForPathRef = useRef<Set<string>>(new Set());

async function saveFile(path: string, content: string) {
  skipFlashForPathRef.current.add(path);
  await fetch(`/api/projects/${projectId}/file`, {
    method: "PUT",
    body: JSON.stringify({ path, content }),
  });
  router.refresh(); // this will trigger useRecentlyUpdatedPaths
}
```

In `useRecentlyUpdatedPaths`, when comparing old vs new `updatedAt`, skip paths that are in the set:

```ts
for (const file of newFiles) {
  if (skipFlashForPathRef.current.has(file.path)) {
    skipFlashForPathRef.current.delete(file.path); // consume the skip
    continue;
  }
  const oldFile = oldByPath[file.path];
  if (oldFile && file.updatedAt > oldFile.updatedAt) {
    updated.add(file.path);
  }
}
```

The skip is **consumed** on first use—if the AI subsequently edits the same file, the next refresh will correctly show "Updated."

---

## Unsaved navigation guards

**`beforeunload`** for tab close:

```ts
useEffect(() => {
  const handler = (e: BeforeUnloadEvent) => {
    if (hasDirtyState()) {
      e.preventDefault();
      e.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", handler);
  return () => window.removeEventListener("beforeunload", handler);
}, [hasDirtyState]);
```

**Back to projects link:**

```tsx
function GuardedProjectBackLink() {
  const { isDirty } = useUnsavedChanges();

  const handleClick = (e: React.MouseEvent) => {
    if (isDirty) {
      e.preventDefault();
      if (window.confirm("You have unsaved changes. Leave anyway?")) {
        router.push("/");
      }
    }
  };

  return <a href="/" onClick={handleClick}>← Projects</a>;
}
```

**Known limitation:** the browser **Back** button bypasses your `onClick` handler. Intercepting it requires `history.pushState` manipulation or the experimental Next.js `unstable_usePrompt`. Out of scope for this MVP; document the limitation clearly.

---

## What the user sees

The full experience after a chat turn:

1. User types something, submits. Optimistic user bubble appears.
2. Assistant text streams in token by token.
3. Stream ends. Timer starts (250 ms).
4. At ~250 ms: `router.refresh()`. The workbench reloads.
5. If the AI changed files: "Updated" badge appears next to those paths. If the user had unsaved edits to any of those files: a notice appears ("Server updated files; your unsaved edits are preserved").
6. If the user clicks the file with unsaved edits: their draft is still in the editor.

---

## Check your work

- [ ] Ask the AI to change `src/App.tsx` while you have unsaved edits to `src/index.css`. After the refresh, `src/App.tsx` shows "Updated" and your CSS draft is still in the editor.
- [ ] Save a file manually. Confirm "Updated" does **not** appear for that path.
- [ ] The AI changes `src/App.tsx`. You already have an unsaved draft of `src/App.tsx`. After refresh, a notice appears and your draft is preserved.
- [ ] Navigate away with unsaved changes: the Back link prompts you.

---

## Troubleshooting

| Problem | What to check |
|---------|---------------|
| Files never refresh after chat | Confirm `scheduleWorkbenchRefresh` runs in both the success path and the abort path of `useProjectChat`. |
| Draft always cleared | Check string equality in the merge rule—normalize newlines on both sides before comparing. |
| "Updated" flashes on your own save | `skipFlashForPathRef.current.add(path)` must run **before** `router.refresh()`, not after. |
| Race still visible | Increase `FILES_SYNC_DELAY_MS` temporarily to confirm the timing is the issue. |

---

## What comes next

[Part 9](https://github.com/minhmannh2001/minhmannh2001.github.io/blob/master/_posts/2026-04-17-build-your-own-app-builder-part-9-chat-ui-and-ai-context-en.markdown) improves the chat rendering: assistant replies contain code blocks that are still being written while the stream is live. You need a parser that understands "open fence" and a component that renders a streaming state until the fence closes.

---

*Next: [Part 9 — Rendering code that is still being written and the context strip](https://github.com/minhmannh2001/minhmannh2001.github.io/blob/master/_posts/2026-04-17-build-your-own-app-builder-part-9-chat-ui-and-ai-context-en.markdown).*
