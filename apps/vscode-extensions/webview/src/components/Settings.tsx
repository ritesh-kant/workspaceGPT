import React, { useEffect, useState } from 'react';
import { clearVSCodeState, isDesktopHost, VSCodeAPI } from '../vscode';
import './Settings.css';
import { useSettingsStore, useChatStore, useModelActions, useUiStore } from '../store';
import { MESSAGE_TYPES } from '../constants';
import { clearStatusMessageAfterDelay } from './settings/utils';
import ModeSelector from './settings/ModeSelector';
import ModelSettings from './settings/ModelSettings';
import RemoteAccountSettings from './settings/RemoteAccountSettings';
import ConfluenceSettings from './settings/ConfluenceSettings';
import AdoSettings from './settings/AdoSettings';
import JiraSettings from './settings/JiraSettings';
import WebSearchSettings from './settings/WebSearchSettings';
import DeploymentSettings from './settings/DeploymentSettings';
import McpSettings from './settings/McpSettings';
import SectionShell, { SettingsLayoutContext } from './settings/SectionShell';
import StatusDot from './settings/StatusDot';
import { KNOWLEDGE_SOURCES, KnowledgeSourcesOverview } from './settings/knowledgeSources';
import { SettingsButtonProps } from '../types';

/**
 * One page of the desktop's settings (the `page` layout). The VS Code
 * sidebar keeps the single stacked column below; the desktop has the width for
 * a nav column plus a page, the way Cline and the OS settings apps lay it out.
 * Top-level pages sit in the nav; a knowledge source's page has Knowledge as
 * its `parent` and is listed beneath it in the nav as well as on its overview.
 */
interface SettingsPage {
  id: string;
  label: string;
  /** One line under the page heading: what this page is for. */
  description: string;
  badge?: React.ReactNode;
  /** The page this one is a detail of; it gets a back link and is nested under the parent in the nav. */
  parent?: string;
  /** The page's sections, each a SectionShell rendered as a card. */
  render: () => React.ReactNode;
}

const KNOWLEDGE_PAGE = 'knowledge';

const PAGE_KEY = 'workspacegpt.settingsPage';

function readStoredPage(): string | null {
  try {
    return localStorage.getItem(PAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredPage(id: string): void {
  try {
    localStorage.setItem(PAGE_KEY, id);
  } catch {
    // Non-persistent storage: the selection still holds for this visit.
  }
}

const SettingsButton: React.FC<SettingsButtonProps> = ({
  isVisible,
  onBack,
}) => {
  const {
    config,
    batchUpdateConfig,
    resetStore: resetSettingStore,
  } = useSettingsStore();

  const { resetStore: resetModelStore } = useModelActions();
  const { resetStore: resetChatStore } = useChatStore();

  const vscode = VSCodeAPI();

  const isRemote = config.mode === 'remote';

  const [isBetaOpen, setIsBetaOpen] = useState(
    () => !!config.deployment?.isDeploymentEnabled
  );
  const [confirmingReset, setConfirmingReset] = useState(false);

  // Decided once per mount: the host does not change under a running page.
  const [layout] = useState(() => (isDesktopHost() ? 'page' : 'stack'));
  // A page asked for by whoever opened Settings (a Knowledge chip on the home
  // screen, a host message) wins over the remembered one, once.
  const { settingsPage: requestedPage, clearSettingsPage } = useUiStore();
  const [pageId, setPageId] = useState<string | null>(() => requestedPage ?? readStoredPage());
  useEffect(() => {
    if (!requestedPage) return;
    setPageId(requestedPage);
    writeStoredPage(requestedPage);
    clearSettingsPage();
  }, [requestedPage, clearSettingsPage]);

  // If the beta feature is already enabled (e.g. settings finish loading
  // after this component mounts), expand the section so it isn't hidden.
  useEffect(() => {
    if (config.deployment?.isDeploymentEnabled) {
      setIsBetaOpen(true);
    }
  }, [config.deployment?.isDeploymentEnabled]);

  const resetSection = (
    <SectionShell storageKey='advanced' title='Advanced'>
      <div className='settings-form'>
        <div className='danger-zone'>
          <div className='danger-zone-text'>
            <span className='danger-zone-title'>Reset WorkspaceGPT</span>
            <span className='danger-zone-desc'>
              Clears connections, API keys, indexed sources and chat history on this machine.
            </span>
          </div>
          <button type='button' className='danger-button danger-button--small' onClick={() => setConfirmingReset(true)}>
            Reset
          </button>
        </div>
      </div>
    </SectionShell>
  );

  const selectPage = (id: string) => {
    setPageId(id);
    writeStoredPage(id);
  };

  // Same sections as the stacked column below; only the framing differs.
  // Mode, the mode-dependent Account/Model card and Reset share one General
  // page: alone, each was a heading over a single control. The knowledge
  // sources are the product: Knowledge is their overview, and every source has
  // its own page beneath it (settings/knowledgeSources.tsx). No MCP Server
  // page: it registers WorkspaceGPT in the editor's MCP config, and the
  // desktop host has no editor. It stays in the stack below.
  const pages: SettingsPage[] = [
    {
      id: 'general',
      label: 'General',
      description: isRemote
        ? 'Where answers come from, the account they are billed to, and a reset for this machine.'
        : 'Where answers come from, the model that produces them, and a reset for this machine.',
      render: () => (
        <>
          <ModeSelector />
          {isRemote ? <RemoteAccountSettings /> : <ModelSettings />}
          {resetSection}
        </>
      ),
    },
    {
      id: KNOWLEDGE_PAGE,
      label: 'Knowledge',
      description:
        'WorkspaceGPT answers from your organisation’s own systems. Connect the ones your team works in; every answer is grounded in them and cites them.',
      render: () => <KnowledgeSourcesOverview config={config} onOpen={selectPage} />,
    },
    ...KNOWLEDGE_SOURCES.map(
      (item): SettingsPage => ({
        id: item.id,
        label: item.label,
        description: item.description,
        parent: KNOWLEDGE_PAGE,
        render: item.render,
      })
    ),
    {
      id: 'deployment',
      label: 'Deployment pipeline',
      description: 'Automate release configuration and hotfix branches across your repositories, driven from a roster, a file or Jira.',
      badge: <span className='beta-badge'>Beta</span>,
      render: () => <DeploymentSettings />,
    },
  ];
  // A remembered page that no longer exists falls back to the first one
  // rather than an empty pane.
  const currentPage = pages.find((p) => p.id === pageId) ?? pages[0];
  const parentPage = currentPage.parent ? pages.find((p) => p.id === currentPage.parent) : undefined;

  function reset() {
    setConfirmingReset(false);
    clearVSCodeState();
    // Reset all store states
    resetSettingStore();
    resetModelStore();
    resetChatStore();
    batchUpdateConfig('confluence', {
      messageType: 'success',
      statusMessage: 'VSCode state reset successfully',
    });
    // Clear the success message after 2 seconds
    clearStatusMessageAfterDelay('confluence');
    vscode.postMessage({
      type: MESSAGE_TYPES.RESET,
    });
  }
  if (!isVisible) return null;

  const resetDialog = confirmingReset && (
    <div className='mode-confirm-overlay' role='dialog' aria-modal='true'>
      <div className='mode-confirm-dialog'>
        <p>
          Reset WorkspaceGPT? This clears your connections, API keys, indexed
          sources, and chat history on this machine. It cannot be undone.
        </p>
        <div className='mode-confirm-actions'>
          <button
            type='button'
            className='secondary-button'
            onClick={() => setConfirmingReset(false)}
          >
            Cancel
          </button>
          <button type='button' className='danger-button' onClick={reset}>
            Reset everything
          </button>
        </div>
      </div>
    </div>
  );

  if (layout === 'page') {
    const navItem = (page: SettingsPage, dot?: 'ok' | 'warn') => {
      const active = page.id === currentPage.id;
      return (
        <button
          key={page.id}
          type='button'
          className={`settings-nav-item${page.parent ? ' settings-nav-item--sub' : ''}${active ? ' settings-nav-item--active' : ''}`}
          aria-current={active ? 'page' : undefined}
          onClick={() => selectPage(page.id)}
        >
          <span className='settings-nav-label'>{page.label}</span>
          {page.badge}
          {dot && <StatusDot tone={dot} />}
        </button>
      );
    };
    return (
      <div className='settings-panel settings-panel--nav'>
        <nav className='settings-nav' aria-label='Settings sections'>
          <div className='settings-nav-head'>
            <button className='back-button' onClick={onBack} aria-label='Back to chat' title='Back to chat'>
              ←
            </button>
            <h3>Settings</h3>
          </div>
          {/* Every source is listed under Knowledge, connected or not: the
              connection state is the dot, not whether the row exists. */}
          {pages
            .filter((page) => !page.parent)
            .map((page) => (
              <React.Fragment key={page.id}>
                {navItem(page)}
                {pages
                  .filter((sub) => sub.parent === page.id)
                  .map((sub) =>
                    navItem(sub, KNOWLEDGE_SOURCES.find((s) => s.id === sub.id)?.status(config).tone)
                  )}
              </React.Fragment>
            ))}
        </nav>
        <div className='settings-page' key={currentPage.id}>
          <div className='settings-page-inner'>
            <header className='settings-page-head'>
              {parentPage && (
                <button type='button' className='settings-page-back' onClick={() => selectPage(parentPage.id)}>
                  ‹ {parentPage.label}
                </button>
              )}
              <h2>
                {currentPage.label}
                {currentPage.badge}
              </h2>
              <p>{currentPage.description}</p>
            </header>
            <div className='settings-page-cards'>
              <SettingsLayoutContext.Provider value={{ layout: 'page', pageTitle: currentPage.label }}>
                {currentPage.render()}
              </SettingsLayoutContext.Provider>
            </div>
          </div>
        </div>
        {resetDialog}
      </div>
    );
  }

  return (
    <div className='settings-panel'>
      <div className='settings-header'>
        <div className='header-with-back'>
          <button className='back-button' onClick={onBack} aria-label='Go back'>
            ←
          </button>
          <h3>Settings</h3>
        </div>
      </div>

      <div className='settings-stack'>
        <ModeSelector />

        {isRemote && <RemoteAccountSettings />}

        {!isRemote && <ModelSettings />}

        {/* The two knowledge sources sit together: ADO feeds "Your work" on the
            home view, so it is core surface area, not a beta experiment. */}
        <ConfluenceSettings />

        <AdoSettings />

        <JiraSettings />

        <WebSearchSettings />

        <div className='beta-section'>
          <button
            type='button'
            className='beta-section-header'
            onClick={() => setIsBetaOpen((open) => !open)}
            aria-expanded={isBetaOpen}
            aria-label='Beta features'
          >
            <h3>
              Beta Features <span className='beta-badge'>Beta</span>
            </h3>
            <span className='trigger-arrow'>{isBetaOpen ? '▲' : '▼'}</span>
          </button>
          {isBetaOpen && (
            <div className='beta-section-body'>
              <DeploymentSettings />
            </div>
          )}
        </div>

        <McpSettings />

        {/* Reset used to be a full-width red button at the foot of every
            Settings visit. It is a once-in-a-blue-moon recovery action, so it
            lives behind a collapsed section with the confirm dialog below. */}
        {resetSection}
      </div>

      {/* Reset wipes every connection, key, and chat with no undo — at least as
          consequential as switching modes, which has always confirmed. */}
      {resetDialog}
    </div>
  );
};

export default SettingsButton;
