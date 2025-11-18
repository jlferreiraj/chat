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

function useLocalStorage(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback((v) => {
    setValue(v);
    try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
  }, [key]);
  return [value, set];
}

async function streamChat(messages, { model = 'gpt-4o-mini', temperature = 0.1, onToken }) {
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

  const [model, setModel] = useLocalStorage('model', 'gpt-4o-mini');
  const [temperature, setTemperature] = useLocalStorage('temperature', 0.1);

  const [showFiles, setShowFiles] = useState(false);
  const [fileTree, setFileTree] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState('');

  const [showDiff, setShowDiff] = useState(false);
  const [diffData, setDiffData] = useState(null);
  const [diffApproving, setDiffApproving] = useState(false);

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
        model,
        temperature,
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
  }, [input, messages, busy, model, temperature]);

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

  const loadFileTree = useCallback(async (dir = '.') => {
    try {
      const res = await fetch('/api/tools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'list_dir', args: { path: dir } }) });
      const data = await res.json();
      if (data?.ok) {
        setFileTree(data.result || []);
      }
    } catch (e) {
      console.error(e);
    }
  }, []);

  const openFile = useCallback(async (path) => {
    try {
      const res = await fetch('/api/tools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'read_file', args: { path } }) });
      const data = await res.json();
      if (data?.ok) {
        setSelectedFile(path);
        setFileContent(data.result?.content || '');
      } else {
        alert('Erro ao ler: ' + (data?.error || 'desconhecido'));
      }
    } catch (e) {
      console.error(e);
    }
  }, []);

  const requestWriteFile = useCallback(async (path, content) => {
    try {
      const res = await fetch('/api/tools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'write_file', args: { path, content, approve: false } }) });
      const data = await res.json();
      if (data?.ok && data.result?.dryRun) {
        setDiffData({ type: 'write', path, content, diff: data.result.diff });
        setShowDiff(true);
      }
    } catch (e) {
      console.error(e);
    }
  }, []);

  const approveDiff = useCallback(async () => {
    if (!diffData) return;
    setDiffApproving(true);
    try {
      const res = await fetch('/api/tools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'write_file', args: { path: diffData.path, content: diffData.content, approve: true } }) });
      const data = await res.json();
      if (data?.ok) {
        setMessages(prev => [...prev, { role: 'system', content: `✅ Aplicado: ${diffData.path}` }]);
        setShowDiff(false);
        setDiffData(null);
      } else {
        alert('Erro ao aplicar: ' + (data?.error || 'desconhecido'));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setDiffApproving(false);
    }
  }, [diffData]);

  useEffect(() => {
    if (showFiles && !fileTree.length) loadFileTree();
  }, [showFiles, fileTree.length, loadFileTree]);

  return (
    <div className="h-full bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100 flex flex-col">
      <header className="border-b border-zinc-200 dark:border-zinc-800 px-4 py-2 flex items-center justify-between flex-wrap gap-2">
        <h1 className="font-semibold">AI Chat</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={model} onChange={e => setModel(e.target.value)} className="text-sm px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800">
            <option value="gpt-4o-mini">gpt-4o-mini</option>
            <option value="gpt-4o">gpt-4o</option>
            <option value="llama-3.1-70b-instruct">llama-3.1-70b</option>
            <option value="qwen2.5-coder-32b">qwen2.5-coder-32b</option>
            <option value="deepseek-coder-33b">deepseek-coder-33b</option>
          </select>
          <label className="text-xs flex items-center gap-1">
            Temp:
            <input type="number" min="0" max="2" step="0.1" value={temperature} onChange={e => setTemperature(parseFloat(e.target.value))} className="w-14 px-1 py-1 text-sm rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800" />
          </label>
          <button className="text-sm px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => setShowFiles(!showFiles)}>{showFiles ? 'Ocultar' : 'Arquivos'}</button>
          <button className="text-sm px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={handleSearch}>/grep</button>
          <button
            className="text-sm px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            onClick={() => setDark(!dark)}
            aria-label="Alternar tema"
          >{dark ? 'Light' : 'Dark'}</button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {showFiles && (
          <aside className="w-64 border-r border-zinc-200 dark:border-zinc-800 overflow-auto p-2">
            <div className="text-xs font-semibold mb-2 flex items-center justify-between">
              <span>Workspace</span>
              <button onClick={() => loadFileTree()} className="text-blue-600 dark:text-blue-400 hover:underline">↻</button>
            </div>
            <ul className="space-y-1">
              {fileTree.map((item, i) => (
                <li key={i}>
                  {item.type === 'dir' ? (
                    <div className="text-sm font-medium opacity-70">{item.name}/</div>
                  ) : (
                    <button onClick={() => openFile(item.name)} className="text-sm hover:underline text-left w-full">{item.name}</button>
                  )}
                </li>
              ))}
            </ul>
            {selectedFile && (
              <div className="mt-4 border-t border-zinc-300 dark:border-zinc-700 pt-2">
                <div className="text-xs font-semibold mb-1">{selectedFile}</div>
                <pre className="text-xs bg-zinc-100 dark:bg-zinc-800 p-2 rounded overflow-auto max-h-64 whitespace-pre-wrap break-words">{fileContent}</pre>
              </div>
            )}
          </aside>
        )}

        <main ref={containerRef} className="flex-1 overflow-auto p-4 space-y-2">
          {messages.map((m, i) => (
            <Message key={i} role={m.role} content={m.content} />
          ))}
          {busy && <div className="text-sm opacity-70">Gerando resposta...</div>}
        </main>
      </div>

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

      {showDiff && diffData && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-xl max-w-3xl w-full max-h-[80vh] overflow-auto">
            <div className="border-b border-zinc-200 dark:border-zinc-800 p-4 flex items-center justify-between">
              <h3 className="font-semibold">Aplicar mudança: {diffData.path}</h3>
              <button onClick={() => setShowDiff(false)} className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">✕</button>
            </div>
            <div className="p-4">
              <pre className="text-xs bg-zinc-100 dark:bg-zinc-800 p-3 rounded overflow-auto whitespace-pre-wrap">{diffData.diff}</pre>
            </div>
            <div className="border-t border-zinc-200 dark:border-zinc-800 p-4 flex gap-2 justify-end">
              <button onClick={() => { setShowDiff(false); setDiffData(null); }} className="px-3 py-1 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800">Cancelar</button>
              <button onClick={approveDiff} disabled={diffApproving} className="px-3 py-1 rounded bg-green-600 text-white disabled:opacity-50">Aplicar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
