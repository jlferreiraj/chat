import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

function useDarkMode() {
  const [dark, setDark] = useState(() => {
    if (typeof window === 'undefined') return false;
    const saved = localStorage.getItem('theme');
    if (saved) return saved === 'dark';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    const cls = document.documentElement.classList;
    if (dark) {
      cls.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      cls.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [dark]);

  return [dark, setDark];
}

async function streamChat(messages, { model = 'gpt-4o-mini', temperature = 0.2, onToken }) {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, model, temperature }),
  });

  if (!res.body) throw new Error('No stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = block.trim().split('\n');
      const eventLine = lines.find(l => l.startsWith('event:'));
      const dataLine = lines.find(l => l.startsWith('data:')) || 'data: {}';
      if (!eventLine) continue;
      const event = eventLine.slice(6).trim();
      const data = JSON.parse(dataLine.slice(5).trim() || '{}');
      if (event === 'token') {
        onToken?.(data.content || '');
      }
      if (event === 'done') {
        return;
      }
      if (event === 'error') {
        throw new Error(data.error || 'Stream error');
      }
    }
  }
}

function Message({ role, content }) {
  const isUser = role === 'user';
  return (
    <div className={`w-full flex ${isUser ? 'justify-end' : 'justify-start'} my-2`}>
      <div className={`${isUser ? 'bg-blue-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-100'} max-w-[70%] rounded-lg px-3 py-2 whitespace-pre-wrap break-words`}> 
        <div className="text-xs opacity-70 mb-1">{isUser ? 'Você' : 'Assistente'}</div>
        <div>{content || ''}</div>
      </div>
    </div>
  );
}

export default function App() {
  const [dark, setDark] = useDarkMode();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const containerRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const onSubmit = useCallback(async (e) => {
    e?.preventDefault();
    if (!input.trim() || busy) return;

    const next = [...messages, { role: 'user', content: input.trim() }, { role: 'assistant', content: '' }];
    setMessages(next);
    setInput('');
    setBusy(true);

    try {
      await streamChat(next.slice(0, -1), {
        onToken: (tok) => {
          setMessages(prev => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === 'assistant') {
              last.content = (last.content || '') + tok;
            }
            return copy;
          });
        },
      });
    } catch (e) {
      setMessages(prev => [...prev, { role: 'system', content: `Erro: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }, [input, messages, busy]);

  const handleSearch = useCallback(async () => {
    const q = prompt('Padrão para /api/tools grep:');
    if (!q) return;
    const res = await fetch('/api/tools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'grep', args: { pattern: q } }) });
    const data = await res.json();
    if (data?.ok) {
      const text = data.result.map(r => `${r.file}:${r.line}: ${r.text}`).join('\n');
      setMessages(prev => [...prev, { role: 'system', content: `grep(${q}):\n${text}` }]);
    } else {
      alert('Erro no grep: ' + (data?.error || 'desconhecido'));
    }
  }, []);

  return (
    <div className="h-full bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100 flex flex-col">
      <header className="border-b border-zinc-200 dark:border-zinc-800 px-4 py-2 flex items-center justify-between">
        <h1 className="font-semibold">AI Chat</h1>
        <div className="flex items-center gap-2">
          <button className="text-sm px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={handleSearch}>/grep</button>
          <button
            className="text-sm px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            onClick={() => setDark(!dark)}
            aria-label="Alternar tema"
          >{dark ? 'Light' : 'Dark'}</button>
        </div>
      </header>

      <main ref={containerRef} className="flex-1 overflow-auto p-4 space-y-2">
        {messages.map((m, i) => (
          <Message key={i} role={m.role} content={m.content} />
        ))}
        {busy && <div className="text-sm opacity-70">Gerando resposta...</div>}
      </main>

      <form onSubmit={onSubmit} className="border-t border-zinc-200 dark:border-zinc-800 p-3">
        <div className="max-w-4xl mx-auto flex gap-2">
          <input
            className="flex-1 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 outline-none"
            placeholder="Pergunte sobre o código, arquitetura, segurança..."
            value={input}
            onChange={e => setInput(e.target.value)}
            disabled={busy}
          />
          <button
            className="rounded bg-blue-600 text-white px-4 py-2 disabled:opacity-50"
            type="submit"
            disabled={busy}
          >Enviar</button>
        </div>
      </form>
    </div>
  );
}
