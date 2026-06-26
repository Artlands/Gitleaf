/**
 * Options/Settings page for Gitleaf
 * Tabs: Account | Linked Projects | Settings
 */

import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { PopupMessage, ServiceWorkerResponse } from '@shared/types';
import './options.css';

/* =============================================
   Types
   ============================================= */

interface LinkedProject {
  overleafProjectId: string;
  overleafProjectName?: string;
  github: { owner: string; repo: string; branch: string; subPath?: string };
  lastSync?: string;
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
  <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
  </svg>
);

const LinkIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
  </svg>
);

const UnlinkIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18.36" y1="18.36" x2="6.36" y2="6.36"/>
    <line x1="6.36" y1="18.36" x2="18.36" y2="6.36"/>
  </svg>
);

const EmptyFolderIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>
);

/* =============================================
   Options Page Component
   ============================================= */

const Options: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'account' | 'projects' | 'settings'>('account');
  const [authenticated, setAuthenticated] = useState(false);
  const [githubLogin, setGithubLogin] = useState<string | null>(null);
  const [linkedProjects, setLinkedProjects] = useState<LinkedProject[]>([]);
  const [ignorePatterns, setIgnorePatterns] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    loadAllData();
  }, []);

  const loadAllData = async () => {
    try {
      const authMessage: PopupMessage = { type: 'GET_AUTH_STATUS' };
      const authResponse = await chrome.runtime.sendMessage(authMessage) as ServiceWorkerResponse;
      if (authResponse.success) {
        const data = authResponse.data as { authenticated: boolean; login?: string };
        setAuthenticated(data.authenticated);
        setGithubLogin(data.login || null);
      }

      // Load storage settings
      const result = await chrome.storage.sync.get(['ignorePatterns', 'defaultBranch']);
      if (result.ignorePatterns) setIgnorePatterns(result.ignorePatterns);
      if (result.defaultBranch) setDefaultBranch(result.defaultBranch);

      // Load linked configurations
      const configs = await chrome.storage.local.get('linkConfigs');
      if (configs.linkConfigs) {
        const configEntries = Object.entries(configs.linkConfigs).map(([id, cfg]: [string, Record<string, unknown>]) => ({
          overleafProjectId: id,
          overleafProjectName: cfg.overleafProjectName as string | undefined,
          github: cfg.github as LinkedProject['github'],
          lastSync: cfg.createdAt as string | undefined,
        }));
        setLinkedProjects(configEntries);
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  };

  const saveSettings = async () => {
    try {
      await chrome.storage.sync.set({
        ignorePatterns,
        defaultBranch,
      });
      setStatusMessage({ type: 'success', text: 'Settings saved!' });
      setTimeout(() => setStatusMessage(null), 2500);
    } catch (err) {
      setStatusMessage({ type: 'error', text: 'Failed to save settings' });
    }
  };

  const disconnectAccount = async () => {
    try {
      await chrome.storage.local.remove('githubToken');
      setAuthenticated(false);
      setGithubLogin(null);
      setStatusMessage({ type: 'success', text: 'Account disconnected' });
      setTimeout(() => setStatusMessage(null), 2500);
    } catch (err) {
      setStatusMessage({ type: 'error', text: 'Failed to disconnect' });
    }
  };

  const removeLink = async (projectId: string) => {
    try {
      const stored = await chrome.storage.local.get('linkConfigs');
      const configs = stored.linkConfigs || {};
      delete configs[projectId];
      await chrome.storage.local.set({ linkConfigs: configs });
      setLinkedProjects(prev => prev.filter(p => p.overleafProjectId !== projectId));
      // Also remove the manifest
      await chrome.storage.local.remove(`syncManifest_${projectId}`);
      setStatusMessage({ type: 'success', text: 'Link removed' });
      setTimeout(() => setStatusMessage(null), 2500);
    } catch (err) {
      setStatusMessage({ type: 'error', text: 'Failed to remove link' });
    }
  };

  return (
    <div className="options-page">
      {/* Header */}
      <div className="page-header">
        <div className="page-icon"><LeafIcon /></div>
        <div className="page-heading">
          <h1>Gitleaf Settings</h1>
          <p>Manage your Overleaf ↔ GitHub connections</p>
        </div>
      </div>

      {/* Tab Navigation */}
      <nav className="tab-nav">
        {(['account', 'projects', 'settings'] as const).map(tab => (
          <button
            key={tab}
            className={`tab-btn${activeTab === tab ? ' tab-btn--active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'account' ? 'Account' : tab === 'projects' ? 'Linked Projects' : 'Settings'}
          </button>
        ))}
      </nav>

      {/* Status Message */}
      {statusMessage && (
        <div className={`alert alert--${statusMessage.type}`} style={{ marginBottom: 20 }}>
          {statusMessage.text}
        </div>
      )}

      {/* Tab: Account */}
      {activeTab === 'account' && (
        <div className="panel">
          <div className="panel-header">
            <h2>GitHub Account</h2>
            <p>Manage your GitHub connection and authentication.</p>
          </div>
          <div className="panel-body">
            {authenticated ? (
              <>
                <div className="account-card">
                  <div className="account-avatar">
                    {githubLogin?.charAt(0).toUpperCase() || 'G'}
                  </div>
                  <div className="account-info">
                    <strong>{githubLogin || 'Connected'}</strong>
                    <span>Authenticated with GitHub</span>
                  </div>
                  <span className="status-badge status-badge--connected">
                    <span className="status-dot" />
                    Connected
                  </span>
                </div>
                <button onClick={disconnectAccount} className="btn btn-danger">
                  Disconnect
                </button>
              </>
            ) : (
              <>
                <div className="account-card">
                  <div className="account-avatar"><GitHubIcon /></div>
                  <div className="account-info">
                    <strong>Not connected</strong>
                    <span>Add your Personal Access Token from the popup to get started.</span>
                  </div>
                  <span className="status-badge status-badge--disconnected">
                    <span className="status-dot" />
                    Disconnected
                  </span>
                </div>
                <p style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.4 }}>
                  Open an Overleaf project and click the Gitleaf extension icon to enter your
                  GitHub Personal Access Token.
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {/* Tab: Linked Projects */}
      {activeTab === 'projects' && (
        <div className="panel">
          <div className="panel-header">
            <h2>Linked Projects</h2>
            <p>Overleaf projects connected to GitHub repositories.</p>
          </div>
          <div className="panel-body">
            {linkedProjects.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon"><EmptyFolderIcon /></div>
                <p>No projects linked yet. Open an Overleaf project and use the extension popup to link it.</p>
              </div>
            ) : (
              linkedProjects.map(project => (
                <div key={project.overleafProjectId} className="linked-item">
                  <div className="linked-item-icon">
                    <LinkIcon />
                  </div>
                  <div className="linked-item-info">
                    <strong>
                      {project.overleafProjectName || project.overleafProjectId.slice(0, 8)}
                    </strong>
                    <span>
                      {project.github.owner}/{project.github.repo} — {project.github.branch}
                      {project.github.subPath ? ` / ${project.github.subPath}` : ''}
                    </span>
                  </div>
                  <button
                    className="btn btn-danger"
                    onClick={() => removeLink(project.overleafProjectId)}
                    style={{ flexShrink: 0 }}
                  >
                    <UnlinkIcon />
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Tab: Settings */}
      {activeTab === 'settings' && (
        <div className="panel">
          <div className="panel-header">
            <h2>Sync Settings</h2>
            <p>Configure default sync behavior and ignore rules.</p>
          </div>

          <div className="panel-section">
            <h3>Default Branch</h3>
            <p>Default branch name when linking a new project.</p>
            <div className="form-group">
              <input
                type="text"
                className="form-control"
                value={defaultBranch}
                onChange={(e) => setDefaultBranch(e.target.value)}
                placeholder="main"
                style={{ maxWidth: 200 }}
              />
            </div>
          </div>

          <div className="panel-section">
            <h3>Ignore Patterns</h3>
            <p>One pattern per line, gitignore-style. Files matching these patterns are excluded from sync.</p>
            <div className="form-group">
              <textarea
                className="form-control"
                value={ignorePatterns}
                onChange={(e) => setIgnorePatterns(e.target.value)}
                placeholder={[
                  '*.log',
                  '.vscode/',
                  '__pycache__/',
                  '.DS_Store',
                  'output/',
                ].join('\n')}
              />
            </div>
          </div>

          <div className="panel-section" style={{ paddingBottom: 24 }}>
            <button onClick={saveSettings} className="btn btn-primary">
              Save Settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// Mount
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<Options />);
}
