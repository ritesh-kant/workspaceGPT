import React, { useRef, useState } from 'react';
import { answerQuestion, RagStatus } from '../lib/ragService';
import { loadSettings } from '../lib/storage';
import Settings from './Settings';

interface ChatMessage {
  role: 'user' | 'assistant' | 'error';
  content: string;
}

const STATUS_LABEL: Record<RagStatus, string> = {
  searching: 'Searching your workspace…',
  'searching-deeper': 'Searching more deeply…',
  generating: 'Generating answer…',
};

const App: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<RagStatus | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const send = async () => {
    const question = input.trim();
    if (!question || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: question }, { role: 'assistant', content: '' }]);
    setBusy(true);
    setStatus(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const settings = await loadSettings();
      for await (const chunk of answerQuestion(
        settings,
        question,
        ['CONFLUENCE', 'ADO'],
        controller.signal,
        setStatus,
      )) {
        // First token arrived — retrieval/generation phase is over.
        setStatus(null);
        setMessages((m) => {
          const next = [...m];
          next[next.length - 1] = {
            role: 'assistant',
            content: next[next.length - 1].content + chunk,
          };
          return next;
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((m) => {
        const next = [...m];
        // Replace the empty assistant placeholder with the error.
        next[next.length - 1] = { role: 'error', content: msg };
        return next;
      });
    } finally {
      setBusy(false);
      setStatus(null);
      abortRef.current = null;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className='app'>
      <div className='header'>
        <h1>WorkspaceGPT</h1>
        <button
          className='icon-button'
          onClick={() => setShowSettings((s) => !s)}
          title='Settings'
        >
          {showSettings ? '✕' : '⚙'}
        </button>
      </div>

      {showSettings ? (
        <Settings onClose={() => setShowSettings(false)} />
      ) : (
        <>
          <div className='messages'>
            {messages.length === 0 && (
              <div className='empty'>
                Ask a question about your Confluence or Azure DevOps knowledge.
              </div>
            )}
            {messages.map((m, i) => {
              const isLast = i === messages.length - 1;
              if (!m.content && busy && isLast) {
                return (
                  <div key={i} className={`message ${m.role} pending`}>
                    {status ? STATUS_LABEL[status] : '…'}
                  </div>
                );
              }
              return (
                <div key={i} className={`message ${m.role}`}>
                  {m.content}
                </div>
              );
            })}
          </div>

          <div className='composer'>
            <textarea
              rows={2}
              value={input}
              placeholder='Ask anything…'
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <button className='primary-button' onClick={send} disabled={busy || !input.trim()}>
              {busy ? '…' : 'Send'}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default App;
