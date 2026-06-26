# Privacy Policy for Gitleaf

**Last updated:** June 26, 2026

Gitleaf is a Chrome extension that synchronizes files between Overleaf projects and GitHub repositories. This privacy policy explains how Gitleaf handles your data.

## Data Collection

Gitleaf **does not collect, store, or transmit any personal data** to any server operated by the extension developer. The extension runs entirely client-side in the user's browser.

## Data Storage

### What is stored locally

- **GitHub Personal Access Token** — stored under `github_token` in `chrome.storage.local`, encrypted by Chrome at rest. This token is used exclusively to authenticate API requests to GitHub on your behalf.
- **Sync manifests** — SHA-1 hashes of your synced files, stored under `sync_manifests` in `chrome.storage.local`. These are used to detect which files have changed between sync operations.
- **Link configurations** — mappings between Overleaf project IDs and GitHub repository paths, stored under `link_configs` in `chrome.storage.local`.
- **User preferences** — ignore patterns, default branch settings, and autosync interval settings are stored in `chrome.storage.sync` (synced across your Chrome profiles when Chrome sync is enabled).

### What is never stored

- Your Overleaf session cookies
- Your actual file content (only SHA-1 hashes are stored locally for change detection)
- Your browsing history, bookmarks, or any other browser data

## Data Transmission

Gitleaf makes network requests only to:

### Overleaf (`https://www.overleaf.com`, `wss://www.overleaf.com`)
- Downloads your project files as ZIP archives
- Fetches project metadata
- Writes changes back to your Overleaf project
- These requests use your existing browser session (no separate authentication)

### GitHub (`https://api.github.com`)
- Validates your Personal Access Token
- Lists your repositories
- Reads repository files for pull operations
- Creates blobs, trees, and commits for push operations
- All requests are authenticated with your Personal Access Token

### No third-party servers

Gitleaf does **not** communicate with any analytics service, error tracker, or developer-operated server. There is no telemetry, no crash reporting, no usage tracking, and no advertising.

## Data Security

- GitHub tokens are stored in `chrome.storage.local`, which Chrome encrypts at the operating system level
- All network requests to GitHub use HTTPS
- The extension uses strict Content Security Policy (`script-src 'self'`) — no external scripts are loaded
- No credentials are ever sent to any server other than Overleaf and GitHub

## Third-Party Services

### GitHub
Gitleaf uses the GitHub REST API under the terms of [GitHub's Privacy Policy](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement). You must provide a GitHub Personal Access Token with repository contents read/write access. Fine-grained tokens scoped to selected repositories are recommended; classic tokens with the `repo` scope also work.

### Overleaf
Gitleaf interacts with Overleaf through the same endpoints the Overleaf web UI uses. All actions are performed within your existing browser session. Your use of Overleaf is governed by [Overleaf's Privacy Policy](https://www.overleaf.com/legal/privacy).

## User Control

You can:

- **Revoke** your GitHub token at any time in your [GitHub token settings](https://github.com/settings/tokens)
- **Remove** all stored data by going to `chrome://extensions/` → Gitleaf → "Clear storage" or uninstalling the extension
- **Uninstall** the extension completely, which removes all locally stored data

## Changes to This Policy

If this privacy policy changes, the updated version will be posted here with a new "Last updated" date.

## Contact

For questions about this privacy policy, open an issue on the [Gitleaf GitHub repository](https://github.com/YOUR_USERNAME/gitleaf).
