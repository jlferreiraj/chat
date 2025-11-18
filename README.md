# AI Chat (Local, LM Studio)

Um chat local com streaming, focado em pair programming e ferramentas seguras para trabalhar em projetos grandes. Backend em Express com proxy para LM Studio e frontend em React + Tailwind com dark mode.

## Requisitos
- Node.js 18+
- LM Studio rodando localmente (servidor OpenAI-compatible em `http://127.0.0.1:1234/v1`)

## Configuração
```bash
cd /Users/jay/Documents/ai-chat
cp .env.example .env
# Ajuste WORKSPACE_ROOT se necessário
```

## Instalação
```bash
# Instalar dependências do servidor (raiz)
npm install

# Instalar dependências do frontend
cd web && npm install && cd -
```

## Desenvolvimento (server + web)
```bash
# Terminal 1: servidor
npm run server

# Terminal 2: frontend (Vite)
npm run client
```
Ou, em um único terminal, com ambos em paralelo:
```bash
npm run dev
```

- Frontend: http://127.0.0.1:5173
- Backend: http://127.0.0.1:3000 (`/health`, `/api/chat/stream`, `/api/tools`)

## Produção (somente web estático)
```bash
npm run build
npm run preview
```

## Fluxo do Chat
- O frontend envia as mensagens para `/api/chat/stream` (POST) e consome via streaming (SSE) pelo corpo da resposta.
- O backend proxy-a o LM Studio (`/v1/chat/completions`), emite eventos `token` e `done`.

## Ferramentas (Tools API)
- `list_dir`, `read_file`, `write_file` (dry-run por padrão), `apply_patch` (unified), `glob`, `grep`.
- Escrita segura: use `approve=true` para aplicar.

## Git
```bash
# Inicializar repositório e apontar para o remoto sugerido
cd /Users/jay/Documents/ai-chat
git init
# escolha SSH ou HTTPS
# SSH:
git remote add origin git@github.com:jlferreiraj/chat.git
# HTTPS:
# git remote add origin https://github.com/jlferreiraj/chat.git

git add -A
git commit -m "feat: initial local chat (server + web)"
# git push -u origin main  # crie ou troque para a branch desejada antes de dar push
```

## Segurança e Escopo
- Sandbox: todas as operações de arquivo respeitam `WORKSPACE_ROOT`.
- Ignores: `.git`, `node_modules`, etc. para performance e privacidade.

## Próximos Passos (sugestões)
- Autoexecução opcional de ferramentas com política de aprovação (dry-run -> diff -> apply).
- Painel de diffs e árvore de arquivos na UI.
- Indexação incremental para contextos grandes (RAG leve).
