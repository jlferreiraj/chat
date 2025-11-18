import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import fs from 'fs';
import fg from 'fast-glob';
import ignore from 'ignore';
import { createTwoFilesPatch, applyPatch } from 'diff';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || process.cwd());
const LMSTUDIO_BASE_URL = process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1';
const LMSTUDIO_API_KEY = process.env.LMSTUDIO_API_KEY || 'lm-studio';
const DEFAULT_MODEL = process.env.MODEL || 'gpt-4o-mini';

const client = new OpenAI({ baseURL: LMSTUDIO_BASE_URL, apiKey: LMSTUDIO_API_KEY });

// Folders ignored for perf/safety
const DEFAULT_IGNORES = ['.git', 'node_modules', 'dist', 'build', '.next', 'out', '.venv', '__pycache__'];

function resolveSafe(relPath) {
  const full = path.resolve(WORKSPACE_ROOT, relPath || '.');
  if (!full.startsWith(WORKSPACE_ROOT)) {
    throw new Error('Path escapes workspace root');
  }
  return full;
}

function listDir(relPath = '.') {
  const dir = resolveSafe(relPath);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter(e => !DEFAULT_IGNORES.includes(e.name))
    .map(e => {
      const p = path.join(dir, e.name);
      const stat = fs.statSync(p);
      return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: e.isDirectory() ? undefined : stat.size };
    });
}

function readFile(relPath, opts = {}) {
  const p = resolveSafe(relPath);
  const maxBytes = opts.maxBytes || 200_000;
  const data = fs.readFileSync(p, 'utf8');
  if (Buffer.byteLength(data, 'utf8') > maxBytes) {
    return { truncated: true, content: data.slice(0, maxBytes), totalBytes: Buffer.byteLength(data, 'utf8') };
  }
  return { truncated: false, content: data, totalBytes: Buffer.byteLength(data, 'utf8') };
}

function writeFile(relPath, content, { approve = false } = {}) {
  const p = resolveSafe(relPath);
  const exists = fs.existsSync(p);
  const before = exists ? fs.readFileSync(p, 'utf8') : '';
  const patch = createTwoFilesPatch(relPath, relPath, before, content, 'before', 'after');

  if (!approve) {
    return { dryRun: true, diff: patch, message: 'Dry-run only. Set approve=true to apply.' };
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return { dryRun: false, applied: true, bytes: Buffer.byteLength(content, 'utf8') };
}

function applyUnifiedPatch(relPath, unified, { approve = false } = {}) {
  const p = resolveSafe(relPath);
  const before = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  if (!approve) {
    const result = applyPatch(before, unified);
    const ok = result !== false;
    return { dryRun: true, canApply: ok, preview: ok ? result : null };
  }
  const result = applyPatch(before, unified);
  if (result === false) {
    return { dryRun: false, applied: false, error: 'Failed to apply patch.' };
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, result, 'utf8');
  return { dryRun: false, applied: true };
}

function globSearch(pattern, cwdRel = '.') {
  const cwd = resolveSafe(cwdRel);
  return fg.sync(pattern, {
    cwd,
    dot: false,
    ignore: DEFAULT_IGNORES.map(i => `**/${i}/**`)
  });
}

function grep(pattern, cwdRel = '.', { maxMatches = 200 } = {}) {
  const cwd = resolveSafe(cwdRel);
  const regex = new RegExp(pattern, 'i');
  const files = fg.sync(['**/*.*'], {
    cwd,
    dot: false,
    ignore: DEFAULT_IGNORES.map(i => `**/${i}/**`)
  });
  const out = [];
  for (const f of files) {
    try {
      const full = path.join(cwd, f);
      const data = fs.readFileSync(full, 'utf8');
      const lines = data.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (regex.test(line)) {
          out.push({ file: path.relative(WORKSPACE_ROOT, full), line: idx + 1, text: line });
        }
      });
      if (out.length >= maxMatches) break;
    } catch {}
  }
  return out.slice(0, maxMatches);
}

// Build a small, bounded workspace summary for better grounding
function workspaceSummary() {
  const top = listDir('.');
  const rootFiles = top.filter(x => x.type === 'file').map(x => x.name).slice(0, 30);
  const rootDirs = top.filter(x => x.type === 'dir').map(x => x.name).slice(0, 15);

  function listSome(patterns, limit = 60) {
    const files = fg.sync(patterns, { cwd: WORKSPACE_ROOT, dot: false, ignore: DEFAULT_IGNORES.map(i => `**/${i}/**`) });
    return files.slice(0, limit);
  }

  const serverFiles = listSome(['server/**/*.{js,ts}'], 60);
  const webFiles = listSome(['web/**/*.{js,jsx,ts,tsx,css,html}', 'web/*.{js,ts}'], 80);

  const lines = [];
  lines.push(`Workspace: ${WORKSPACE_ROOT}`);
  lines.push(`Root files (${rootFiles.length}): ${rootFiles.join(', ')}`);
  lines.push(`Root dirs (${rootDirs.length}): ${rootDirs.join(', ')}`);
  if (serverFiles.length) lines.push(`server/* (${serverFiles.length}):`);
  serverFiles.forEach(f => lines.push(` - ${f}`));
  if (webFiles.length) lines.push(`web/* (${webFiles.length}):`);
  webFiles.forEach(f => lines.push(` - ${f}`));
  return lines.join('\n');
}

function buildSystemPrompt() {
  const summary = workspaceSummary();
  return [
    'Você é um assistente de engenharia de software local, especialista em código e projetos grandes.',
    'Objetivo: pair programming, revisão, arquitetura, performance e segurança, sempre com foco no código do workspace.',
    'Estilo: respostas concisas, claras, em Português do Brasil, sem repetir palavras, sem gagueira, sem emojis (a não ser que o usuário peça).',
    'Se detectar repetição ou texto corrompido, reescreva imediatamente de forma limpa.',
    'Quando pedir para ler/alterar arquivos, refira-se a eles pelo caminho relativo e proponha diffs ou patches minimalistas.',
    'Limite-se ao escopo do workspace; se faltarem arquivos, solicite-os pelo caminho.',
    '',
    'Resumo do workspace (somente para contexto, não repita na resposta a menos que útil):',
    summary
  ].join('\n');
}

// SSE helpers
function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('\n');
}

function sseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Chat streaming (proxy LM Studio -> SSE)
app.post('/api/chat/stream', async (req, res) => {
  try {
    const { messages, model = DEFAULT_MODEL, temperature = 0.1 } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages must be an array' });
    }
    sseInit(res);

    // Inject a workspace-aware system prompt at the start unless user already provided one
    const sys = { role: 'system', content: buildSystemPrompt() };
    const hasSystem = messages.length && messages[0].role === 'system';
    const finalMessages = hasSystem ? messages : [sys, ...messages];

    const stream = await client.chat.completions.create({
      model,
      temperature,
      stream: true,
      // Penalties to curb repetition (supported by LM Studio OpenAI proxy for many models)
      frequency_penalty: 0.5,
      presence_penalty: 0.2,
      messages: finalMessages
    });

    let fullText = '';

    for await (const part of stream) {
      const choice = part.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta || {};
      const content = delta?.content;
      if (content) {
        fullText += content;
        sseEvent(res, 'token', { content });
      }

      if (choice.finish_reason) {
        break;
      }
    }

    sseEvent(res, 'done', { message: fullText });
    res.end();
  } catch (err) {
    console.error(err);
    try {
      sseEvent(res, 'error', { error: String(err?.message || err) });
      res.end();
    } catch {}
  }
});

// Tools
app.post('/api/tools', (req, res) => {
  try {
    const { name, args = {} } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Tool name required' });

    switch (name) {
      case 'list_dir': {
        const { path: rel = '.' } = args;
        return res.json({ ok: true, result: listDir(rel) });
      }
      case 'read_file': {
        const { path: rel, maxBytes } = args;
        if (!rel) return res.status(400).json({ error: 'path required' });
        return res.json({ ok: true, result: readFile(rel, { maxBytes }) });
      }
      case 'write_file': {
        const { path: rel, content, approve = false } = args;
        if (!rel || typeof content !== 'string') return res.status(400).json({ error: 'path and content required' });
        return res.json({ ok: true, result: writeFile(rel, content, { approve }) });
      }
      case 'apply_patch': {
        const { path: rel, diff: unified, approve = false } = args;
        if (!rel || typeof unified !== 'string') return res.status(400).json({ error: 'path and diff required' });
        return res.json({ ok: true, result: applyUnifiedPatch(rel, unified, { approve }) });
      }
      case 'glob': {
        const { pattern = '**/*', cwd = '.' } = args;
        return res.json({ ok: true, result: globSearch(pattern, cwd) });
      }
      case 'grep': {
        const { pattern, cwd = '.', maxMatches } = args;
        if (!pattern) return res.status(400).json({ error: 'pattern required' });
        return res.json({ ok: true, result: grep(pattern, cwd, { maxMatches }) });
      }
      default:
        return res.status(400).json({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, workspace: WORKSPACE_ROOT, baseURL: LMSTUDIO_BASE_URL });
});

// Fetch available models from LM Studio
app.get('/api/models', async (_req, res) => {
  try {
    const models = await client.models.list();
    const ids = models?.data?.map(m => m.id) || [];
    res.json({ ok: true, models: ids });
  } catch (err) {
    console.error('Failed to fetch models:', err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// Lightweight context introspection for the UI/debug
app.get('/api/context/summary', (_req, res) => {
  try {
    res.json({ ok: true, summary: workspaceSummary() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://127.0.0.1:${PORT}`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
});
