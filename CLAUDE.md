# MKT Project - Contexto para Claude Code

## O que foi feito (27/03/2026)

### 1. Scraper Automático (`scraper/`)
**Repo:** https://github.com/eneascruzmkt-lab/mkt-scraper (privado)
**Deploy:** Railway (serviço único rodando 24/7)

#### O que faz:
- **Telegram Bot** roda 24/7 contando novos membros nos canais DANI e DEIVID
- **Scraper** roda todo dia às 09:00 BRT (via node-cron interno) e coleta dados do dia anterior:
  - **Apostatudo** (2 logins): FTDs, FTD Amount, Deposits Amount, Net P&L
  - **Utmify** (1 login, 2 dashboards): Gastos com anúncios
- Escreve na **Google Sheet** `1c2q09jI1W613J3MVFO9wvhM1sqB8O7DzXUJbaT16SS4`

#### Estrutura:
- `server.js` — Entry point: inicia bot + agenda scraper com node-cron
- `index.js` — Lógica do scraper (pode rodar manualmente: `node index.js`)
- `fill-day.js` — Preenche dados de um dia específico: `node fill-day.js 25`
- `scrapers/apostatudo.js` — Login + scrape da tabela de relatório por data
- `scrapers/utmify.js` — Login + troca período pra "Ontem" + lê card "Gastos com anúncios"
- `sheets/writer.js` — Escreve na Google Sheet via API (valores como números, RAW)
- `utils/format.js` — `toNumber()`: converte formatos BR/Apostatudo pra número puro
- `telegram/bot.js` — Bot que conta joins nos canais via polling getUpdates
- `telegram/reader.js` — Lê contagem de joins do arquivo JSON

#### Mapeamento da planilha:
- Linha = dia + 1 (header na linha 1, dia 1 = linha 2)
- Colunas: B=Gasto, C=FTDs, D=FTD Amount, F=Deposits Amount, H=Inscritos Telegram, J=Net P&L
- Abas: DANI e DEIVID
- No dia 1 do mês: scraper pula (Apostatudo não atualiza corretamente)

#### Credenciais (env vars):
- `APOSTATUDO_EMAIL_1/PASS_1` — Login DANI
- `APOSTATUDO_EMAIL_2/PASS_2` — Login DEIVID (senha com # precisa de aspas no .env)
- `UTMIFY_EMAIL/PASS` — Login único pra ambos dashboards
- `TELEGRAM_BOT_TOKEN` — Bot @sentinelalng_bot
- `GOOGLE_SHEET_ID` / `GOOGLE_SERVICE_ACCOUNT_KEY` (base64)

#### Canais Telegram monitorados:
- DANI: `-1002047525185`
- DEIVID: `-1002077690875`

---

### 2. Página Relatório no SEND-X
**Repo:** https://github.com/eneascruzmkt-lab/SEND-X
**Arquivos modificados:**

- `src/routes/relatorio.js` — **CRIADO**: GET /api/relatorio?tab=DANI|DEIVID&periodo=ontem|7d|1m|3m|custom&de=DD/MM/YYYY&ate=DD/MM/YYYY
  - Lê dados da Google Sheet via googleapis
  - Suporta filtros de período
  - `parseNum()` lida com formatos BR (R$ 1.234,56) e decimais com ponto
  - Limpa espaços do base64 da service account key (Railway quebra a linha)

- `src/routes/index.js` — **MODIFICADO**: Adicionadas 2 linhas antes do `module.exports` para registrar a rota do relatório

- `public/index.html` — **MODIFICADO**:
  - Nav item "Relatorio" adicionado no sidebar (abaixo de Dashboard)
  - Panel `#panel-relatorio` com tabs DANI/DEIVID + filtros de período + date picker customizado
  - Funções JS: `switchRelatorioTab()`, `switchRelatorioPeriodo()`, `loadRelatorio()`, `renderRelatorio()`, `renderRelatorioCard()`
  - `titles` object: adicionado `relatorio: 'Relatorio'`
  - `showPanel()`: adicionado `if (name === 'relatorio') loadRelatorio();`

- `package.json` — **MODIFICADO**: Adicionada dependência `googleapis`

#### Env vars adicionadas no Railway do SEND-X:
- `GOOGLE_SHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_KEY` (base64, Railway pode adicionar espaços — o código limpa automaticamente)

---

### 3. Conversão de vídeo .MOV → .MP4 no SEND-X
**Problema:** Telegram envia .MOV como document, SendPulse não reproduz .MOV como vídeo inline.

**Solução em dois pontos:**

- `Dockerfile` — **MODIFICADO**: Adicionado `apt-get install ffmpeg`

- `src/bot/index.js` — **MODIFICADO**:
  - `detectTelegrafType()`: documentos com mime `video/*` ou extensão de vídeo (.mov, .avi, etc) agora retornam 'video' em vez de 'document'
  - `downloadTelegramFile()`: se vídeo não é .mp4, converte com ffmpeg antes de upload pro Catbox
  - Função `telegramToHtml()` existe no código mas NÃO está sendo usada (foi revertida — causava problemas com parse_mode HTML na SendPulse)

- `src/sendpulse/index.js` — **MODIFICADO**:
  - `buildCampaignMessage()` agora é `async`
  - Se URL do vídeo não é .mp4 no momento do envio, baixa, converte com ffmpeg e re-upa pro Catbox (safety net)
  - `convertRemoteVideoToMp4()`: função que baixa vídeo remoto, converte e re-upa
  - Se conversão falhar, o schedule fica com status 'erro' (nunca envia .MOV)

---

## IMPORTANTE - O que NÃO mexer:
- Fluxos existentes de texto, foto e vídeo .mp4 não foram alterados
- A função `telegramToHtml` existe no bot/index.js mas NÃO é chamada — foi desativada por causar problemas
- Os links do Telegram no caption são perdidos (texto puro) — tentativa de preservar via HTML foi revertida
- Todas as rotas originais do SEND-X estão intactas

---

## Arquitetura atual (operações)

**Repos / Services:**
- **SEND-X** painel + API → repo `eneascruzmkt-lab/SEND-X` → Railway service `SEND-X` no projeto Railway `SEND-X` → URL `https://send-x-production.up.railway.app`
- **sendx-mcp** servidor MCP HTTP → repo `aytalo/sendx-mcp` → Railway service `sendx-mcp` no mesmo projeto → URL `https://sendx-mcp-production.up.railway.app/mcp` (auth Bearer = `user_settings.api_key`)
- **sendx-mcp local stdio** → `/Users/aytalooliveira/sendx-mcp/` rodando via `claude mcp add` para Claude Code local

**Postgres:** 1 instância no projeto SEND-X. Internal: `postgres.railway.internal:5432`. Public proxy: `crossover.proxy.rlwy.net:47305`.

**Donos dos dados:** `user_id=1` (eneascruz.mkt@gmail.com) é o owner principal. Todas operações default usam `user_id=1`.

## Operações comuns (slash commands)

- **`/sendx-status`** — overview operacional (deploys, healthchecks, alertas, git status). Use no começo de uma sessão para ver se está tudo verde.
- **`/redeploy-tudo`** — redeploy controlado dos 2 serviços com validação de saúde. Aceita `--service=<nome>` para redeploy individual.

## Fluxo de mudança no SEND-X

1. Editar código local em `/Users/aytalooliveira/SEND X/`
2. `node --check <arquivo>` para syntax check rápido (não tem teste suite)
3. `git add -p` + commit com mensagem descritiva
4. `git push origin main` — Railway auto-deploya em ~2min
5. Aguardar `railway deployment list` mostrar SUCCESS no head, depois `curl /` pra validar 200

## Fluxo de mudança no sendx-mcp

1. Editar `/Users/aytalooliveira/sendx-mcp/src/`
2. `cd /Users/aytalooliveira/sendx-mcp && node --env-file=.env -e '<smoke test>'` para testar local
3. `git add -A && git commit -m "..." && git push`
4. **Deploy não é automático** (Railway não tem acesso ao repo privado `aytalo/sendx-mcp`). Rodar manual:
   `cd /Users/aytalooliveira/sendx-mcp && railway service sendx-mcp && railway up --ci`
5. Validar: `curl -fsS https://sendx-mcp-production.up.railway.app/health`

## Acesso a dados

- **Métricas / disparos / postbacks** → use as MCP tools `mcp__sendx__*` (já registradas no Claude Code). Evita mexer direto na planilha ou DB.
- **Meta Ads (gasto/CPM/CTR/CPA por campanha/adset)** → use o MCP `mcp__claude_ai_Meta_MCP__*`. O ad_account_id de cada expert vem de `mcp__sendx__get_meta_ads_performance`.
- **Postgres direto** (queries que o MCP não cobre) → DATABASE_URL pública em `~/.railway/config.json` ou via `railway variables --kv`. Usar `node + pg` no diretório `/Users/aytalooliveira/sendx-mcp/` que já tem o pacote instalado.

## Princípios de segurança

- Antes de qualquer ação destrutiva (drop, delete, force push, railway delete) — confirmar com o user
- Nunca commitar `.env`, `.gsa.b64` ou qualquer chave em texto puro
- Antes de mudar produção (push em `main`) avisar o user da mudança e aguardar ok
