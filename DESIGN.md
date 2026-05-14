# Gitleaf — Design Plan

A Chrome extension that synchronizes files between an Overleaf project and a GitHub repository (or a subfolder inside one).

---

## 1. Executive Summary

Gitleaf is a Manifest V3 Chrome extension that lets a user pair any open Overleaf project with a GitHub repository — or a specific subfolder inside a repository — and keep the two locations in sync. The extension runs entirely in the user's browser: it pulls files out of Overleaf using the same project endpoints the Overleaf web UI uses, talks to GitHub via the official REST API over OAuth, and reconciles changes on either side using a content-hash–based three-way merge.

The motivating use case: free-tier Overleaf users cannot use Overleaf's built-in Git bridge (a Premium feature), and even Premium users cannot map an Overleaf project to a *subfolder* of a GitHub repository — Overleaf's Git bridge always treats the project as a whole repo. Gitleaf fills both gaps.

---

## 2. Goals and Non-Goals

### Goals

The extension should let a user (1) link an Overleaf project to a GitHub repo or subfolder with a single OAuth flow, (2) perform a manual or automatic sync in either direction, (3) detect and surface conflicts rather than silently overwriting, (4) work on free-tier Overleaf accounts, (5) preserve binary assets (images, PDFs, .bib files) byte-for-byte, and (6) keep all credentials in the browser — no Gitleaf server.

### Non-Goals

The first version will not (1) edit `.tex` content inline in the GitHub UI, (2) merge concurrent edits to the same line of the same file (we surface a conflict instead), (3) sync Overleaf-specific metadata like cursor positions, chat, or review comments, (4) sync project history / labels, or (5) support self-hosted Overleaf CE / Sharelatex installations in v1 (the project URL shape is similar but auth differs and warrants its own pass).

---

## 3. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Chrome Browser                         │
│                                                              │
│  ┌────────────────┐    ┌────────────────┐   ┌────────────┐  │
│  │ Content Script │    │ Service Worker │   │  Popup UI  │  │
│  │  (overleaf.com)│◀──▶│  (background)  │◀──│ + Options  │  │
│  └────────────────┘    └────────────────┘   └────────────┘  │
│         │                       │                            │
│         │                       │                            │
│         ▼                       ▼                            │
│  Overleaf project        chrome.storage                      │
│  DOM + WS + REST         (sync + local)                      │
│                                                              │
└────────┼───────────────────────┼─────────────────────────────┘
         │                       │
         ▼                       ▼
   www.overleaf.com         api.github.com
   (session cookie)         (OAuth Bearer token)
```

The **content script** runs on `https://www.overleaf.com/project/*`. It extracts the project ID, calls the same internal endpoints the Overleaf editor uses to list files and fetch contents, and forwards results to the service worker via `chrome.runtime.sendMessage`.

The **service worker** is the orchestrator. It owns the sync state machine, the GitHub HTTP client, the conflict resolver, and the cached sync manifest. It runs on demand (Manifest V3 — no persistent background page).

The **popup UI** is the per-project control panel: shows the link status, lets the user trigger Pull / Push / Sync, and surfaces conflicts.

The **options page** is the global settings panel: GitHub authentication, default branch, ignored-file patterns, autosync interval.

---

## 4. Authentication

### 4.1 Overleaf

Free Overleaf accounts have no public API key. We rely on the user's existing browser session: the content script runs on the Overleaf origin and so its `fetch()` calls automatically carry the session cookie. No Overleaf credentials are ever entered into Gitleaf. If the session expires, Overleaf returns 401 and Gitleaf prompts the user to refresh the tab.

### 4.2 GitHub

**Primary flow: OAuth App + PKCE + `chrome.identity.launchWebAuthFlow`.** We register a GitHub OAuth App with the redirect URI `https://<extension-id>.chromiumapp.org/oauth` (Chrome's virtual redirect host, visible only to the extension that owns that ID). On "Connect GitHub", the service worker generates a PKCE `code_verifier` and its SHA-256 `code_challenge`, then calls `chrome.identity.launchWebAuthFlow` to open a popup at `https://github.com/login/oauth/authorize?client_id=...&redirect_uri=...&scope=repo+read:user&code_challenge=...&code_challenge_method=S256`. After the user authorizes, GitHub redirects to the virtual URL with `?code=...`, Chrome hands the URL back to the extension, and the service worker POSTs to `https://github.com/login/oauth/access_token` with the `code` and the original `code_verifier` — no client secret needed. The resulting token is stored in `chrome.storage.local` (encrypted at rest by Chrome on most platforms) and never leaves the user's machine.

**Fallback if PKCE doesn't work as expected.** GitHub's PKCE support for OAuth Apps is recent. The first week of Phase 1 includes a one-day spike to confirm a registered OAuth App can complete the PKCE flow end-to-end against a real account. If anything blocks it, we switch to **Device Flow** as a drop-in alternative — same `GitHubAuth` interface, no other code changes — and accept the "paste an 8-character code at github.com/login/device" UX. Either way, the rest of the design is unaffected.

**Power-user path: fine-grained PAT.** The options page also accepts a pasted Personal Access Token for users who want per-repository least-privilege scoping or who have reasons not to authorize an OAuth App in their org. The token is validated against `GET /user` on save and stored in the same `chrome.storage.local` slot.

**Scopes requested:** `repo` (read/write to private repos) and `read:user`. The consent screen will state plainly that Gitleaf needs `repo` because syncing requires write access to your chosen repository.

---

## 5. Sync Model

### 5.1 The Sync Manifest

For each linked project we maintain a small JSON document in `chrome.storage.local`:

```json
{
  "overleafProjectId": "65f1a...",
  "github": { "owner": "alice", "repo": "thesis", "branch": "main", "subPath": "paper/" },
  "lastSync": "2026-05-11T09:14:22Z",
  "files": {
    "main.tex":       { "ovHash": "sha1:abc", "ghHash": "sha1:abc", "ghSha": "ghblob:..." },
    "figures/fig1.pdf": { "ovHash": "sha1:def", "ghHash": "sha1:def", "ghSha": "ghblob:..." }
  }
}
```

`ovHash` is the SHA-1 of the file contents as they last appeared on Overleaf; `ghHash` is the SHA-1 of the contents as they last appeared on GitHub; `ghSha` is GitHub's blob SHA (needed for the `PUT /contents` API to avoid clobbering remote changes). On a clean sync, `ovHash == ghHash` for every file.

### 5.2 Three-Way Diff

On each sync run, for every file we compute the current `ovHash` and `ghHash` and compare to the manifest:

| Overleaf changed? | GitHub changed? | Action |
|---|---|---|
| No | No | Skip |
| Yes | No | Push Overleaf → GitHub |
| No | Yes | Pull GitHub → Overleaf |
| Yes | Yes, same content | Update manifest only |
| Yes | Yes, different content | **Conflict** — surface to user |

File additions and deletions are handled by treating "absent" as a distinguishable state. A file present on one side and absent on the manifest is a new file. A file present in the manifest but absent on one side is a deletion — and a deletion on one side combined with a modification on the other is a conflict.

### 5.3 Conflict Resolution UI

When a conflict is detected the sync halts and the popup shows the conflicting files with three buttons each: *Keep Overleaf*, *Keep GitHub*, *Open side-by-side diff*. The diff view is a separate extension page that uses a CodeMirror merge view for text files; for binary files we only offer the two "Keep" options. There is no auto-merge in v1.

### 5.4 Sync Direction Modes

The popup exposes three explicit actions:

- **Push** — Overleaf is the source of truth; overwrite GitHub.
- **Pull** — GitHub is the source of truth; overwrite Overleaf.
- **Sync** — Bidirectional with the three-way diff above.

**New links default to Sync.** A per-link setting can lock the project into one-way mode (e.g. "this Overleaf project is a read-only mirror of GitHub"). Because Sync is the default, the conflict-resolution UI (§5.3) is critical-path for v1 — it must ship in the first public release, not be deferred to a later phase.

### 5.5 Autosync

Optional. When enabled, the service worker runs Sync every N minutes (default 10) while at least one Overleaf tab is open. Implemented with `chrome.alarms`. Autosync is suppressed while a conflict is unresolved.

---

## 6. Overleaf File Access

Overleaf's editor talks to its server over a combination of REST and Socket.IO. We use only the REST endpoints, which are stable enough for our purposes:

- `GET /project/:id` — returns the project page HTML, which embeds a CSRF token we'll need for writes.
- `GET /project/:id/download/zip` — returns the entire project as a zip. This is our primary **read path**: one HTTP call, atomically captures the project at a point in time, gives us file paths and bytes directly. We unzip in the service worker (using `fflate`, ~8 KB minified).
- `POST /project/:id/file` (multipart) — upload a new file.
- `POST /project/:id/doc` (JSON) — create a new text document.
- `DELETE /project/:id/file/:fileId` and `/doc/:docId` — delete.
- `POST /project/:id/doc/:docId` with new contents — update an existing text document.

The **write path** is more involved because Overleaf distinguishes "docs" (text, live-collaborative) from "files" (binary, immutable blobs). Updating a `.tex` file means PATCHing its doc; updating a `.png` means deleting the old file entity and uploading a new one. The content script fetches the project's file tree (via the same JSON the editor loads) to map paths to doc IDs / file IDs.

Because these endpoints are not officially documented, we isolate them behind an `OverleafClient` interface so that if Overleaf changes them we have one place to update. We will also gate every write behind a confirmation in v1 until the endpoints are battle-tested.

---

## 7. GitHub File Access

All GitHub operations go through the official REST API v3 at `api.github.com`. GitHub is the only supported remote host in v1. To keep that decision cheap to revisit later, all GitHub-specific code lives behind a `RemoteClient` interface — `listTree`, `readBlob`, `commitTree`, `advanceBranch` — so adding GitLab or Bitbucket is a new implementation, not a rewrite of the sync engine.

For reads we use `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1` to get the full tree in one call, then `GET /repos/{owner}/{repo}/git/blobs/{sha}` for any file whose hash changed.

For writes we batch into a single commit using the Git Data API: `POST /git/blobs` for each changed file, `POST /git/trees` to assemble the new tree (reusing unchanged subtrees), `POST /git/commits` referencing the parent commit, then `PATCH /git/refs/heads/{branch}` to advance the branch. This is more code than `PUT /contents` per file but it (a) produces one clean commit per sync rather than N, and (b) atomically advances the branch so we never leave the repo half-updated.

Commit messages follow the pattern `Sync from Overleaf — 2026-05-11 09:14 UTC` and include a trailer `Gitleaf-Project-Id: <overleaf-id>` for traceability.

**Branch policy.** Each sync commits directly to the link's configured branch (default: the repo's default branch). We do not create side branches or open PRs in v1. If the branch is protected and the push is rejected, we surface the error verbatim and suggest the user either unprotect the branch, point Gitleaf at a different branch, or wait for a future "PR mode" (tracked as a v2 item in §13).

### Subfolder Mapping

If the link specifies a `subPath` like `paper/`, every Overleaf path is prefixed with `paper/` when written to GitHub, and the inverse strip happens on pull. Files outside `paper/` in the GitHub repo are left untouched on every sync — this is the key feature Overleaf's native Git bridge does not offer.

---

## 8. Chrome Extension Surface

### 8.1 Manifest

Manifest V3, minimum Chrome 116. Permissions: `storage`, `alarms`, `activeTab`, `scripting`, `identity` (for `chrome.identity.launchWebAuthFlow` during the OAuth handshake). Host permissions: `https://www.overleaf.com/*` and `https://api.github.com/*`. No `<all_urls>`, no `tabs`.

### 8.2 Files and Layout

```
src/
  background/
    service-worker.ts       # entry, message router, alarm handler
    sync-engine.ts          # three-way diff, conflict detection
    overleaf-client.ts      # REST wrapper for Overleaf endpoints
    github-client.ts        # REST wrapper for GitHub Git Data API
    storage.ts              # typed wrapper over chrome.storage
  content/
    overleaf-content.ts     # CSRF + project metadata extraction
  ui/
    popup/                  # per-project control panel (React)
    options/                # global settings (React)
    diff/                   # CodeMirror merge view page
  shared/
    types.ts                # SyncManifest, LinkConfig, etc.
    hash.ts                 # SHA-1 helper (subtle.crypto)
manifest.json
```

### 8.3 Storage Layout

`chrome.storage.sync` for non-sensitive settings (default branch, autosync interval, ignored-file patterns) — synced across the user's Chromes.
`chrome.storage.local` for the GitHub OAuth token, the sync manifests, and the per-link configuration — stays on this device.

---

## 9. UI / UX

### Popup (when on an Overleaf project tab)

```
┌────────────────────────────────────────┐
│  thesis-2026                           │
│  ↔ alice/thesis · main · paper/        │
│                                        │
│  Last sync: 4 min ago — clean          │
│                                        │
│  [ Push ]  [ Pull ]  [ Sync ]          │
│                                        │
│  ☐ Auto-sync every 10 min              │
│                                        │
│  ⚙ Unlink · Settings                   │
└────────────────────────────────────────┘
```

### Popup (when on an unlinked Overleaf project)

A single "Link to GitHub…" CTA that opens a wizard: choose repo from a searchable list of the user's repos, choose a branch, optionally type a subfolder, choose direction mode.

### Conflict state

Replaces the action row with a yellow banner: "3 files conflict. Resolve to continue." Below, each file is listed with `Keep Overleaf`, `Keep GitHub`, `Diff` buttons.

### Options page

Sections: GitHub account (connect / disconnect / show scopes), Defaults (default branch, default direction, autosync interval), Ignore patterns (gitignore-style, default ignores `*.aux *.log *.synctex.gz .vscode/`), Advanced (clear all manifests, export logs).

---

## 10. Security and Privacy

The GitHub OAuth token is the most sensitive artifact. It is stored in `chrome.storage.local`, never sent to any server other than `api.github.com`, never logged, never included in error reports, and is wiped when the user disconnects. The CSRF token harvested from Overleaf lives only in service-worker memory for the duration of a sync.

The content script never sees the GitHub token; the service worker mediates. The popup and options page communicate with the service worker through typed `runtime.sendMessage` channels — no `eval`, no string-based command dispatch.

We declare a strict CSP in `manifest.json` (`script-src 'self'`). All third-party libraries are vendored and tree-shaken — no CDN loads at runtime.

Privacy: Gitleaf does not phone home. No analytics. No error reporting unless the user explicitly opts in via the options page (and even then it ships only file counts and error codes, no contents).

---

## 11. Edge Cases and How We Handle Them

Large binary files (>10 MB) exceed GitHub's contents API but fit the Git Data API; we always use the Git Data API path, so this works up to GitHub's 100 MB per-blob limit. Files over that are skipped with a warning.

Renames: in v1 a rename is treated as a delete + add. This is lossy in Git history but correct in content. v2 can add similarity-based rename detection.

Concurrent edits to the same file during a sync: we snapshot Overleaf via the zip download, so changes that land during the GitHub round-trip will simply be picked up on the next sync. The `ghSha` check prevents us from clobbering a concurrent GitHub commit — if the branch has advanced since we read it, we abort and report a conflict.

Project deleted or archived on Overleaf: the project page returns 404; we surface a "Project not found — unlink?" prompt.

User logs out of Overleaf: 401 from the project zip endpoint; popup shows "Please log in to Overleaf and reopen this tab."

Multiple Overleaf tabs open for the same project: the service worker debounces autosync per project ID so we never run two syncs concurrently for the same link.

`.gitignore`-style ignores apply in both directions. A file that matches an ignore pattern is treated as if it didn't exist on either side.

---

## 12. Build, Test, Distribution

Build with Vite + `@crxjs/vite-plugin` — gives us HMR for the popup/options during development and a clean production zip. TypeScript throughout. Lint with ESLint, format with Prettier.

Unit tests with Vitest cover the sync engine's three-way diff logic exhaustively (every combination of present/absent/changed across the manifest, Overleaf side, and GitHub side). Integration tests use `msw` to stub both Overleaf and GitHub endpoints. End-to-end tests with Playwright drive a real Chrome with the extension loaded against `mockoon`-served fixtures.

Distribution: Chrome Web Store, unlisted during beta, listed at v1.0. We also publish the `.zip` to GitHub Releases for users who want to side-load.

---

## 13. Phased Roadmap

Because Sync is the default direction for new links (§5.4) and both free and paid Overleaf users are first-class targets (§2), the conflict UI and the Overleaf write-side client can't be deferred to a "polish" phase — they're load-bearing for v1.

**Phase 1 — Skeleton + one-way Push.** Extension scaffold, GitHub Device Flow OAuth, content-script project ID extraction, Overleaf zip-download read path, GitHub Git Data API commit path, popup with a working "Push" button. No subfolder yet, no Pull, no Sync. Proves the spine works end-to-end. ~2 weeks.

**Phase 2 — Pull + Overleaf write-side client.** Implement the write path against Overleaf (doc updates, file upload/delete, CSRF handling). Add manual Pull. Add subfolder mapping in both directions. ~2 weeks.

**Phase 3 — Bidirectional Sync + conflict UI.** Three-way diff in the sync engine, conflict surfacing in the popup, CodeMirror merge view in a dedicated diff page. **This phase gates v1 launch** — it cannot slip past it. ~3 weeks.

**Phase 4 — Autosync + options + ship.** `chrome.alarms`-driven autosync, ignore patterns, options page, Chrome Web Store listing. v1.0 ships at the end of this phase. ~1 week.

**Phase 5+ — Post-launch.** Rename detection, PR-mode branch handling (for users with protected branches), Sharelatex CE support, optional GitLab support via the `RemoteClient` interface. Driven by user feedback.

---

## 14. Decisions Locked In

The following choices were confirmed before coding and are reflected in the sections above:

| Question | Decision |
|---|---|
| Primary user | **Both free-tier and paid Overleaf users** are first-class targets. The Overleaf write-side client must work without Premium's Git bridge. |
| Default sync direction | **Bidirectional Sync.** Conflict UI is therefore critical-path for v1, not deferred. |
| Branch handling | **Commit directly to the configured branch.** PR-mode is a v2+ item for users with protected branches. |
| Multi-host scope | **GitHub only in v1.** GitLab/Bitbucket deferred behind the `RemoteClient` interface. |
| GitHub auth | **OAuth App + PKCE + `chrome.identity.launchWebAuthFlow`.** Fine-grained PAT supported as a power-user alternative. Device Flow held in reserve as a fallback if the PKCE spike in week 1 of Phase 1 reveals a blocker. |

---

*End of design plan — ready for Phase 1 implementation.*
