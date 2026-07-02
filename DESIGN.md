# Gitleaf Design Notes

Gitleaf is a Manifest V3 Chrome extension that synchronizes files between an Overleaf project and a GitHub repository, optionally scoped to a subfolder in that repository. It runs entirely in the browser: Overleaf access uses the user's existing Overleaf session, and GitHub access uses a user-provided Personal Access Token.

This document describes the current implementation, not the long-term product plan.

## Current Capabilities

- Manual **Push** from Overleaf to GitHub.
- Manual **Pull** from GitHub to Overleaf.
- Preview dialog before each push or pull, listing added, modified, and deleted paths.
- Repository linking from the popup, including owner, repo, branch, and optional subfolder.
- Repository picker populated from `GET /user/repos`.
- Fine-grained or classic GitHub PAT validation via `GET /user`.
- Ignore patterns applied in both directions.
- Large-file filtering for files over GitHub's 100 MB blob limit.
- Local sync manifests keyed by Overleaf project ID.

Bidirectional automatic sync, conflict resolution UI, OAuth/PKCE, GitHub Device Flow, and alarm-based autosync are not implemented in the current extension.

## Architecture

```
Chrome Extension
  manifest.json
  src/content.ts
  src/content/overleaf-content.ts
  src/background/service-worker.ts
  src/background/overleaf-client.ts
  src/background/github-client.ts
  src/background/sync-engine.ts
  src/background/storage.ts
  src/ui/popup/
  src/ui/options/
  src/shared/
```

### Content Script

The content script runs on `https://www.overleaf.com/project/*`. It extracts:

- Overleaf project ID
- Project name
- CSRF token
- user ID when available
- cached `rootFolder` metadata when available

The popup can also request fresh metadata from the content script before running sync operations. This is especially important for Pull, because Overleaf write endpoints need current CSRF and project-tree information.

### Service Worker

The service worker is the message router and sync orchestrator. It handles:

- `GET_AUTH_STATUS`
- `SET_GITHUB_TOKEN`
- `GET_LINK_STATUS`
- `GET_GITHUB_REPOS`
- `LINK_GITHUB`
- `PREVIEW_PUSH`
- `PUSH`
- `PREVIEW_PULL`
- `PULL`

`SYNC` currently returns an error: bidirectional sync is not available yet.

### Popup

The popup is the primary workflow surface:

1. Open an Overleaf project tab.
2. Save a GitHub PAT if no token is stored.
3. Link the project to a GitHub repository, branch, and optional subfolder.
4. Use **Push** or **Pull**.
5. Review the preview dialog and confirm.

The popup also shows the linked repository, branch, subfolder, last sync time, and a "Change repository" action.

### Options Page

The options page is intended for account, linked-project, and settings management. The canonical storage wrapper is `src/background/storage.ts`; keep option-page storage keys aligned with that wrapper when changing settings behavior.

## Storage

Sensitive and per-device state uses `chrome.storage.local`:

- `github_token`
- `sync_manifests`
- `link_configs`

Synced user settings use `chrome.storage.sync`:

- `default_branch`
- `autosync_interval_minutes`
- `ignore_patterns`

Default ignore patterns are:

- `*.aux`
- `*.log`
- `*.synctex.gz`
- `.vscode/`

## Sync Manifest

Each linked project has one manifest:

```json
{
  "overleafProjectId": "65f1...",
  "github": {
    "owner": "alice",
    "repo": "paper",
    "branch": "main",
    "subPath": "manuscript/"
  },
  "lastSync": "2026-06-26T12:00:00.000Z",
  "files": {
    "main.tex": {
      "ovHash": "sha1...",
      "ghHash": "sha1...",
      "ghSha": "github-blob-sha"
    }
  }
}
```

Paths in the manifest are Overleaf-relative paths. GitHub subfolder mapping is applied at the service-worker boundary.

## Push Flow

1. The popup asks the service worker for a push preview.
2. The service worker downloads the Overleaf project ZIP from `/project/:id/download/zip`.
3. The ZIP is extracted with `fflate`.
4. SHA-1 hashes are computed for each file.
5. Ignore patterns and the 100 MB file limit are applied.
6. `detectPushChanges` compares current Overleaf files with the manifest.
7. The popup shows added, modified, and deleted paths.
8. On confirmation, the service worker creates GitHub blobs, a tree, and a commit with the Git Data API.
9. The target branch ref is advanced with `force: false`.
10. A new manifest is stored.

Push writes one Git commit per confirmed operation. Commit messages include a `Gitleaf-Project-Id` trailer.

## Pull Flow

1. The popup asks the service worker for a pull preview.
2. The service worker fetches the recursive GitHub tree for the linked branch.
3. If a subfolder is configured, only files under that prefix are considered.
4. GitHub blobs are downloaded and SHA-1 hashes are computed.
5. Ignore patterns and the 100 MB file limit are applied.
6. `detectPullChanges` compares current GitHub files with the manifest.
7. On confirmation, the service worker applies the same detected change set to Overleaf.
8. The Overleaf client creates missing folders, uploads files, deletes removed entities, and refreshes project-tree data when cached metadata is stale.
9. A new manifest is stored.

Current pull application treats the GitHub side as the source of truth for the linked scope. It writes the full valid remote file set and applies detected deletions.

## GitHub Access

GitHub requests use the REST API at `https://api.github.com`.

Implemented endpoints include:

- `GET /user`
- `GET /user/repos`
- `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`
- `GET /repos/{owner}/{repo}/git/blobs/{sha}`
- `GET /repos/{owner}/{repo}/git/ref/heads/{branch}`
- `GET /repos/{owner}/{repo}/git/commits/{sha}`
- `POST /repos/{owner}/{repo}/git/blobs`
- `POST /repos/{owner}/{repo}/git/trees`
- `POST /repos/{owner}/{repo}/git/commits`
- `PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}`

The extension stores PATs locally and does not currently run OAuth, PKCE, or Device Flow. `github-client.ts` contains Device Flow scaffolding with a placeholder client ID, but it is not wired into the UI.

## Overleaf Access

Overleaf reads use:

- `GET /project/:id/download/zip`

Overleaf metadata and write support use a mix of internal web-editor endpoints and socket fallbacks, including:

- `POST /project/:id/join`
- `GET /project/:id/entities`
- Socket.IO project tree join
- `POST /project/:id/folder`
- `POST /project/:id/upload`
- `DELETE /project/:id/file/:fileId`
- `DELETE /project/:id/doc/:docId`

These endpoints are not public API contracts, so `overleaf-client.ts` isolates the behavior and includes fallbacks for project-tree extraction and stale folder metadata.

## Extension Permissions

Current manifest permissions:

- `storage`
- `activeTab`

Current host permissions:

- `https://www.overleaf.com/*`
- `wss://www.overleaf.com/*`
- `https://api.github.com/*`

The current extension does not request `identity`, `alarms`, `tabs`, or `<all_urls>`.

## Limitations

- No automatic sync.
- No bidirectional conflict detection or conflict-resolution UI.
- No side-by-side diff page.
- No OAuth/PKCE or Device Flow UI.
- No support for self-hosted Overleaf or non-GitHub remotes.
- Renames are treated as delete plus add.
- GitHub trees that GitHub marks as truncated are rejected.
- Files over 100 MB are skipped.
- Overleaf write behavior depends on internal Overleaf endpoints that may change.

## Roadmap

Near-term work:

- Add unlink and token disconnect flows through the service worker.
- Add conflict detection for cases where both sides changed since the manifest.

Later work:

- Bidirectional **Sync** mode.
- Conflict UI and text diff view.
- Autosync via `chrome.alarms`.
- OAuth/PKCE or completed Device Flow authentication.
- PR mode for protected GitHub branches.
- Optional GitLab or other remote implementations behind a remote-client interface.
