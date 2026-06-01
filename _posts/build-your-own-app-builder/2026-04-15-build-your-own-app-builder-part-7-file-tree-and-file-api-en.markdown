---
layout: post
title: 'Build your own X: A minimal AI app builder — Part 7: File tree UI, REST API with shared validation, and CodeMirror without SSR'
date: '2026-04-15 12:00'
excerpt: >-
  The workbench needs three things: a file tree loaded from the database, a REST API to save/delete/rename with the same path rules as the parser, and a CodeMirror editor that cannot load during server-side rendering. Each reveals a different facet of building a database-backed IDE panel in Next.js.
comments: false
---

## What's in this post?

The workbench is where the user reads and edits files while the AI works. Building it correctly requires three independent decisions:

- **Server Component loading** — load `FileEntry` rows as a prop, not via a client-side fetch, so the page is ready on first render.
- **REST API design** — PUT/DELETE/PATCH that share `normalizeProjectPath` with the parser so the same validation rules apply to both humans and the model.
- **CodeMirror and SSR** — CodeMirror needs DOM APIs; `next/dynamic` with `ssr: false` keeps it out of the server bundle entirely.

---

## Goal

After Part 6, the database has accurate file state but the UI shows a placeholder. After this part:
- Opening a project shows the full file tree.
- Clicking a file loads its content into a syntax-highlighted editor.
- Save, delete, and rename work via REST.

---

## Prerequisites

Parts 1–6 complete.

**Estimated time:** about 90 minutes.

---

## Quick Next.js context for this part

Part 7 sits right at the seam between **Server Components**, **Client Components**, and **Route Handlers** in the App Router. If those terms still feel fuzzy, this mental model is enough:

- **Server Component (`app/.../page.tsx`)**: runs on the server, can read Prisma directly, and sends ready data down as props.
- **Client Component (`"use client"`)**: runs in the browser, owns interactions (`useState`, `onClick`, editor typing, context menu open/close).
- **Route Handler (`app/api/.../route.ts`)**: HTTP endpoints for explicit mutations (save/delete/rename) that the client calls with `fetch`.

Why this split matters in a file workbench:

1. **Initial load** should come from the server component, so the first meaningful paint already has the file list.
2. **Interactive edits** belong in client components, because typing and local drafts are browser concerns.
3. **Writes** go through route handlers so both humans and AI pass the same validation and service logic.

So yes, Next.js uses server and client rendering together here, but not as a random mix. The boundary is intentional: **read initial state on the server, mutate through APIs, and keep transient editor UX on the client**.

Here is the exact handoff in this project:

```ts
// src/app/project/[id]/page.tsx (Server Component)
export default async function ProjectPage({ params }: PageProps) {
  const { id } = await params;
  const project = await getProjectById(id);
  if (!project) notFound();

  const [rows, workbenchFiles] = await Promise.all([
    listMessagesByProjectId(project.id),
    listProjectFileEntriesForWorkbench(project.id),
  ]);

  return (
    <ProjectWorkspaceView
      projectId={id}
      initialChatMessages={rows.map(/* ... */)}
      workbenchFiles={workbenchFiles}
    />
  );
}
```

```tsx
// src/components/project/ProjectWorkspaceView.tsx (Client Component)
"use client";

type ProjectWorkspaceViewProps = {
  initialChatMessages?: ChatMessage[];
  workbenchFiles?: ProjectFileEntry[];
};

export function ProjectWorkspaceView({
  initialChatMessages = [],
  workbenchFiles = [],
}: ProjectWorkspaceViewProps) {
  // local UI state, tabs, editor draft, click handlers, etc.
}
```

The server page owns **data fetching and first render data shape**. The client workbench owns **interaction and transient state**. That separation is why you get fast initial load without giving up rich editor UX.

---

## Loading files as a Server Component prop

The project page (`src/app/project/[id]/page.tsx`) already calls `listProjectFileEntriesForWorkbench`. After Part 2 seeded files on creation, this query now returns real rows.

```ts
// src/server/files/listProjectFileEntriesForWorkbench.ts
export async function listProjectFileEntriesForWorkbench(
  projectId: string,
): Promise<ProjectFileEntry[]> {
  const rows = await prisma.fileEntry.findMany({
    where: { projectId },
    select: { path: true, content: true, updatedAt: true },
    orderBy: { path: "asc" },
  });
  return rows.map((r) => ({
    path: r.path,
    content: r.content,
    updatedAt: r.updatedAt.toISOString(),
  }));
}
```

Two decisions:

**`updatedAt` as an ISO string** — `Date` objects cannot cross the Server→Client Component boundary as props (they are not JSON-serializable). Serialize at the boundary; parse on the client only when needed.

**`orderBy: path: "asc"`** — sorts files alphabetically on the server. This avoids sorting in the browser on every render and ensures a consistent order when the model adds files.

---

## File API: shared path validation

All three endpoints share `normalizeProjectPath` from Part 5. This is the key invariant: **any path that the parser accepts is also accepted by the manual API, and vice versa**. There is no second ruleset for human edits.

### `PUT /api/projects/[projectId]/file` — save

```ts
export async function PUT(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  if (!projectId?.trim()) return projectIdErrorResponse();

  const json = await readJsonOr400(request);
  if (!json.ok) return json.response;

  const parsed = parseSaveProjectFileBody(json.raw);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: { code: parsed.error.code, message: parsed.error.message } },
      { status: 400 },
    );
  }

  const result = await saveProjectFileContent({
    projectId,
    path: parsed.body.path,
    content: parsed.body.content,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: { code: result.code, message: result.message } },
      { status: result.status },
    );
  }

  return NextResponse.json({ path: result.path, updatedAt: result.updatedAt });
}
```

The response includes `updatedAt`. Part 8 uses this to distinguish "the server changed this file because of my save" from "the server changed this file because the AI did." Without it, the "Updated" badge would falsely flash for your own saves.

### `DELETE /api/projects/[projectId]/file` — remove

Body: `{ "path": string }`. Returns `404` if the row does not exist—not a silent no-op. You want to know if the client and server disagree about what files exist.

### `PATCH /api/projects/[projectId]/file` — rename

Body: `{ "from": string, "to": string }`. Returns `409 Conflict` if the target path already exists. The client should show a clear message ("A file named X already exists") rather than a generic error.

All three follow the same validation structure: parse body → validate path → execute service function → return structured error. This pattern keeps the HTTP layer thin and makes the service functions testable in isolation.

---

## File tree rendering

A flat list sorted by `path` is enough for MVP. Folders are implied by the `/` in path strings. Render each row as a clickable item that sets the active file in local state.

**Context menu (rename/delete):** render in a portal to `document.body` with `position: fixed`. This prevents the menu from being clipped by a parent with `overflow: hidden`. Use a `mounted` boolean guard so the portal call never runs during server render:

```tsx
const [mounted, setMounted] = useState(false);
useEffect(() => { setMounted(true); }, []);

if (!mounted) return null;
return createPortal(<ContextMenu … />, document.body);
```

---

## CodeMirror without SSR

CodeMirror imports Web APIs (`document`, `window`, `ResizeObserver`) at module load time. If Next.js tries to render a CodeMirror component on the server, it throws.

**The fix: `next/dynamic` with `ssr: false`**

```tsx
// src/components/project/workbench/WorkbenchArea.tsx (excerpt)
const WorkbenchCodeMirror = dynamic(
  () => import("./WorkbenchCodeMirror").then((m) => m.WorkbenchCodeMirror),
  {
    ssr: false,
    loading: () => (
      <div data-testid="workbench-editor-loading">Loading editor…</div>
    ),
  },
);
```

`ssr: false` removes `WorkbenchCodeMirror` from the server bundle entirely. On the client, the chunk downloads asynchronously after hydration. The `loading` fallback shows during that download so the panel is not blank.

**Syntax highlighting by file extension:**

```ts
export function extensionsForPath(path: string): Extension[] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx": return [javascript({ typescript: true, jsx: ext === "tsx" })];
    case "js":
    case "jsx": return [javascript({ jsx: true })];
    case "json": return [json()];
    case "css": return [css()];
    case "html": return [html()];
    default: return [];
  }
}
```

The same `extensionsForPath` function is reused in Part 9's chat code block renderer—syntax highlighting in the workbench and in the chat panel derive from the same source.

---

## Workbench state

The workbench needs to track:
- **`activeFilePath`** — the currently selected file.
- **`draft`** for that path — the editor content, potentially unsaved.

Keep draft state local to the workbench component (or a hook). Do not push it into a global state store—the draft only matters while the file is open, and it should be discarded if the workbench unmounts.

Part 8 introduces the **merge policy**: what happens to the draft when new server data arrives after a chat turn.

---

## Check your work

- [ ] Opening a project shows the seeded files (`package.json`, `src/App.tsx`, …) in the tree.
- [ ] Clicking a file displays its contents with syntax highlighting.
- [ ] Saving edits updates the `content` and `updatedAt` in Prisma Studio.
- [ ] Deleting a file removes the row. Renaming a file changes its `path`.
- [ ] Renaming to an existing path returns `409` with a clear message.

---

## Troubleshooting

| Problem | What to check |
|---------|---------------|
| Hydration mismatch on context menu | Portal and `document` access must be guarded by `mounted === true`. |
| Editor never loads | Confirm `ssr: false` on `dynamic()`; check browser console for chunk errors. |
| `400 INVALID_PATH` on save | Path must pass `normalizeProjectPath`: no `..`, no leading `/`. |
| `updatedAt` arrives as `null` | Check that the service function's `select` includes `updatedAt` and the response maps it. |

---

## What comes next

[Part 8](https://github.com/minhmannh2001/minhmannh2001.github.io/blob/master/_posts/2026-04-16-build-your-own-app-builder-part-8-editor-state-and-sync-en.markdown) tackles the hardest coordination problem in this app: the user is editing a file, the AI finishes updating it simultaneously, and `router.refresh()` is about to wipe both. You need a merge policy that keeps the user's draft, surfaces the AI's changes, and does not lie about which updates came from where.

---

*Next: [Part 8 — The sync problem: drafts, races, and "Updated" badges](https://github.com/minhmannh2001/minhmannh2001.github.io/blob/master/_posts/2026-04-16-build-your-own-app-builder-part-8-editor-state-and-sync-en.markdown).*
