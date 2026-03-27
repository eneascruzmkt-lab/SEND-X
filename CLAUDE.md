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
