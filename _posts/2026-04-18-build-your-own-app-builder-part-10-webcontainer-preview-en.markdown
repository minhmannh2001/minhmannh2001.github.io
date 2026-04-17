---
layout: post
title: 'Build your own X: A minimal AI app builder — Part 10: WebContainer — running a Vite dev server in the browser tab'
date: '2026-04-18 12:00'
excerpt: >-
  WebContainer boots a full Node.js environment in the browser using WebAssembly and SharedArrayBuffer. SharedArrayBuffer requires cross-origin isolation—but you cannot apply that globally without breaking third-party scripts. This part scopes the isolation headers to /project/* only, boots one WebContainer per tab, converts FileEntry rows into a nested mount tree, and runs the full npm install → npm run dev → iframe pipeline.
comments: false
---

## What's in this post?

WebContainer is the most unusual piece of this stack. It runs a real Node.js process—with npm, Vite, file system, network—entirely inside the browser tab, using WebAssembly. No server-side sandboxing. No Docker. No ephemeral cloud VMs.

Making it work in a Next.js app requires solving three problems that are not obvious until you try:

- **Cross-origin isolation** — WebContainer requires `SharedArrayBuffer`, which requires `COOP + COEP` headers. You cannot set those globally without breaking scripts from third-party domains.
- **Boot deduplication** — `WebContainer.boot()` is expensive and must run only once per tab. Two clicks before boot completes should await the same promise, not start two separate boots.
- **Database rows → file tree** — WebContainer's `mount()` expects a nested tree structure. You have flat `{ path, content }` rows. The conversion must handle nested directories.

---

## Goal

You want a **Preview** tab in the workspace that:
1. Boots a WebContainer when the user clicks Deploy.
2. Mounts all `FileEntry` rows.
3. Runs `npm install` and `npm run dev`.
4. Shows the running app in an `<iframe>`.
5. Optionally redeploys when files change.

---

## Prerequisites

Parts 1–9 complete. You have a working chat + workbench + the template Vite app in the database.

**Estimated time:** 90–120 minutes (first-time WebContainer debugging can take longer).

---

## Problem 1: Cross-origin isolation without breaking the home page

**Why it is required:**

`SharedArrayBuffer` was disabled in all browsers after the Spectre vulnerability class was discovered in 2018. It was re-enabled for pages that opt into **cross-origin isolation** by setting:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

What `SharedArrayBuffer` is in practical terms: a shared memory region that multiple JavaScript execution contexts (main thread + workers) can read/write without copying. That zero-copy sharing is one reason runtimes like WebContainer can feel fast enough to run a full Node.js toolchain in-browser. The security trade-off is that shared memory increases exposure to high-resolution side-channel attacks, so browsers require isolation before exposing it.

In this app, the dependency chain is:

1. WebContainer internals depend on browser features gated behind cross-origin isolation.
2. Cross-origin isolation requires the COOP/COEP pair on the document response.
3. Therefore `window.crossOriginIsolated` must be `true` before deploy.

A cross-origin isolated page cannot load third-party scripts, images, or iframes that do not opt in with compatible CORS/CORP headers. If you apply these headers globally in Next.js, analytics scripts, embedded fonts, or external images can break.

**The solution: scope to `/project/*` only**

```ts
// next.config.ts
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/project/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};
```

This `headers()` function in `simple-app-builder/next.config.ts` is the code path that actually sets both headers at runtime. Next.js evaluates it on startup and attaches the header pair to responses whose pathname matches `source: "/project/:path*"`.

The home page `/` stays unrestricted. The workspace pages `/project/…` become cross-origin isolated. Verify in the browser console:

```js
// On /project/…:
window.crossOriginIsolated // → true

// On /:
window.crossOriginIsolated // → false
```

**Concrete example in this project:**

For `GET /project/cmabc123`, the response includes:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

So in that tab:

```js
window.crossOriginIsolated // true
typeof SharedArrayBuffer    // "function"
```

For `GET /` (home page), those headers are absent, so:

```js
window.crossOriginIsolated // false
```

This is exactly what you want: workspace routes can boot WebContainer; the home page remains unrestricted for third-party assets.

One practical side effect on `/project/...`: if you load a cross-origin asset that does not opt in with CORS/CORP, the browser blocks it under `COEP: require-corp`. Example:

```html
<script src="https://example-cdn.com/widget.js"></script>
```

If that CDN does not send compatible headers, the script fails to load on workspace routes. Scoping COEP to `/project/*` prevents that breakage from spilling onto `/`.

How this is used in WebContainer flow inside this project:

- In `src/components/project/preview/useWebContainerDeploy.ts`, `deploy()` first checks `window.crossOriginIsolated`.
- If it is `false`, it throws a user-facing error immediately and never calls `getOrBootWebContainer()`.
- If it is `true`, deploy continues to `WebContainer.boot()` and the mount/install/dev pipeline.

That early guard is intentional. It turns a browser security precondition into a clear product error ("open this page via the project workspace URL") instead of a later low-level boot failure.

**Feature flag:**

Gate the Deploy button behind `NEXT_PUBLIC_PREVIEW_DEPLOY_ENABLED=true`. This lets users start the tutorial without dealing with WebContainer requirements until they choose to enable it. Public env vars require a dev server restart to take effect.

---

## Problem 2: Boot exactly once per tab

`WebContainer.boot()` is expensive: it downloads and initializes a WebAssembly Node.js runtime. Calling it twice in the same tab is undefined behavior. Awaiting two concurrent boots may throw.

```ts
// src/lib/preview/getWebContainer.ts
let instance: WebContainer | null = null;
let bootPromise: Promise<WebContainer> | null = null;

export async function getOrBootWebContainer(): Promise<WebContainer> {
  if (instance) return instance;

  if (!bootPromise) {
    bootPromise = (async () => {
      const { WebContainer } = await import("@webcontainer/api");
      const wc = await WebContainer.boot();
      instance = wc;
      return wc;
    })();
  }

  try {
    return await bootPromise;
  } catch (e) {
    // Boot failed — reset so the user can retry
    bootPromise = null;
    instance = null;
    throw e;
  }
}
```

**Why `bootPromise` and `instance` are separate:**

- `instance` handles the common case: boot already succeeded, return immediately.
- `bootPromise` handles the race: boot is in progress. Two concurrent calls to `getOrBootWebContainer()` both `await bootPromise`—they dedup into one boot operation.
- If boot throws, both `null` resets let the user retry without refreshing the page.

**`import("@webcontainer/api")` stays dynamic:** this keeps WebContainer out of the SSR bundle entirely. The Next.js server never loads it.

---

## Problem 3: Flat rows → nested file tree

WebContainer's `mount()` expects a `FileSystemTree`:

```ts
{
  "src": {
    directory: {
      "App.tsx": { file: { contents: "..." } },
      "main.tsx": { file: { contents: "..." } },
    },
  },
  "package.json": { file: { contents: "..." } },
}
```

Your `FileEntry` rows are flat: `{ path: "src/App.tsx", content: "..." }`.

```ts
// src/lib/preview/fileSystemTreeFromProjectFiles.ts
export function fileSystemTreeFromProjectFiles(
  files: Array<{ path: string; content: string }>,
): FileSystemTree {
  const root: FileSystemTree = {};

  for (const { path: rawPath, content } of files) {
    const path = rawPath.replace(/^\/+/, "").replace(/\\/g, "/");
    if (!path || path.includes("..")) continue; // defence in depth

    const segments = path.split("/").filter(Boolean);
    let current: FileSystemTree = root;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const isLast = i === segments.length - 1;

      if (isLast) {
        current[seg] = { file: { contents: content } };
      } else {
        if (!current[seg]) {
          current[seg] = { directory: {} };
        }
        const node = current[seg] as { directory: FileSystemTree };
        current = node.directory;
      }
    }
  }

  return root;
}
```

The `path.includes("..")` check is defence in depth—`normalizeProjectPath` already rejected traversal paths before they reached the database, but you do not assume the DB is clean.

A collision between a file and a directory at the same path (for example, a row for `src` as a file and another for `src/App.tsx`) would silently overwrite the directory node. In practice this cannot happen with paths produced by `normalizeProjectPath`, but you could add an explicit check if you want strictness.

---

## The pipeline

```ts
// src/lib/preview/webContainerPreviewPipeline.ts (excerpt)
export async function runWebContainerPreviewPipeline(
  wc: WebContainer,
  files: ProjectFileEntry[],
  onLog: (chunk: string) => void,
): Promise<{ previewUrl: string }> {
  killActivePreviewDevProcess(); // terminate previous Vite if any

  const tree = fileSystemTreeFromProjectFiles(files);
  await wc.mount(tree);
  onLog(`[preview] Mounted ${files.length} file(s).\n`);

  // Detect package manager
  const hasLockfile = files.some((f) => f.path === "pnpm-lock.yaml");
  const installCmd = hasLockfile ? ["pnpm", "install"] : ["npm", "install"];

  const install = await wc.spawn(installCmd[0]!, installCmd.slice(1));
  install.output.pipeTo(new WritableStream({ write: (chunk) => onLog(chunk) }));

  const installExit = await install.exit;
  if (installExit !== 0) throw new Error(`Install failed with exit code ${installExit}`);

  const dev = await wc.spawn("npm", ["run", "dev"]);
  dev.output.pipeTo(new WritableStream({ write: (chunk) => onLog(sanitizeAnsi(chunk)) }));

  // WebContainer fires 'server-ready' when Vite's dev server is up
  const previewUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("server-ready timeout")),
      60_000,
    );
    wc.on("server-ready", (port, url) => {
      clearTimeout(timeout);
      resolve(url);
    });
  });

  return { previewUrl };
}
```

**`killActivePreviewDevProcess()`** — stored in a module-level variable, this kills the previous `npm run dev` process before starting a new one. Without it, every Redeploy leaves a zombie Vite process holding a port. WebContainer has a limited number of ports.

**`sanitizeAnsi(chunk)`** — npm outputs ANSI escape codes for spinner animations and colors that look like garbage in a plain text log. Sanitize on the **accumulated string**, not chunk by chunk—escape sequences can split across chunk boundaries.

**`server-ready`** — WebContainer fires this event when a process starts listening on a port. You do not poll for it; you subscribe once. Set a 60-second timeout to prevent the UI from hanging indefinitely if Vite never starts.

---

## Redeploy

The user might:
- Make workbench edits and click Redeploy manually.
- Enable auto-redeploy, which watches a signature of the current workbench files.

**File signature:**

```ts
function workbenchFilesSignature(files: ProjectFileEntry[]): string {
  return files
    .map((f) => `${f.path}:${f.updatedAt}:${f.content.length}`)
    .sort()
    .join("|");
}
```

Compare this string before and after each workbench refresh. If it changes and a deploy has completed, either prompt the user ("Files changed, redeploy?") or auto-redeploy after a debounce (750 ms to avoid thrashing during rapid saves).

Each redeploy is a **full pipeline** restart: mount all files again, reinstall, restart Vite. This is simple but slow. Incremental remounting (updating only changed files and relying on Vite's HMR) is a future optimization that would require diffing the tree.

---

## Keeping preview mounted between tab switches

If the user switches from Preview to Files and back, you do not want to kill the WebContainer and reboot it. Use a `previewEverOpened` flag:

```tsx
const [activeTab, setActiveTab] = useState<"files" | "preview">("files");
const [previewEverOpened, setPreviewEverOpened] = useState(false);

function handleTabChange(tab: "files" | "preview") {
  if (tab === "preview") setPreviewEverOpened(true);
  setActiveTab(tab);
}

return (
  <>
    <FilesPanel hidden={activeTab !== "files"} />
    {previewEverOpened && (
      <PreviewPanel hidden={activeTab !== "preview"} />
    )}
  </>
);
```

The `hidden` prop applies `display: none` CSS—the component stays mounted but invisible. The WebContainer and iframe remain live. Switching back to Preview is instant.

---

## Check your work

- [ ] With the feature flag on, clicking Deploy shows install logs in the terminal panel, then Vite starts, and the iframe loads the Vite app.
- [ ] `window.crossOriginIsolated` is `true` on `/project/…` and `false` on `/`.
- [ ] Clicking Redeploy after a manual file save shows the updated code in the iframe.
- [ ] Switching from Preview to Files and back does not reboot the container.
- [ ] (Optional) Enabling auto-redeploy and saving a file triggers a new deploy after ~750 ms.

---

## Troubleshooting

| Problem | What to check |
|---------|---------------|
| `boot()` throws on `crossOriginIsolated` | Check headers in Network tab; confirm `source: "/project/:path*"` in `next.config.ts`. |
| Install fails | Read the terminal log; verify `package.json` in the DB is valid JSON with correct dependency versions. |
| Preview stuck at "Installing…" | `server-ready` never fired; read WebContainer logs for Vite startup errors; increase timeout. |
| COEP breaks an asset (CDN font, external image) | Scope COEP to `/project/*`, not globally. Assets on the home page do not need CORP. |
| Zombie Vite processes | Confirm `killActivePreviewDevProcess()` runs at the start of each pipeline call. |

---

## What you might add next

The series ends here at MVP. If you want to keep building:

- **Incremental file sync** — diff old and new file trees, update only changed files in WebContainer, let Vite's HMR pick up the changes without a full reinstall.
- **Export zip** — query `FileEntry` rows, pack with JSZip, add a README with "how to run locally" instructions.
- **New file button** — a small input in the workbench that calls `PUT /api/projects/[id]/file` with empty content.
- **Auth and rate limiting** — needed before you expose this to other users.

---

## Series wrap-up

We are at a strange moment. AI coding tools are everywhere—Cursor, Bolt, v0, Lovable—and most people use them daily without a clear picture of what is actually happening when they type a prompt and watch code appear. The tools feel almost magical, and that magic is comfortable enough that most people stop asking how it works.

I built this series because I was in that group. I was curious. I wanted to open the hood and look at the engine, not just ride in the car.

What I found is that there is no magic. There is a system prompt that doubles as a grammar spec. There is a line scanner that reads that grammar back out of the model's reply. There is a character budget that decides which files make it into context and which get cut. There is a 250 ms timer that tries to win a race against a background database transaction. There is a header on a single route that unlocks SharedArrayBuffer in that tab only.

Each piece is small. Each piece is understandable. Together they add up to something that feels like it should not work—you type in a browser, a language model edits source files, a Vite dev server boots inside the same tab—but it does work, because the pieces fit together deliberately.

If you built along with this series, you now have that mental model. The next time you use Cursor or Bolt, you have a reasonable guess at what is happening on each side of the request. And if something breaks—the model stops following the file format, the workbench shows stale data, the preview never loads—you have the vocabulary to diagnose it.

That is what building your own version of something gives you that using it never quite does.

---

*Series start: [Part 1](https://github.com/minhmannh2001/minhmannh2001.github.io/blob/master/_posts/2026-04-09-build-your-own-app-builder-part-1-intro-en.markdown) · Previous: [Part 9](https://github.com/minhmannh2001/minhmannh2001.github.io/blob/master/_posts/2026-04-17-build-your-own-app-builder-part-9-chat-ui-and-ai-context-en.markdown).*
