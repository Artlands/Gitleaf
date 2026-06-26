# Gitleaf

> Sync Overleaf projects with GitHub repositories — no premium Overleaf subscription required.

Gitleaf is a Chrome extension that bridges [Overleaf](https://www.overleaf.com) (online LaTeX editor) and [GitHub](https://github.com). It lets you preview and push your Overleaf project to a GitHub repo (or a subfolder of one), and preview and pull files back into Overleaf — all from your browser, with no external server.

This is especially useful for free-tier Overleaf users who don't have access to Overleaf's built-in Git bridge, or for users who want to map an Overleaf project to a *subfolder* of an existing repo.

![Gitleaf icon](public/assets/icon-128.png)

## Features

- **Push** — upload files from Overleaf to a GitHub repository as a clean commit
- **Pull** — download files from a GitHub repository into your Overleaf project
- **Preview before write** — review added, modified, and deleted files before confirming Push or Pull
- **Subfolder mapping** — sync a specific subfolder of a repo (not just the whole repo)
- **Ignore patterns** — skip files matching gitignore-style patterns
- **GitHub PAT authentication** — fine-grained or classic personal access tokens
- **Secure** — everything runs client-side; tokens are stored in `chrome.storage.local`

## Quick Start

1. Install the extension (see [Development](#development) for local setup).
2. Open an Overleaf project page.
3. Click the Gitleaf icon in your Chrome toolbar.
4. Enter a [GitHub Personal Access Token](https://github.com/settings/tokens) with `Contents: Read and write` permissions.
5. Link your Overleaf project to a GitHub repository, branch, and optional subfolder.
6. Click **Push** to preview Overleaf-to-GitHub changes, or **Pull** to preview GitHub-to-Overleaf changes.
7. Confirm the preview dialog to apply the changes.

### Getting a GitHub Token

1. Go to **GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens**.
2. Click **Generate new token**.
3. Give it a name (e.g., `Gitleaf`), set an expiration, and under **Repository access** choose `Only select repositories`.
4. Under **Repository permissions**, set **Contents** to `Read and write`.
5. Copy the token and paste it into the Gitleaf popup.

> Fine-grained tokens are recommended because they can be scoped to a single repository. Classic tokens with the `repo` scope also work.

## Project Structure

```
src/
  background/
    service-worker.ts       # Message router and sync orchestrator
    sync-engine.ts          # Push/pull change detection and ignore matching
    github-client.ts        # GitHub REST API client + token validation
    overleaf-client.ts      # Overleaf ZIP download and write helpers
    storage.ts              # chrome.storage wrapper
  content/
    overleaf-content.ts     # Extracts project metadata from Overleaf pages
  ui/
    popup/                  # React popup UI (token, linking, previews, Push/Pull)
    options/                # Settings and linked-project management UI
  shared/
    types.ts                # Shared TypeScript types
    hash.ts                 # SHA-1 hashing utilities
```

## Development

### Prerequisites

- Node.js 18+
- npm
- Chrome or Chromium

### Setup

```bash
git clone <repo-url>
cd gitleaf
npm install
```

### Build & Load

```bash
npm run build
```

1. Go to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `dist/` folder

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server with HMR |
| `npm run build` | Production build to `dist/` |
| `npm run test` | Run tests with Vitest |
| `npm run lint` | Lint source files |
| `npm run format` | Format source files with Prettier |

## How It Works

### Push (Overleaf → GitHub)

1. The content script reads the Overleaf project ID and CSRF token from the page.
2. The service worker downloads the project as a ZIP archive via Overleaf's internal API.
3. Files are extracted, SHA-1 hashes are computed, ignore patterns are applied, and changes are detected against the last sync state.
4. The popup shows a preview of added, modified, and deleted files.
5. After confirmation, changed files are committed to the configured GitHub branch via the Git Data API.
6. The sync manifest is updated for next comparison.

### Pull (GitHub → Overleaf)

1. The service worker reads the repository tree from GitHub.
2. If a subfolder is configured, only files under that GitHub prefix are considered.
3. File hashes are compared against the sync manifest.
4. The popup shows a preview of added, modified, and deleted files.
5. After confirmation, files are written to Overleaf and deleted files are removed.
6. The sync manifest is updated for next comparison.

## Known Limitations

- **No automatic sync** — Push and Pull are manual.
- **No bidirectional Sync mode** — Use Push or Pull explicitly. Three-way conflict handling is future work.
- **No conflict UI yet** — Concurrent edits on both sides require manual resolution before syncing.
- **Overleaf internal endpoints** — Pull uses Overleaf web-editor endpoints that may change. If Pull fails, try refreshing the Overleaf tab and retrying.
- **File size limit** — GitHub blobs over 100 MB are skipped.

## Security

- GitHub tokens are stored in `chrome.storage.local` (encrypted by Chrome at rest).
- All processing happens locally in the browser — no data is sent to any Gitleaf server.
- No analytics, no telemetry, no external CDN scripts.
- Content scripts run only on `overleaf.com` origins.

## License

MIT
