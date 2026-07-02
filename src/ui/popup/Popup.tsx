/**
 * Popup UI for Gitleaf — Modern redesign
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { PopupMessage, ServiceWorkerResponse, LinkConfig, SyncPreview } from '@shared/types';
import './popup.css';

/* =============================================
   Types
   ============================================= */

interface LinkStatus {
  linked: boolean;
  linkConfig?: LinkConfig;
  lastSync?: string;
}

interface ActiveOverleafTab {
  tabId: number;
  tabUrl: string;
  projectId: string;
  projectName: string;
  csrfToken?: string;
  userId?: string;
  rootFolder?: unknown;
}

/* =============================================
   SVG Icons
   ============================================= */

const LeafIcon = () => (
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M17 8C8 10 5.9 16.17 3.82 21.34L5.71 22l1-2.3A4.49 4.49 0 008 20c4 0 6-2 9-7 0 0-3 1-5 1s-4-1-4-1 1-2 4-2 8-1 8-1-1 4-3 6z"/>
  </svg>
);

const GitHubIcon = () => (
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
    <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
  </svg>
);

const SunIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="5"/>
    <line x1="12" y1="1" x2="12" y2="3"/>
    <line x1="12" y1="21" x2="12" y2="23"/>
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
    <line x1="1" y1="12" x2="3" y2="12"/>
    <line x1="21" y1="12" x2="23" y2="12"/>
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
  </svg>
);

const MoonIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>
);

const EyeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
);

const EyeOffIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);

const AlertIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
  </svg>
);

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

const SyncIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10"/>
    <polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
  </svg>
);

/* =============================================
   Helpers
   ============================================= */

function extractProjectId(url?: string): string | null {
  const match = url?.match(/\/project\/([a-f0-9]+)/i);
  return match ? match[1] : null;
}

function extractProjectName(title?: string): string {
  const match = title?.match(/^(.+?)\s*-\s*(?:Online LaTeX Editor\s+)?Overleaf/i);
  return match ? match[1] : 'Untitled Project';
}

function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return 'Just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'Just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  return new Date(isoString).toLocaleDateString();
}

/* =============================================
   Components
   ============================================= */

interface PopupShellProps {
  githubLabel?: string;
  children: React.ReactNode;
  onToggleDarkMode?: () => void;
  isDark?: boolean;
}

const PopupShell: React.FC<PopupShellProps> = ({ githubLabel, children, onToggleDarkMode, isDark }) => (
  <div className="popup-container">
    <header className="header">
      <div className="brand-icon">
        <LeafIcon />
      </div>
      <div className="brand-copy">
        <h1>Gitleaf</h1>
        <p>{githubLabel || 'Overleaf ↔ GitHub sync'}</p>
      </div>
      <div className="header-actions">
        {onToggleDarkMode && (
          <button
            className="theme-toggle"
            onClick={onToggleDarkMode}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? <SunIcon /> : <MoonIcon />}
          </button>
        )}
      </div>
    </header>
    <main className="content">{children}</main>
  </div>
);

/* --- Skeleton Loading --- */
const LoadingSkeleton: React.FC = () => (
  <div className="panel state-panel">
    <div className="spinner" />
    <h2>Checking project</h2>
    <p>Reading your Overleaf project and GitHub connection.</p>
    <div style={{ width: '100%', marginTop: 4 }}>
      <div className="skeleton skeleton-row">
        <div className="skeleton skeleton-icon" />
        <div className="skeleton skeleton-text">
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line" />
        </div>
      </div>
    </div>
  </div>
);

/* --- Error State --- */
interface ErrorStateProps {
  message: string;
  onRetry: () => void;
  onDismiss?: () => void;
}

const ErrorState: React.FC<ErrorStateProps> = ({ message, onRetry, onDismiss }) => (
  <div className="panel state-panel">
    <div className="status-dot status-dot--error" />
    <h2>Something went wrong</h2>
    <p>{message}</p>
    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
      <button onClick={onRetry} className="btn btn-primary">Retry</button>
      {onDismiss && (
        <button onClick={onDismiss} className="btn btn-secondary">Dismiss</button>
      )}
    </div>
  </div>
);

/* =============================================
   Main Popup Component
   ============================================= */

export const Popup: React.FC = () => {
  const [linkStatus, setLinkStatus] = useState<LinkStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<'push' | 'pull' | 'link' | 'token' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [pendingPreview, setPendingPreview] = useState<{
    direction: 'push' | 'pull';
    preview: SyncPreview;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState<'push' | 'pull' | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveOverleafTab | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [githubLogin, setGithubLogin] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [isDark, setIsDark] = useState(() =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  );

  // Apply dark mode attribute
  useEffect(() => {
    document.documentElement.setAttribute('data-color-scheme', isDark ? 'dark' : 'light');
  }, [isDark]);

  const githubLabel = useMemo(() => {
    if (!authenticated) return 'GitHub token required';
    return `GitHub: ${githubLogin || 'connected'}`;
  }, [authenticated, githubLogin]);

  const checkLinkStatus = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const projectId = extractProjectId(tab?.url);

      if (!tab?.id || !tab.url || !projectId) {
        setError('Open an Overleaf project tab to use Gitleaf.');
        setLoading(false);
        return;
      }

      const tabInfo: ActiveOverleafTab = {
        tabId: tab.id,
        tabUrl: tab.url,
        projectId,
        projectName: extractProjectName(tab.title),
      };

      try {
        const contentMeta = (await chrome.tabs.sendMessage(tab.id, {
          type: 'GET_PROJECT_META',
        })) as Partial<ActiveOverleafTab> | undefined;
        if (contentMeta?.projectId) tabInfo.projectId = contentMeta.projectId;
        if (contentMeta?.projectName) tabInfo.projectName = contentMeta.projectName;
        if (contentMeta?.csrfToken) tabInfo.csrfToken = contentMeta.csrfToken;
        if (contentMeta?.userId) tabInfo.userId = contentMeta.userId;
        if (contentMeta?.rootFolder) tabInfo.rootFolder = contentMeta.rootFolder;
      } catch {
        // Background can still fall back to stored metadata
      }
      setActiveTab(tabInfo);

      const authMessage: PopupMessage = { type: 'GET_AUTH_STATUS' };
      const authResponse = await chrome.runtime.sendMessage(authMessage) as ServiceWorkerResponse;
      if (authResponse.success) {
        const authData = authResponse.data as { authenticated: boolean; login?: string };
        setAuthenticated(authData.authenticated);
        setGithubLogin(authData.login || null);
      }

      const message: PopupMessage = { type: 'GET_LINK_STATUS', payload: tabInfo as unknown as Record<string, unknown> };
      const response = await chrome.runtime.sendMessage(message) as ServiceWorkerResponse;

      if (response.success) {
        setLinkStatus(response.data as LinkStatus);
      } else {
        setError(response.error || 'Failed to check link status');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkLinkStatus();
  }, [checkLinkStatus]);

  const refreshActiveTabMeta = useCallback(async (): Promise<ActiveOverleafTab | null> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const projectId = extractProjectId(tab?.url);
    if (!tab?.id || !tab.url || !projectId) return activeTab;

    const tabInfo: ActiveOverleafTab = {
      tabId: tab.id, tabUrl: tab.url, projectId,
      projectName: extractProjectName(tab.title),
    };

    try {
      const contentMeta = (await chrome.tabs.sendMessage(tab.id, { type: 'GET_PROJECT_META' })) as
        Partial<ActiveOverleafTab> | undefined;
      if (contentMeta?.projectId) tabInfo.projectId = contentMeta.projectId;
      if (contentMeta?.projectName) tabInfo.projectName = contentMeta.projectName;
      if (contentMeta?.csrfToken) tabInfo.csrfToken = contentMeta.csrfToken;
      if (contentMeta?.userId) tabInfo.userId = contentMeta.userId;
      if (contentMeta?.rootFolder) tabInfo.rootFolder = contentMeta.rootFolder;
    } catch { /* ignore */ }

    setActiveTab(tabInfo);
    return tabInfo;
  }, [activeTab]);

  const saveToken = async () => {
    setSyncing('token');
    setError(null);
    try {
      const message: PopupMessage = { type: 'SET_GITHUB_TOKEN', payload: { token: tokenInput } };
      const response = await chrome.runtime.sendMessage(message) as ServiceWorkerResponse;
      if (response.success) {
        const data = response.data as { login?: string };
        setAuthenticated(true);
        setGithubLogin(data.login || null);
        setTokenInput('');
      } else {
        setError(response.error || 'Failed to save GitHub token');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection error');
    } finally {
      setSyncing(null);
    }
  };

  const handlePush = async () => {
    if (!linkStatus?.linked) { setError('Project must be linked first'); return; }
    setPreviewLoading('push');
    setError(null);
    try {
      const message: PopupMessage = {
        type: 'PREVIEW_PUSH',
        payload: activeTab as unknown as Record<string, unknown>,
      };
      const response = await chrome.runtime.sendMessage(message) as ServiceWorkerResponse;
      if (response.success) {
        const data = response.data as { preview: SyncPreview };
        setPendingPreview({ direction: 'push', preview: data.preview });
      } else {
        setError(response.error || 'Could not preview push');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection error');
    } finally {
      setPreviewLoading(null);
    }
  };

  const handlePull = async () => {
    if (!linkStatus?.linked) { setError('Project must be linked first'); return; }
    setPreviewLoading('pull');
    setError(null);
    try {
      const freshTab = await refreshActiveTabMeta();
      const message: PopupMessage = {
        type: 'PREVIEW_PULL',
        payload: freshTab as unknown as Record<string, unknown>,
      };
      const response = await chrome.runtime.sendMessage(message) as ServiceWorkerResponse;
      if (response.success) {
        const data = response.data as { preview: SyncPreview };
        setPendingPreview({ direction: 'pull', preview: data.preview });
      } else {
        setError(response.error || 'Could not preview pull');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection error');
    } finally {
      setPreviewLoading(null);
    }
  };

  const confirmSync = async () => {
    if (!pendingPreview) return;
    const direction = pendingPreview.direction;
    setSyncing(direction);
    setError(null);
    try {
      const freshTab = direction === 'pull' ? await refreshActiveTabMeta() : activeTab;
      const message: PopupMessage = {
        type: direction === 'push' ? 'PUSH' : 'PULL',
        payload: freshTab as unknown as Record<string, unknown>,
      };
      const response = await chrome.runtime.sendMessage(message) as ServiceWorkerResponse;
      if (response.success) {
        setPendingPreview(null);
        await checkLinkStatus();
      } else {
        setError(response.error || `${direction} failed`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection error');
    } finally {
      setSyncing(null);
    }
  };

  const cancelPreview = () => setPendingPreview(null);

  const handleLink = async (owner: string, repo: string, branch: string, subPath: string) => {
    setSyncing('link');
    setError(null);
    try {
      const message: PopupMessage = {
        type: 'LINK_GITHUB',
        payload: { ...(activeTab || {}), owner, repo, branch, subPath },
      };
      const response = await chrome.runtime.sendMessage(message) as ServiceWorkerResponse;
      if (response.success) {
        setShowLinkDialog(false);
        await checkLinkStatus();
      } else {
        setError(response.error || 'Failed to link project');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection error');
    } finally {
      setSyncing(null);
    }
  };

  const dismissError = () => setError(null);

  if (loading) {
    return (
      <PopupShell githubLabel={githubLabel} onToggleDarkMode={() => setIsDark(d => !d)} isDark={isDark}>
        <LoadingSkeleton />
      </PopupShell>
    );
  }

  if (error && !linkStatus) {
    return (
      <PopupShell githubLabel={githubLabel} onToggleDarkMode={() => setIsDark(d => !d)} isDark={isDark}>
        <ErrorState message={error} onRetry={checkLinkStatus} onDismiss={() => setError(null)} />
      </PopupShell>
    );
  }

  if (!linkStatus?.linked) {
    return (
      <PopupShell githubLabel={githubLabel} onToggleDarkMode={() => setIsDark(d => !d)} isDark={isDark}>
        {error && (
          <div className="error-banner">
            <span className="error-banner-icon"><AlertIcon /></span>
            <span className="error-banner-text">{error}</span>
            <button className="error-banner-dismiss" onClick={dismissError}><CloseIcon /></button>
          </div>
        )}

        <div className="project-panel panel">
          <div>
            <span className="eyebrow">Overleaf project</span>
            <h2>{activeTab?.projectName || 'Current project'}</h2>
          </div>
          <span className="pill pill--default">Not linked</span>
        </div>

        <div className="action-panel panel">
          {!authenticated ? (
            <>
              <div className="section-heading">
                <h3>Connect GitHub</h3>
                <p>Enter a token with repository access to get started.</p>
              </div>
              <div className="input-with-toggle">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  className="form-control"
                  placeholder="github_pat_..."
                  onKeyDown={(e) => e.key === 'Enter' && saveToken()}
                />
                <button
                  className="input-toggle-btn"
                  onClick={() => setShowToken(s => !s)}
                  title={showToken ? 'Hide token' : 'Show token'}
                >
                  {showToken ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
              <button
                onClick={saveToken}
                disabled={syncing === 'token' || !tokenInput.trim()}
                className="btn btn-primary full-width"
              >
                {syncing === 'token' ? 'Saving...' : 'Save Token'}
              </button>
            </>
          ) : (
            <>
              <div className="section-heading">
                <h3>Choose a repository</h3>
                <p>Link this Overleaf project to a GitHub repo and branch.</p>
              </div>
              <button onClick={() => setShowLinkDialog(true)} className="btn btn-primary full-width">
                <SyncIcon />
                Link to GitHub
              </button>
            </>
          )}
        </div>

        {showLinkDialog && (
          <LinkDialog
            onLink={handleLink}
            onCancel={() => setShowLinkDialog(false)}
            loading={syncing === 'link'}
          />
        )}
      </PopupShell>
    );
  }

  const config = linkStatus.linkConfig!;
  const lastSyncDate = linkStatus.lastSync
    ? formatRelativeTime(linkStatus.lastSync)
    : 'Never';

  return (
    <PopupShell githubLabel={githubLabel} onToggleDarkMode={() => setIsDark(d => !d)} isDark={isDark}>
      {error && (
        <div className="error-banner">
          <span className="error-banner-icon"><AlertIcon /></span>
          <span className="error-banner-text">{error}</span>
          <button className="error-banner-dismiss" onClick={dismissError}><CloseIcon /></button>
        </div>
      )}

      <div className="project-panel panel">
        <div>
          <span className="eyebrow">Overleaf project</span>
          <h2>{activeTab?.projectName || 'Current project'}</h2>
        </div>
        <span className="pill pill--success">
          <span className="status-dot status-dot--success" />
          Linked
        </span>
      </div>

      <div className="link-info panel">
        <div className="repo-row">
          <div className="repo-icon"><GitHubIcon /></div>
          <div>
            <div className="link-badge">{config.github.owner}/{config.github.repo}</div>
            <div className="sync-info">Branch {config.github.branch}</div>
          </div>
        </div>
        <div className="meta-grid">
          <div className="meta-cell">
            <span>Subfolder</span>
            <strong>{config.github.subPath || 'Repository root'}</strong>
          </div>
          <div className="meta-cell">
            <span>Last sync</span>
            <strong>{lastSyncDate}</strong>
          </div>
        </div>
      </div>

      {syncing && (
        <div className="sync-progress">
          <div className="sync-progress-bar"><div className="sync-progress-fill" /></div>
          <span className="sync-progress-text">
            {syncing === 'push' ? 'Pushing...' : syncing === 'pull' ? 'Pulling...' : 'Syncing...'}
          </span>
        </div>
      )}

      <div className="action-panel panel">
        <div className="button-group">
          <button
            onClick={handlePush}
            disabled={syncing !== null || previewLoading !== null}
            className="btn btn-primary"
            title="Preview and push Overleaf changes to GitHub"
          >
            <SyncIcon />
            {previewLoading === 'push' ? 'Checking...' : syncing === 'push' ? 'Pushing...' : 'Push'}
          </button>
          <button
            onClick={handlePull}
            disabled={syncing !== null || previewLoading !== null}
            className="btn btn-secondary"
            title="Preview and pull GitHub changes to Overleaf"
          >
            {previewLoading === 'pull' ? 'Checking...' : syncing === 'pull' ? 'Pulling...' : 'Pull'}
          </button>
        </div>
        <div className="footer-buttons">
          <button
            onClick={() => setShowLinkDialog(true)}
            disabled={syncing !== null || previewLoading !== null}
            className="btn-text"
          >
            Change repository
          </button>
        </div>
      </div>

      {showLinkDialog && (
        <LinkDialog
          onLink={handleLink}
          onCancel={() => setShowLinkDialog(false)}
          loading={syncing === 'link'}
        />
      )}

      {pendingPreview && (
        <SyncPreviewDialog
          direction={pendingPreview.direction}
          preview={pendingPreview.preview}
          loading={syncing === pendingPreview.direction}
          onConfirm={confirmSync}
          onCancel={cancelPreview}
        />
      )}
    </PopupShell>
  );
};

/* =============================================
   Sync Preview Dialog
   ============================================= */

interface SyncPreviewDialogProps {
  direction: 'push' | 'pull';
  preview: SyncPreview;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const SyncPreviewDialog: React.FC<SyncPreviewDialogProps> = ({
  direction,
  preview,
  loading,
  onConfirm,
  onCancel,
}) => {
  const total = preview.added.length + preview.modified.length + preview.deleted.length;
  const headline =
    direction === 'push'
      ? 'Push these changes to GitHub?'
      : 'Apply these changes from GitHub to Overleaf?';
  const subline =
    direction === 'push'
      ? 'Files will be committed to the linked branch.'
      : 'Files will be written to your Overleaf project. Deletions cannot be undone.';

  return (
    <div className="dialog-overlay">
      <div className="dialog sync-preview-dialog">
        <div className="dialog-header">
          <h2>{headline}</h2>
          <p>{subline}</p>
        </div>

        <div className="dialog-body">
          {total === 0 ? (
            <p className="preview-empty">No changes detected — nothing to {direction}.</p>
          ) : (
            <>
              <div className="preview-summary">
                <span className="preview-pill preview-pill--add">+{preview.added.length} added</span>
                <span className="preview-pill preview-pill--mod">~{preview.modified.length} modified</span>
                <span className="preview-pill preview-pill--del">−{preview.deleted.length} deleted</span>
              </div>
              <div className="preview-list">
                {preview.added.map((p) => (
                  <div key={`a-${p}`} className="preview-row">
                    <span className="preview-marker preview-marker--add">+</span>
                    <span className="preview-path">{p}</span>
                  </div>
                ))}
                {preview.modified.map((p) => (
                  <div key={`m-${p}`} className="preview-row">
                    <span className="preview-marker preview-marker--mod">~</span>
                    <span className="preview-path">{p}</span>
                  </div>
                ))}
                {preview.deleted.map((p) => (
                  <div key={`d-${p}`} className="preview-row">
                    <span className="preview-marker preview-marker--del">−</span>
                    <span className="preview-path">{p}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="dialog-buttons">
          <button onClick={onCancel} disabled={loading} className="btn btn-secondary">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading || total === 0}
            className="btn btn-primary"
          >
            {loading
              ? direction === 'push'
                ? 'Pushing...'
                : 'Pulling...'
              : direction === 'push'
                ? 'Confirm Push'
                : 'Confirm Pull'}
          </button>
        </div>
      </div>
    </div>
  );
};

/* =============================================
   Link Dialog
   ============================================= */

interface LinkDialogProps {
  onLink: (owner: string, repo: string, branch: string, subPath: string) => Promise<void>;
  onCancel: () => void;
  loading: boolean;
}

const LinkDialog: React.FC<LinkDialogProps> = ({ onLink, onCancel, loading }) => {
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [subPath, setSubPath] = useState('');
  const [repos, setRepos] = useState<Array<{ full_name: string; default_branch: string }>>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    loadRepositories();
  }, []);

  const loadRepositories = async () => {
    setLoadingRepos(true);
    const message: PopupMessage = { type: 'GET_GITHUB_REPOS' };
    try {
      const response = await chrome.runtime.sendMessage(message) as ServiceWorkerResponse;
      if (response.success) {
        const reposData = response.data as { repos: Array<{ full_name: string; default_branch: string }> };
        setRepos(reposData.repos);
      }
    } catch (err) {
      console.error('Failed to load repositories:', err);
    } finally {
      setLoadingRepos(false);
    }
  };

  const filteredRepos = useMemo(() => {
    if (!searchQuery) return repos;
    const q = searchQuery.toLowerCase();
    return repos.filter(r => r.full_name.toLowerCase().includes(q));
  }, [repos, searchQuery]);

  const handleRepoSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const fullName = e.target.value;
    if (!fullName) {
      setOwner('');
      setRepo('');
      return;
    }
    const [o, r] = fullName.split('/');
    setOwner(o);
    setRepo(r);
    const selectedRepo = repos.find(rp => rp.full_name === fullName);
    if (selectedRepo) setBranch(selectedRepo.default_branch);
  };

  const handleSubmit = async () => {
    if (!owner || !repo) return;
    await onLink(owner, repo, branch, subPath);
  };

  return (
    <div className="dialog-overlay">
      <div className="dialog">
        <div className="dialog-header">
          <h2>Link repository</h2>
          <p>Connect your Overleaf project to a GitHub repository.</p>
        </div>

        <div className="steps">
          <div className="step step--active">
            <span className="step-number">1</span>
            Repo
          </div>
          <div className="step-divider" />
          <div className="step">
            <span className="step-number">2</span>
            Branch
          </div>
          <div className="step-divider" />
          <div className="step">
            <span className="step-number">3</span>
            Confirm
          </div>
        </div>

        <div className="dialog-body">
          <div className="form-group">
            <label htmlFor="repository">Repository</label>
            <div className="repo-search">
              <span className="repo-search-icon">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
              </span>
              <input
                className="form-control repo-search-input"
                placeholder="Search repositories..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <select
              id="repository"
              value={owner && repo ? `${owner}/${repo}` : ''}
              onChange={handleRepoSelect}
              disabled={loadingRepos}
              className="form-control"
              size={Math.min(5, (filteredRepos.length || 1) + 1)}
            >
              {loadingRepos ? (
                <option value="">Loading repositories...</option>
              ) : filteredRepos.length === 0 ? (
                <option value="">{searchQuery ? 'No matches found' : 'No repositories'}</option>
              ) : (
                <>
                  <option value="">Select a repository...</option>
                  {filteredRepos.map(r => (
                    <option key={r.full_name} value={r.full_name}>{r.full_name}</option>
                  ))}
                </>
              )}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="branch">Branch</label>
            <input
              id="branch"
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="form-control"
              placeholder="main"
            />
          </div>

          <div className="form-group">
            <label htmlFor="subPath">Subfolder (optional)</label>
            <input
              id="subPath"
              type="text"
              value={subPath}
              onChange={(e) => setSubPath(e.target.value)}
              className="form-control"
              placeholder="paper/"
            />
          </div>
        </div>

        <div className="dialog-buttons">
          <button onClick={onCancel} disabled={loading} className="btn btn-secondary">Cancel</button>
          <button onClick={handleSubmit} disabled={loading || !owner || !repo} className="btn btn-primary">
            {loading ? 'Linking...' : 'Link Project'}
          </button>
        </div>
      </div>
    </div>
  );
};

// Mount the popup
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<Popup />);
}
