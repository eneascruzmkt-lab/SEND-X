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
**Problema:** Telegram envia .MOV como document, plataforma de disparo não reproduz .MOV como vídeo inline.

**Solução em dois pontos:**

- `Dockerfile` — **MODIFICADO**: Adicionado `apt-get install ffmpeg`

- `src/bot/index.js` — **MODIFICADO**:
  - `detectTelegrafType()`: documentos com mime `video/*` ou extensão de vídeo (.mov, .avi, etc) agora retornam 'video' em vez de 'document'
  - `downloadTelegramFile()`: se vídeo não é .mp4, converte com ffmpeg antes de upload pro Catbox
  - Função `telegramToHtml()` existe no código mas NÃO está sendo usada (foi revertida — causava problemas com parse_mode HTML)

- `src/pulp/index.js` — Conversão de vídeo:
  - `convertRemoteVideoToMp4()`: função que baixa vídeo remoto, converte e re-upa pro Catbox
  - Se URL do vídeo não é .mp4 no momento do envio, converte automaticamente
  - Se conversão falhar, o schedule fica com status 'erro' (nunca envia .MOV)

---

### 4. Migração SendPulse → Pulp (17/06/2026)
**Problema:** SendPulse deixou de ser usada. Substituída pelo Pulp (plataforma própria do operador).

**O que mudou:**

- `src/pulp/index.js` — **CRIADO**: Módulo de comunicação com o MCP do Pulp
  - `listBots(pulpUrl, apiKey)`: lista bots via MCP tool `list_bots`
  - `dispatch(schedule, par, pulpUrl, apiKey)`: cria broadcast via MCP tool `create_and_send_broadcast`
  - Comunicação via JSON-RPC 2.0 em `POST <PULP_URL>/mcp` com Bearer token
  - Inclui `convertRemoteVideoToMp4()` (movida do antigo sendpulse)

- `src/scheduler/index.js` — **MODIFICADO**:
  - Import trocado de `sendpulse` para `pulp`
  - Credenciais vêm de env vars (`PULP_URL`, `PULP_API_KEY`) em vez de `user_settings`
  - `pulp.dispatch()` no lugar de `sendpulse.dispatch()`

- `src/routes/index.js` — **MODIFICADO**:
  - Rota `GET /api/sendpulse/bots` → `GET /api/pulp/bots`
  - Disparo manual usa `pulp.dispatch()`
  - Função `getCredentials()` removida
  - Settings não exibem mais campos SendPulse

- `src/bot/index.js` — **MODIFICADO**:
  - Import do sendpulse removido
  - Polling SendPulse (fallback cada 15s) removido inteiramente
  - Fallback `sendpulse.getMediaUrl()` removido
  - Funções `pollParMessages()` e `extractMedia()` removidas

- `public/index.html` — **MODIFICADO**:
  - Endpoint de bots: `/api/pulp/bots`
  - Campos SendPulse Client ID/Secret removidos das configurações
  - Textos "SendPulse" trocados por "Pulp"
  - Botões permitidos em mensagens capturadas do grupo

- `src/sendpulse/index.js` — Mantido no repo mas NÃO é importado por nenhum arquivo

#### Env vars do SEND-X (Railway):
- `PULP_URL` = `https://pulp.up.railway.app`
- `PULP_API_KEY` = chave MCP do Pulp

#### Mapeamento de bots (coluna `sendpulse_bot_id` agora guarda IDs do Pulp):
- DANI (@danidaroletabot) → bot_id `8`
- DEIVID (@malvadezaaviator_bot) → bot_id `7`
- NUCLEAR (@nucleartraderbot) → bot_id `5`
- JUH → ainda não está no Pulp

---

## IMPORTANTE - O que NÃO mexer:
- Fluxos existentes de texto, foto e vídeo .mp4 não foram alterados
- A função `telegramToHtml` existe no bot/index.js mas NÃO é chamada — foi desativada por causar problemas
- Os links do Telegram no caption são perdidos (texto puro) — tentativa de preservar via HTML foi revertida
- Colunas `sendpulse_bot_id` e `sendpulse_bot_nome` no banco NÃO foram renomeadas — agora guardam IDs/nomes do Pulp
- `src/sendpulse/index.js` existe mas não é usado — não importar de volta

---

## Arquitetura atual (operações)

**Repos / Services:**
- **SEND-X** painel + API → repo `eneascruzmkt-lab/SEND-X` → Railway service `SEND-X` no projeto Railway `SEND-X` → URL `https://send-x-production.up.railway.app`
- **Pulp** plataforma de bots/disparos Telegram → repo `eneascruzmkt-lab/pulp` → Railway → URL `https://pulp.up.railway.app` (MCP em `/mcp`, auth Bearer = `MCP_API_KEY`)
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

---

## Contexto do bridge (chat do SEND-X)

Quando esta sessão é iniciada pelo **bridge do SEND-X** (chat web), o cwd é `/workspace/SEND X` e os outros repos do ecossistema estão clonados em `/workspace/`:
- `/workspace/SEND X` — produto SEND-X (este repo)
- `/workspace/quiz-juh-aviator`, `/workspace/quiz-dani-roleta`, `/workspace/daniroleta`
- `/workspace/sendx-mcp` — servidor MCP HTTP do SEND-X
- `/workspace/monitorgrupo-v2`, `/workspace/meet-attendance-bot`, `/workspace/meet-attendance-dashboard`, `/workspace/whisper-server`
- `/workspace/claude-bridge-railway` — o próprio bridge
- `/workspace/poker-pilot-app`, `/workspace/autoplay`, `/workspace/zapcomplete`, `/workspace/fantasmateste`, `/workspace/pixel-agents`

### Operador
- Aytalo (user_id=1, eneascruz.mkt@gmail.com)
- **Experts ativos** (com Meta Ads + Apostatudo):
  - DANI → roleta — bot `@danidaroletabot` — ad_account `act_1269299810441288`
  - DEIVID/MALVADEZA → aviator — bot `@malvadezaaviator_bot` — ad_account `act_280380748192681`
  - JUH → aviator — ad_account `act_974936103565001`
  - NUCLEAR → bot `@nucleartraderbot`
- **Casa de apostas**: APOSTATUDO (postback webhook)

### Tools MCP do bridge (`mcp__bridge__*`)
Carregadas dinamicamente do SEND-X `/api/tools/list` no startup. Atualmente ~37 tools:

**Métricas/funil:** `get_dashboard_overview`, `get_metricas_expert`, `get_metricas_diario`, `get_postbacks_por_utm`, `get_telegram_growth`, `get_disparos_status`, `get_funil_expert`, `get_comparativo_funil`, `get_expert_360`

**Apostatudo:** `get_apostatudo_resumo_geral`, `get_apostatudo_metricas_expert`, `get_apostatudo_ftds_expert`, `get_apostatudo_top_leads_expert`, `get_apostatudo_atividade_lead`, `get_apostatudo_mapeamento`, `listar_afiliados_apostatudo_descoberta`, `mapear_apostatudo_expert`

**Instagram dos experts:** `listar_instagram_contas`, `get_instagram_atividade_dia`, `get_instagram_stories_ativos`, `get_instagram_comentarios`, `get_instagram_dms`, `get_instagram_metricas`

**WhatsApp (monitorgrupo):** `get_grupos_expert`, `get_engajamento_por_grupo`, `get_engajamento_grupos`, `get_mensagens_grupos_expert`, `get_churn_grupos_expert`

**Lives Klarvel:** `get_lives_resumo`, `listar_lives`, `get_live_detalhes`, `get_mensagens_live`, `get_transcricao_live`, `gerar_relatorio_lives`

**Research:** `analisar_concorrente_instagram`, `meta_ads_library_search`, `web_search`, `fetch_url`

**Meta Ads detalhado (Graph API):** `get_meta_ads_campaigns`, `get_meta_ads_adsets`, `get_meta_ads_ads`, `get_meta_ads_creative` — gasto/CPM/CTR/leads por campaign/adset/ad de DANI/DEIVID/JUH usando FB_ACCESS_TOKEN + ad_accounts mapeados. Use pra responder "qual campanha tá performando", "melhor adset", "criativo escala", "qual copy desse ad".

**Meta Ads — CRIAÇÃO (writes):** `create_meta_ads_campaign`, `create_meta_ads_adset`, `create_meta_ads_ad`, `duplicate_meta_ads_ad`, `create_meta_ads_creative_from_post`.

**Regras OBRIGATÓRIAS pra writes em Meta Ads:**
1. **Sempre chame com `confirm: false` primeiro** (default) — retorna `_preview: true` com o payload que SERIA enviado. Mostre o preview pro operador.
2. Espere o operador confirmar com "sim/topa/aplica". SÓ ENTÃO chame de novo com `confirm: true`.
3. **Tudo é criado PAUSED por default.** Não tente criar ACTIVE — operador ativa via Ads Manager depois de revisar.
4. **Fluxo padrão pra criar campanha do zero**:
   a. `create_meta_ads_campaign` (recebe `campaign_id`)
   b. `create_meta_ads_creative_from_post` se reutilizar post IG/FB, OU pede pro operador subir o creative no Ads Manager primeiro
   c. `create_meta_ads_adset` (precisa de `campaign_id` + `targeting` JSON + budget + optimization_goal)
   d. `create_meta_ads_ad` (precisa de `adset_id` + `creative_id`)
5. **Pra escalar um criativo bom**: `duplicate_meta_ads_ad(source_ad_id, target_adset_id, new_name)` — copia o creative pra um novo ad em outro adset.
6. Se o operador pedir pra mexer em orçamento ou pausar/ativar ad existente, **avise que ainda não tem essas tools** (fases A+B não implementadas). Por enquanto Ads Manager direto.

### PULP — sistema próprio de bots/leads Telegram (`mcp__pulp__*`)
MCP remoto do sistema do operador (substitui a SendPulse pra gestão de bots/canais/leads no Telegram). Wired no bridge via HTTP + Bearer key (env `PULP_MCP_KEY`). 19 tools:

**Bots:** `list_bots`, `create_bot` (a partir do token BotFather), `delete_bot`
**Contatos:** `list_contacts` (paginado), `import_contacts` (CSV/texto, precisa telegram_id), `delete_contact`
**Links rastreáveis:** `list_links`, `create_link` (bot + fluxo + utm base)
**Usuários do painel:** `list_users`, `create_user` (agente: email + bots liberados), `delete_user`
**Mensagens:** `send_message` (texto de um bot pra um contato)
**Fluxos:** `list_flows`, `get_flow`, `create_flow` (trigger: start|deeplink|default), `author_flow` (define os passos), `delete_flow`
**Disparos:** `list_broadcasts`, `create_broadcast_draft` (cria RASCUNHO — NÃO envia, envio depende de aprovação), `create_and_send_broadcast` (cria e agenda pra envio imediato — usado pelo SEND-X)

Use pra "cria um bot", "importa esses leads", "monta um fluxo de boas-vindas", "lista os contatos do bot X", "cria um disparo". `create_broadcast_draft` vira rascunho — confirme com o operador antes de qualquer envio real. `create_and_send_broadcast` é usado automaticamente pelo SEND-X para disparos agendados.

### ⚠️ Tools que NÃO existem no bridge
Algumas MCPs do Claude Code local do operador **NÃO estão wired no bridge**:
- `mcp__claude_ai_Meta_MCP__*` — NÃO disponível. Use as `mcp__bridge__get_meta_ads_*` acima.
- `mcp__claude_ai_higgis__*` — NÃO disponível. Imagem/vídeo gerado é só via Claude Code local.
- `mcp__claude_ai_Gmail__*`, `mcp__claude_ai_Google_Drive__*`, `mcp__claude_ai_Google_Calendar__*` — NÃO disponíveis.
- `mcp__plugin_vercel_vercel__*` — NÃO disponível.

Se a pergunta exige um desses MCPs, **avise o operador em vez de tentar chamar** — chamar gera 30s de timeout e perde a conexão.

### Fonte de verdade dos números
- Postbacks Apostatudo = **tempo real** (incluem hoje)
- Planilha = começa em ontem
- Gasto Meta = atualiza ~09h BRT
- USE APENAS números retornados pelas tools — NUNCA invente

### Padrão de cores nos quizzes (mockup WhatsApp celular)
- Header: `#008069` (verde WhatsApp)
- Bolha "me": `#d9fdd3` (verde claro) · Bolha "other": `#ffffff`
- CTA principal: `#00a884` — **NUNCA** gradient vinho/rosa/laranja
- Avatar pode ter gradient da marca (só se foto não carregar)

### Branches dos repos
- `eneascruzmkt-lab/SEND-X` → `main` (auto-deploy ✓)
- `eneascruzmkt-lab/pulp` → `master` (auto-deploy ✓)
- `aytalo/sendx-mcp` → `main` (auto-deploy ✓)
- `aytalo/quiz-juh-aviator` → `main` (auto-deploy ✓)
- **`aytalo/quiz-dani-roleta` → `master`** (auto-deploy ✓ — atenção: é master, não main)
- `aytalo/claude-bridge-railway` → `main` (auto-deploy ✓)
- `aytalo/meet-attendance-bot` → `main` (auto-deploy ✓)
- `aytalo/monitorgrupo-v2` → `main` (deploy manual: `railway up --service monitorgrupo --ci`)

### Regras de execução no chat
**Faça direto (sem perguntar):** análise, leitura, pesquisa, copy, Edit/Write local, commit local sem push, tools de leitura, `gh`/`railway` read-only.

**Peça confirmação antes:** `git push` (deploy prod), `railway up`/`redeploy`/`down`/`delete`, `rm -rf`, `DROP/TRUNCATE/DELETE FROM` sem WHERE, `git reset --hard`/`push --force`, criar/apagar schedule/broadcast Pulp, mudar env var prod, operações que custam dinheiro (Apify/RapidAPI/Higgsfield).

**Quando entregar página/quiz/site:** confirme com `curl` o que tá REALMENTE servido (não confunda local vs prod). NUNCA fique em loop `until curl ...` esperando deploy — responde imediatamente "deploy disparado, em ~2min tá no ar".

### Aprendizado entre sessões
Quando aprender algo relevante, termine a resposta com:
```
MEMORIZE: tipo|chave|valor
```
Tipos: `user`, `project`, `feedback`, `decision`. Persistido em `chat_facts` do SEND-X.
