import React, { useCallback, useEffect, useRef, useState } from 'react';
import { askDesktop, TabRef } from '../lib/desktopChat';
import { BRIDGE_STATUS_KEY, BridgeStatus, CHAT_PORT_NAME } from '../lib/bridgeShared';
import { deleteChat, listChats, saveChat, StoredChat } from '../lib/history';
import Markdown from './Markdown';
import Settings from './Settings';

interface ChatMessage {
  role: 'user' | 'assistant' | 'error';
  content: string;
  /** The page this question was asked about. */
  tab?: { title: string; url: string };
}

const STARTERS = [
  'What changed in our docs this week?',
  'Who owns the payments service?',
  'How do we deploy to staging?',
];

type Link = 'connecting' | 'connected' | 'offline';

/** Whether WorkspaceGPT Desktop is reachable, kept live from what the service worker records. */
function useDesktopLink(): Link {
  const [link, setLink] = useState<Link>('connecting');

  useEffect(() => {
    const read = (s: { [key: string]: any }) => {
      const status = s[BRIDGE_STATUS_KEY] as BridgeStatus | undefined;
      setLink(!status ? 'connecting' : status.connected ? 'connected' : 'offline');
    };
    chrome.storage.local.get(BRIDGE_STATUS_KEY).then(read);
    const onChange = (_: unknown, area: string) => {
      if (area === 'local') chrome.storage.local.get(BRIDGE_STATUS_KEY).then(read);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  // Ask the worker to connect now, and keep nudging while the desktop is not there.
  useEffect(() => {
    if (link === 'connected') return;
    const nudge = () => {
      const port = chrome.runtime.connect({ name: CHAT_PORT_NAME });
      port.postMessage({ id: 0, method: 'connect' });
      setTimeout(() => port.disconnect(), 500);
    };
    nudge();
    const t = setInterval(nudge, 4000);
    return () => clearInterval(t);
  }, [link]);

  return link;
}

/** The tab the user is looking at, kept live — or null when it is not a page the agent can read. */
function useActiveTab(): TabRef | null {
  const [tab, setTab] = useState<TabRef | null>(null);

  useEffect(() => {
    const refresh = async () => {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      // chrome://, the Web Store and the like cannot be read, so there is nothing to offer.
      setTab(t?.id != null && t.url && /^https?:/i.test(t.url) ? { id: t.id, title: t.title || t.url, url: t.url } : null);
    };
    void refresh();
    const onUpdated = (_id: number, info: chrome.tabs.TabChangeInfo) => {
      if (info.url || info.title || info.status === 'complete') void refresh();
    };
    chrome.tabs.onActivated.addListener(refresh);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onFocusChanged.addListener(refresh);
    return () => {
      chrome.tabs.onActivated.removeListener(refresh);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onFocusChanged.removeListener(refresh);
    };
  }, []);

  return tab;
}

const Icon: React.FC<{ d: string }> = ({ d }) => (
  <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
    <path d={d} />
  </svg>
);
const ICONS = {
  plus: 'M12 5v14M5 12h14',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  back: 'M15 18l-6-6 6-6',
  up: 'M12 19V5M5 12l7-7 7 7',
  clock: 'M12 6v6l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  x: 'M18 6L6 18M6 6l12 12',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
};

const LINK_LABEL: Record<Link, string> = {
  connecting: 'Connecting to WorkspaceGPT Desktop…',
  connected: 'Connected to WorkspaceGPT Desktop',
  offline: 'WorkspaceGPT Desktop is not running',
};

const ago = (t: number): string => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : new Date(t).toLocaleDateString();
};

const History: React.FC<{ onOpen: (chat: StoredChat) => void }> = ({ onOpen }) => {
  const [chats, setChats] = useState<StoredChat[] | null>(null);
  useEffect(() => {
    void listChats().then(setChats);
  }, []);
  if (!chats) return <div className='history' />;
  if (!chats.length) {
    return (
      <div className='history'>
        <p className='history-empty'>No conversations yet. Your questions will be listed here.</p>
      </div>
    );
  }
  return (
    <div className='history'>
      {chats.map((c) => (
        <div key={c.id} className='history-row'>
          <button className='history-open' onClick={() => onOpen(c)}>
            <span className='history-title'>{c.title}</span>
            <span className='history-time'>{ago(c.updatedAt)}</span>
          </button>
          <button
            className='icon-button'
            title='Delete'
            aria-label='Delete conversation'
            onClick={() => {
              setChats((cur) => cur?.filter((x) => x.id !== c.id) ?? null);
              void deleteChat(c.id);
            }}
          >
            <Icon d={ICONS.x} />
          </button>
        </div>
      ))}
    </div>
  );
};

const App: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [view, setView] = useState<'chat' | 'history' | 'settings'>('chat');
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // One desktop chat session per conversation, so follow-ups keep their context.
  const sessionRef = useRef<string>(crypto.randomUUID());
  // Set when a conversation was reopened from history: its first question re-seeds the desktop.
  const resumeRef = useRef(false);
  const link = useDesktopLink();
  const activeTab = useActiveTab();
  // The page the user took out of the context with the ×. Switching to another page brings the bar back.
  const [removedUrl, setRemovedUrl] = useState<string | null>(null);
  const readTab = !!activeTab && activeTab.url !== removedUrl;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, status]);

  // Grow the box with its text, up to a few lines. Re-measured when the panel is resized: it is
  // laid out at near-zero width while Chrome slides it open, which would size the box for a column of letters.
  useEffect(() => {
    const fit = () => {
      const el = inputRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [input, view]);

  // Keep the conversation in history once a turn has finished.
  useEffect(() => {
    if (!busy && messages.length) void saveChat(sessionRef.current, messages);
  }, [busy, messages]);

  const setLast = (update: (m: ChatMessage) => ChatMessage) =>
    setMessages((m) => [...m.slice(0, -1), update(m[m.length - 1])]);

  const send = useCallback(
    async (text?: string) => {
      const question = (text ?? input).trim();
      if (!question || busy) return;
      setInput('');
      const tab = readTab ? activeTab : null;
      setMessages((m) => [
        ...m,
        { role: 'user', content: question, ...(tab ? { tab: { title: tab.title, url: tab.url } } : {}) },
        { role: 'assistant', content: '' },
      ]);
      setBusy(true);
      setStatus(null);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const history = resumeRef.current
          ? messages.filter((m) => m.role !== 'error' && m.content).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
          : undefined;
        resumeRef.current = false;
        for await (const e of askDesktop(sessionRef.current, question, { signal: controller.signal, history, ...(tab ? { tab } : {}) })) {
          if (e.kind === 'status') setStatus(e.text);
          else if (e.kind === 'restart') setLast(() => ({ role: 'assistant', content: '' }));
          else if (e.kind === 'chunk') {
            setStatus(null);
            setLast((m) => ({ role: 'assistant', content: m.content + e.text }));
          } else if (e.kind === 'done') {
            if (e.text) setLast((m) => (m.content ? m : { role: 'assistant', content: e.text! }));
          } else if (e.kind === 'error') setLast(() => ({ role: 'error', content: e.message }));
        }
      } finally {
        // A stopped run with nothing yet leaves an empty bubble — drop it.
        setMessages((m) => (m.length && m[m.length - 1].role === 'assistant' && !m[m.length - 1].content ? m.slice(0, -1) : m));
        setBusy(false);
        setStatus(null);
        abortRef.current = null;
        inputRef.current?.focus();
      }
    },
    [input, busy, messages, readTab, activeTab],
  );

  const newChat = () => {
    abortRef.current?.abort();
    sessionRef.current = crypto.randomUUID();
    resumeRef.current = false;
    setMessages([]);
    setInput('');
  };

  const openChat = (chat: StoredChat) => {
    abortRef.current?.abort();
    sessionRef.current = chat.id;
    resumeRef.current = true;
    setMessages(chat.messages);
    setInput('');
    setView('chat');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const unavailable = link === 'offline';

  return (
    <div className='app'>
      <header className='header'>
        {view !== 'chat' ? (
          <button className='icon-button' onClick={() => setView('chat')} title='Back' aria-label='Back'>
            <Icon d={ICONS.back} />
          </button>
        ) : (
          <img className='logo' src='/icon.png' alt='' />
        )}
        <h1>{view === 'settings' ? 'Settings' : view === 'history' ? 'History' : 'WorkspaceGPT'}</h1>
        {view === 'chat' && <span className={`dot ${link}`} title={LINK_LABEL[link]} aria-label={LINK_LABEL[link]} />}
        <span className='spacer' />
        {view === 'chat' && (
          <>
            <button className='icon-button' onClick={newChat} title='New chat' aria-label='New chat' disabled={!messages.length}>
              <Icon d={ICONS.plus} />
            </button>
            <button className='icon-button' onClick={() => setView('history')} title='History' aria-label='History'>
              <Icon d={ICONS.clock} />
            </button>
            <button className='icon-button' onClick={() => setView('settings')} title='Settings' aria-label='Settings'>
              <Icon d={ICONS.gear} />
            </button>
          </>
        )}
      </header>

      {view === 'settings' ? (
        <Settings onClose={() => setView('chat')} />
      ) : view === 'history' ? (
        <History onOpen={openChat} />
      ) : (
        <>
          <div className='messages'>
            {messages.length === 0 ? (
              <div className='welcome'>
                <img className='welcome-logo' src='/icon.png' alt='' />
                <h2>What do you want to know?</h2>
                <p>Ask about your Confluence, Jira and Azure DevOps Knowledge.</p>
                {unavailable ? (
                  <div className='notice'>
                    <strong>WorkspaceGPT Desktop is not running</strong>
                    <span>Open the app and this panel connects by itself.</span>
                  </div>
                ) : (
                  <div className='starters'>
                    {STARTERS.map((s) => (
                      <button key={s} className='starter' onClick={() => void send(s)} disabled={link !== 'connected'}>
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              messages.map((m, i) => {
                const pending = busy && i === messages.length - 1 && !m.content && m.role === 'assistant';
                if (pending) {
                  return (
                    <div key={i} className='message assistant thinking'>
                      <span className='typing'>
                        <i />
                        <i />
                        <i />
                      </span>
                      {status && <span className='thinking-text'>{status}</span>}
                    </div>
                  );
                }
                return (
                  <div key={i} className={`message ${m.role}`}>
                    {m.role === 'assistant' ? <Markdown>{m.content}</Markdown> : m.content}
                    {m.tab && (
                      <div className='message-tab' title={m.tab.url}>
                        Read: {m.tab.title}
                      </div>
                    )}
                  </div>
                );
              })
            )}
            <div ref={endRef} />
          </div>

          <div className='composer'>
            {activeTab &&
              (readTab ? (
                <div className='tab-bar on' title={activeTab.url}>
                  <Icon d={ICONS.eye} />
                  <span className='tab-bar-text'>
                    <span className='tab-bar-label'>Reading this tab</span>
                    <span className='tab-bar-title'>{activeTab.title}</span>
                  </span>
                  <button className='icon-button' onClick={() => setRemovedUrl(activeTab.url)} title='Remove this page from the context' aria-label='Remove this page from the context'>
                    <Icon d={ICONS.x} />
                  </button>
                </div>
              ) : (
                <button className='tab-bar add' onClick={() => setRemovedUrl(null)} title={activeTab.url}>
                  <Icon d={ICONS.plus} />
                  <span className='tab-bar-text'>
                    <span className='tab-bar-title'>Add this page to the context</span>
                  </span>
                </button>
              ))}
            <div className={`composer-box${unavailable ? ' disabled' : ''}`}>
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                placeholder={unavailable ? 'Waiting for WorkspaceGPT Desktop…' : 'Ask anything…'}
                disabled={unavailable}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
              />
              {busy ? (
                <button className='send stop' onClick={() => abortRef.current?.abort()} title='Stop' aria-label='Stop'>
                  <span />
                </button>
              ) : (
                <button className='send' onClick={() => void send()} disabled={!input.trim() || unavailable} title='Send' aria-label='Send'>
                  <Icon d={ICONS.up} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default App;
