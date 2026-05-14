/**
 * Popup UI for Gitleaf
 * Shows link status and provides sync controls
 */

import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { PopupMessage, ServiceWorkerResponse, LinkConfig } from '@shared/types';
import './popup.css';

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

interface PopupShellProps {
  githubLabel?: string;
  children: React.ReactNode;
}

function extractProjectId(url?: string): string | null {
  const match = url?.match(/\/project\/([a-f0-9]+)/i);
  return match ? match[1] : null;
}

function extractProjectName(title?: string): string {
  const match = title?.match(/^(.+?)\s*-\s*(?:Online LaTeX Editor\s+)?Overleaf/i);
  return match ? match[1] : 'Untitled Project';
}

function formatSubPath(subPath?: string): string {
  if (!subPath) {
    return 'Repository root';
  }
  return subPath;
}

const PopupShell: React.FC<PopupShellProps> = ({ githubLabel, children }) => (
  <div className="popup-container">
    <header className="header">
      <div className="brand-mark" aria-hidden="true">
        G
      </div>
      <div className="brand-copy">
        <h1>Gitleaf</h1>
        <p>{githubLabel || 'Overleaf and GitHub sync'}</p>
      </div>
    </header>
    <main className="content">{children}</main>
  </div>
);

export const Popup: React.FC = () => {
  const [linkStatus, setLinkStatus] = useState<LinkStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncAction, setSyncAction] = useState<'push' | 'pull' | 'link' | 'token' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveOverleafTab | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [githubLogin, setGithubLogin] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState('');

  useEffect(() => {
    checkLinkStatus();
  }, []);

  const checkLinkStatus = async () => {
    setLoading(true);
    setError(null);

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const projectId = extractProjectId(tab.url);

      if (!tab.id || !tab.url || !projectId) {
        setError('Open an Overleaf project tab to use Gitleaf.');
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
        if (contentMeta?.projectId) {
          tabInfo.projectId = contentMeta.projectId;
        }
        if (contentMeta?.projectName) {
          tabInfo.projectName = contentMeta.projectName;
        }
        if (contentMeta?.csrfToken) {
          tabInfo.csrfToken = contentMeta.csrfToken;
        }
        if (contentMeta?.userId) {
          tabInfo.userId = contentMeta.userId;
        }
        if (contentMeta?.rootFolder) {
          tabInfo.rootFolder = contentMeta.rootFolder;
        }
      } catch {
        // The background can still fall back to stored metadata or page fetches.
      }
      setActiveTab(tabInfo);

      const authMessage: PopupMessage = { type: 'GET_AUTH_STATUS' };
      const authResponse = (await chrome.runtime.sendMessage(authMessage)) as ServiceWorkerResponse;
      if (authResponse.success) {
        const authData = authResponse.data as { authenticated: boolean; login?: string };
        setAuthenticated(authData.authenticated);
        setGithubLogin(authData.login || null);
      }

      const message: PopupMessage = {
        type: 'GET_LINK_STATUS',
        payload: tabInfo as unknown as Record<string, unknown>,
      };
      const response = await chrome.runtime.sendMessage(message);
      const typedResponse = response as ServiceWorkerResponse;

      if (typedResponse.success) {
        setLinkStatus(typedResponse.data as LinkStatus);
      } else {
        setError(typedResponse.error || 'Failed to check link status');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection error');
    } finally {
      setLoading(false);
    }
  };

  const refreshActiveTabMeta = async (): Promise<ActiveOverleafTab | null> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const projectId = extractProjectId(tab.url);

    if (!tab.id || !tab.url || !projectId) {
      return activeTab;
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
      if (contentMeta?.projectId) {
        tabInfo.projectId = contentMeta.projectId;
      }
      if (contentMeta?.projectName) {
        tabInfo.projectName = contentMeta.projectName;
      }
      if (contentMeta?.csrfToken) {
        tabInfo.csrfToken = contentMeta.csrfToken;
      }
      if (contentMeta?.userId) {
        tabInfo.userId = contentMeta.userId;
      }
      if (contentMeta?.rootFolder) {
        tabInfo.rootFolder = contentMeta.rootFolder;
      }
    } catch {
      return activeTab || tabInfo;
    }

    setActiveTab(tabInfo);
    return tabInfo;
  };

  const saveToken = async () => {
    setSyncAction('token');
    setError(null);

    try {
      const message: PopupMessage = {
        type: 'SET_GITHUB_TOKEN',
        payload: { token: tokenInput },
      };
      const response = (await chrome.runtime.sendMessage(message)) as ServiceWorkerResponse;

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
      setSyncAction(null);
    }
  };

  const handlePush = async () => {
    if (!linkStatus?.linked) {
      setError('Project must be linked first');
      return;
    }

    setSyncAction('push');
    setError(null);

    const message: PopupMessage = {
      type: 'PUSH',
      payload: activeTab as unknown as Record<string, unknown>,
    };

    try {
      const response = await chrome.runtime.sendMessage(message);
      const typedResponse = response as ServiceWorkerResponse;

      if (typedResponse.success) {
        setError(null);
        // Refresh status
        await checkLinkStatus();
      } else {
        setError(typedResponse.error || 'Push failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection error');
    } finally {
      setSyncAction(null);
    }
  };

  const handlePull = async () => {
    if (!linkStatus?.linked) {
      setError('Project must be linked first');
      return;
    }

    setSyncAction('pull');
    setError(null);

    const freshTab = await refreshActiveTabMeta();

    const message: PopupMessage = {
      type: 'PULL',
      payload: freshTab as unknown as Record<string, unknown>,
    };

    try {
      const response = await chrome.runtime.sendMessage(message);
      const typedResponse = response as ServiceWorkerResponse;

      if (typedResponse.success) {
        setError(null);
        await checkLinkStatus();
      } else {
        setError(typedResponse.error || 'Pull failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection error');
    } finally {
      setSyncAction(null);
    }
  };

  const handleLink = async (owner: string, repo: string, branch: string, subPath: string) => {
    setSyncAction('link');
    setError(null);

    const message: PopupMessage = {
      type: 'LINK_GITHUB',
      payload: {
        ...(activeTab || {}),
        owner,
        repo,
        branch,
        subPath,
      },
    };

    try {
      const response = await chrome.runtime.sendMessage(message);
      const typedResponse = response as ServiceWorkerResponse;

      if (typedResponse.success) {
        setShowLinkDialog(false);
        await checkLinkStatus();
      } else {
        setError(typedResponse.error || 'Failed to link project');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection error');
    } finally {
      setSyncAction(null);
    }
  };

  if (loading) {
    return (
      <PopupShell>
        <div className="state-panel">
          <div className="spinner" aria-hidden="true" />
          <h2>Checking project</h2>
          <p>Reading the active Overleaf tab and GitHub connection.</p>
        </div>
      </PopupShell>
    );
  }

  if (error && !linkStatus) {
    return (
      <PopupShell>
        <div className="state-panel">
          <span className="status-dot status-dot-error" aria-hidden="true" />
          <h2>Project unavailable</h2>
          <p>{error}</p>
          <button onClick={checkLinkStatus} className="btn btn-secondary">
            Retry
          </button>
        </div>
      </PopupShell>
    );
  }

  if (!linkStatus?.linked) {
    const githubLabel = authenticated ? `GitHub: ${githubLogin || 'connected'}` : 'GitHub token required';

    return (
      <PopupShell githubLabel={githubLabel}>
        {error && <div className="error-banner">{error}</div>}
        <section className="project-panel">
          <div>
            <span className="eyebrow">Overleaf project</span>
            <h2>{activeTab?.projectName || 'Current project'}</h2>
          </div>
          <span className="pill">Not linked</span>
        </section>

        <section className="action-panel">
          {!authenticated ? (
            <>
              <div className="section-heading">
                <h3>Connect GitHub</h3>
                <p>Use a token with repository access.</p>
              </div>
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                className="form-control"
                placeholder="github_pat_..."
              />
              <button
                onClick={saveToken}
                disabled={Boolean(syncAction) || !tokenInput.trim()}
                className="btn btn-primary full-width"
              >
                {syncAction === 'token' ? 'Saving...' : 'Save Token'}
              </button>
            </>
          ) : (
            <>
              <div className="section-heading">
                <h3>Choose a repository</h3>
                <p>Link this Overleaf project to a GitHub repo and branch.</p>
              </div>
              <button onClick={() => setShowLinkDialog(true)} className="btn btn-primary full-width">
                Link to GitHub
              </button>
            </>
          )}
        </section>

        {showLinkDialog && (
          <LinkDialog
            onLink={handleLink}
            onCancel={() => setShowLinkDialog(false)}
            loading={syncAction === 'link'}
          />
        )}
      </PopupShell>
    );
  }

  const config = linkStatus.linkConfig!;
  const lastSyncDate = linkStatus.lastSync
    ? new Date(linkStatus.lastSync).toLocaleString()
    : 'Never';

  return (
    <PopupShell githubLabel={`GitHub: ${githubLogin || config.github.owner}`}>
      {error && <div className="error-banner">{error}</div>}
      <section className="project-panel">
        <div>
          <span className="eyebrow">Overleaf project</span>
          <h2>{activeTab?.projectName || 'Current project'}</h2>
        </div>
        <span className="pill pill-success">Linked</span>
      </section>

      <section className="link-info">
        <div className="repo-row">
          <span className="repo-icon" aria-hidden="true">
            GH
          </span>
          <div>
            <div className="link-badge">
              {config.github.owner}/{config.github.repo}
            </div>
            <div className="sync-info">Branch {config.github.branch}</div>
          </div>
        </div>
        <div className="meta-grid">
          <div>
            <span>Folder</span>
            <strong>{formatSubPath(config.github.subPath)}</strong>
          </div>
          <div>
            <span>Last sync</span>
            <strong>{lastSyncDate}</strong>
          </div>
        </div>
      </section>

      <section className="action-panel">
        <div className="button-group">
          <button
            onClick={handlePush}
            disabled={Boolean(syncAction)}
            className="btn btn-primary"
            title="Push Overleaf changes to GitHub"
          >
            {syncAction === 'push' ? 'Syncing...' : 'Push'}
          </button>
          <button
            onClick={handlePull}
            disabled={Boolean(syncAction)}
            className="btn btn-secondary"
            title="Pull GitHub changes to Overleaf"
          >
            {syncAction === 'pull' ? 'Syncing...' : 'Pull'}
          </button>
        </div>

        <div className="footer-buttons">
          <button onClick={() => setShowLinkDialog(true)} className="btn-text">
            Relink
          </button>
        </div>
      </section>

      {showLinkDialog && (
        <LinkDialog
          onLink={handleLink}
          onCancel={() => setShowLinkDialog(false)}
          loading={syncAction === 'link'}
        />
      )}
    </PopupShell>
  );
};

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

  useEffect(() => {
    loadRepositories();
  }, []);

  const loadRepositories = async () => {
    setLoadingRepos(true);

    const message: PopupMessage = { type: 'GET_GITHUB_REPOS' };

    try {
      const response = await chrome.runtime.sendMessage(message);
      const typedResponse = response as ServiceWorkerResponse;

      if (typedResponse.success) {
        const reposData = typedResponse.data as { repos: Array<{ full_name: string; default_branch: string }> };
        setRepos(reposData.repos);
      }
    } catch (err) {
      console.error('Failed to load repositories:', err);
    } finally {
      setLoadingRepos(false);
    }
  };

  const handleRepoSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const fullName = e.target.value;
    if (fullName) {
      const [o, r] = fullName.split('/');
      setOwner(o);
      setRepo(r);

      const selectedRepo = repos.find((rp) => rp.full_name === fullName);
      if (selectedRepo) {
        setBranch(selectedRepo.default_branch);
      }
    }
  };

  const handleSubmit = async () => {
    if (!owner || !repo) {
      alert('Please select a repository');
      return;
    }
    await onLink(owner, repo, branch, subPath);
  };

  return (
    <div className="dialog-overlay">
      <div className="dialog">
        <div className="dialog-header">
          <h2>Link repository</h2>
          <p>Select the GitHub source for this Overleaf project.</p>
        </div>

        <div className="form-group">
          <label htmlFor="repository">Repository</label>
          <select
            id="repository"
            onChange={handleRepoSelect}
            disabled={loadingRepos}
            className="form-control"
          >
            <option value="">
              {loadingRepos ? 'Loading repositories...' : 'Select a repository'}
            </option>
            {repos.map((r) => (
              <option key={r.full_name} value={r.full_name}>
                {r.full_name}
              </option>
            ))}
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
          <label htmlFor="subPath">Repository subfolder</label>
          <input
            id="subPath"
            type="text"
            value={subPath}
            onChange={(e) => setSubPath(e.target.value)}
            className="form-control"
            placeholder="paper/"
          />
        </div>

        <div className="dialog-buttons">
          <button onClick={onCancel} disabled={loading} className="btn btn-secondary">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={loading || !owner || !repo} className="btn btn-primary">
            {loading ? 'Linking...' : 'Link'}
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
