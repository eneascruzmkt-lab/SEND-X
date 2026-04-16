# Insights IA — Design Spec

**Data:** 2026-04-15
**Projeto:** SEND-X
**Abordagem:** Backend Direto (A) — servidor faz tudo, streaming via SSE

---

## 1. Visão Geral

Painel independente no sidebar do SEND-X que permite ao usuário fazer perguntas sobre as métricas dos relatórios usando a API do Claude. A IA recebe os dados já calculados pelo backend e gera análises textuais com streaming em tempo real.

**Princípios:**
- Zero impacto no sistema existente (100% aditivo)
- Cálculos no backend, IA só interpreta
- Dados dinâmicos por usuário (tabs cadastradas, não hardcoded)
- Chat interativo com streaming (SSE)

---

## 2. Arquitetura

```
Frontend (panel-insights)
  │
  POST /api/insights  { message, tab, periodo, history }
  │
  ▼
Backend (src/routes/insights.js)
  │
  1. Auth (JWT middleware existente)
  2. Busca dados via fetchRelatorioData() (função extraída de relatorio.js)
  3. Monta prompt: system + dados dia a dia + history + mensagem
  4. Chama Claude API com streaming
  5. Grava uso em insights_usage
  │
  ▼
  SSE text/event-stream → Frontend renderiza token a token
```

---

## 3. Arquivos

### Novos:
- `src/routes/insights.js` — rota POST /api/insights + GET /api/insights/usage

### Modificados (mínimo):
- `src/routes/index.js` — registrar rota insights (2 linhas)
- `src/routes/relatorio.js` — extrair `fetchRelatorioData()` como função exportável. A rota GET /relatorio continua funcionando exatamente igual, apenas a lógica interna de resolução de período + busca + soma é movida para uma função reutilizável. A função retorna `{ rows, total, periodoLabel }` onde `rows` é o array de linhas brutas da sheet (mesmos dados que `sumRows` já processa).
- `public/index.html` — nav item "Insights IA" no sidebar + painel #panel-insights + JS do chat
- `src/db/index.js` — tabela insights_usage + coluna anthropic_api_key em user_settings + query `upsertAnthropicKey(userId, key)` + query `getAnthropicKey(userId)`
- `package.json` — adicionar @anthropic-ai/sdk

### Sem alteração:
- bot/, scheduler/, sendpulse/, socket/, auth/ — zero mudanças

---

## 4. Backend — Rotas

### POST /api/insights

**Request:**
```json
{
  "message": "Como está o desempenho essa semana?",
  "tab": "DANI",
  "periodo": "7d",
  "history": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

**Parâmetros opcionais de período custom:** `de` e `ate` (DD/MM/YYYY) quando periodo = "custom"

**Fluxo:**
1. Valida JWT (middleware existente)
2. Busca anthropic_api_key do settings do usuário. Se não tiver, retorna 400.
3. Valida `history` — máximo 10 mensagens (janela deslizante). Se vier mais, pega as últimas 10.
4. Chama `fetchRelatorioData(userId, tab, periodo, de, ate)` — retorna:
   - `rawRows`: array de linhas brutas da sheet (cada linha é um array de strings, coluna A = data)
   - `total`: objeto com somas + custoFTD calculado (via `sumRows` existente)
   - `periodoLabel`: string descritiva
5. Converte `rawRows` em objetos detalhados para o prompt:
   - Para cada linha, aplica `extractRow()` (já existe em relatorio.js) → `{ gasto, cliques, cadastros, ftds, ftdAmount, depositsAmount, telegramJoins, netPL }`
   - Adiciona `dia` extraído da coluna A (row[0])
   - Calcula `custoFTD` por linha: `gasto / ftds` (se ftds > 0, senão 0)
   - Resultado: array de `{ dia, gasto, cliques, cadastros, ftds, ftdAmount, custoFTD, depositsAmount, telegramJoins, netPL }`
6. Formata dados como tabela markdown para injetar no prompt
7. Dias sem dados (todos os valores = 0 ou ausentes) são marcados com "—" e nota "possível falha do scraper"
8. Dia 1 de cada mês excluído ou marcado como "sem coleta por design"
9. Monta mensagens para o Claude:
   - System: prompt fixo (contexto negócio + regras) + dados formatados
   - History: últimas mensagens do chat
   - User: mensagem atual
10. Chama Anthropic SDK com `stream: true`, modelo `claude-sonnet-4-6` (bom custo-benefício)
11. Retorna SSE (text/event-stream) via `fetch` + `ReadableStream` no frontend (não usar `EventSource` nativo pois não suporta POST). Cada chunk é um `data: {text}` event.
12. Ao finalizar, grava em insights_usage: user_id, input_tokens, output_tokens

**Erros:**
- 400: chave API não configurada
- 400: tab ou periodo inválido (períodos válidos: hoje, ontem, 7d, 1m, lastm, 3m, custom)
- 401: JWT inválido (middleware)
- 500: erro na API do Claude (com mensagem amigável)
- Timeout: 30s, retorna erro se estourar

### GET /api/insights/usage

**Response:**
```json
{
  "totalRequests": 47,
  "totalInputTokens": 125000,
  "totalOutputTokens": 38000,
  "lastUsed": "2026-04-15T14:30:00Z"
}
```

Soma de todos os registros de insights_usage do usuário autenticado.

---

## 5. Banco de Dados

### Coluna nova em user_settings:
```sql
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS anthropic_api_key TEXT;
```

### Queries novas em db/index.js:
- `upsertAnthropicKey(userId, key)` — salva/atualiza a chave na coluna anthropic_api_key
- `getAnthropicKey(userId)` — retorna a chave do usuário
- Rota dedicada `PUT /api/settings/anthropic-key` para salvar (mesmo padrão das outras credenciais, separado do `upsertUserSettings` existente)

### Tabela nova:
```sql
CREATE TABLE IF NOT EXISTS insights_usage (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 6. Tabs Dinâmicas

Atualmente o relatório hardcoda DANI/DEIVID. Para suportar tabs dinâmicas por usuário:

**Abordagem:** Descoberta automática via Google Sheets API. Ao abrir o painel de Insights (e o painel de Relatório), o backend lista as abas da planilha do usuário via `spreadsheets.get` e retorna os nomes das sheets disponíveis.

**Nova rota:** `GET /api/relatorio/tabs` — retorna array de nomes de abas da planilha do usuário (ex: `["DANI", "DEIVID"]`). Usa a mesma autenticação Google Sheets já existente.

**Impacto no relatório existente:** A rota GET /relatorio atualmente hardcoda `tab` para DANI ou DEIVID (linha 141: `const tab = req.query.tab === 'DEIVID' ? 'DEIVID' : 'DANI'`). Essa guarda precisa ser removida para aceitar qualquer tab string vinda do query param (passando direto para o range da sheet). Além disso, o frontend do relatório troca botões hardcoded por botões renderizados dinamicamente a partir de `/api/relatorio/tabs`.

**Nota:** Essa mudança no relatório é uma melhoria natural que beneficia ambos os painéis (Relatório e Insights IA). Não altera o comportamento da rota de dados.

---

## 7. Prompt de Sistema

```
Você é um analista de métricas de marketing digital especializado em iGaming e afiliados.

## Contexto do negócio
- Os dados são de operações de afiliados de iGaming (apostas esportivas)
- Você está analisando dados do operador "{nome_da_aba}" (tab selecionada pelo usuário)
- O objetivo é maximizar FTDs (primeiros depósitos) com o menor custo possível

## Métricas disponíveis
- Gasto: investimento em anúncios (fonte: Utmify)
- Cliques no Link: cliques nos anúncios
- Cadastros: registros na plataforma
- FTDs: primeiros depósitos realizados
- FTD Amount: valor total dos primeiros depósitos
- Custo por FTD: gasto ÷ FTDs (já calculado)
- Deposits Amount: valor total de depósitos
- Inscritos Telegram: novos membros no canal
- Net P&L: lucro ou prejuízo líquido

## Regras
- Responda sempre em português brasileiro
- Use APENAS os dados fornecidos, nunca invente números
- Não calcule percentuais ou métricas por conta própria — use os valores que já vêm calculados
- Se não tiver dados suficientes para responder, diga claramente
- Se um dia tiver dados zerados ou ausentes, avise que pode ser falha do scraper
- Dia 1 de cada mês não tem coleta de dados (por design)
- Seja direto e objetivo nas análises
- Só faça comparação entre períodos se o usuário pedir explicitamente
```

Dados injetados após o prompt:

```
## Dados: {nome_da_aba} — {periodoLabel}

| Dia | Gasto | Cliques | Cadastros | FTDs | FTD Amount | Custo/FTD | Deposits | Telegram | Net P&L |
|-----|-------|---------|-----------|------|------------|-----------|----------|----------|---------|
| 09/04 | 450.00 | 320 | 45 | 8 | 1200.00 | 56.25 | 3500.00 | 12 | 850.00 |
| 10/04 | — | — | — | — | — | — | — | — | — |
...

## Totais do período
Gasto: 2800.00 | FTDs: 42 | Custo/FTD: 66.67 | Net P&L: 4200.00 | ...
```

---

## 8. Frontend — Painel Insights IA

### Sidebar:
- Novo nav item "Insights IA" com ícone sparkle/estrela, posicionado abaixo de "Relatório"
- Mesma estrutura visual dos outros items

### Layout do painel #panel-insights:

```
┌─────────────────────────────────────────────┐
│  Insights IA                                │
├─────────────────────────────────────────────┤
│  [Tab1] [Tab2]    [Hoje] [7d] [1m] [...]    │  ← Dinâmico por usuário
├─────────────────────────────────────────────┤
│                                             │
│  Área do chat (scrollável)                  │
│                                             │
│  ┌─ IA ──────────────────────────────────┐  │
│  │ Mensagem de boas-vindas              │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ┌─ Você ────────────────────────────────┐  │
│  │ Pergunta do usuário                  │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ┌─ IA ──────────────────────────────────┐  │
│  │ Resposta com streaming...            │  │
│  └───────────────────────────────────────┘  │
│                                             │
├─────────────────────────────────────────────┤
│  [  Digite sua pergunta...        ] [Enviar]│
├─────────────────────────────────────────────┤
│  47 requisições · 163k tokens               │
└─────────────────────────────────────────────┘
```

### Comportamentos:
- Tabs e filtros de período dinâmicos (mesma fonte de dados que o relatório)
- Mensagem de boas-vindas fixa ao abrir
- Chat limpo a cada sessão (refresh = zerado)
- Streaming: texto aparece token a token via `fetch` + `ReadableStream` (POST não é compatível com EventSource nativo)
- Markdown básico renderizado (negrito, listas, tabelas)
- Botão "Enviar" desabilita durante resposta
- Trocar tab ou período limpa o histórico (dados mudaram)
- Contador de uso discreto no rodapé, atualiza após cada resposta
- Enter envia mensagem, Shift+Enter quebra linha
- Auto-scroll para última mensagem

### Configurações:
- Campo "Anthropic API Key" na página de Config, mesmo estilo dos outros campos
- Input mascarado (••••••••), botão salvar
- Validação: chamada teste à API ao salvar. Erro claro se falhar.

---

## 9. Mitigações de Risco

| Risco | Mitigação |
|-------|-----------|
| API Claude fora do ar | Try/catch, mensagem amigável "Análise indisponível" |
| Chave inválida | Validação ao salvar nas Configurações |
| Timeout | 30s limite, erro claro no frontend |
| Custo acumulando | Janela de 10 mensagens no chat, contador de uso visível |
| Períodos grandes | Otimização futura: se necessário, agregar por semana para períodos > 31 dias. Por agora, enviar dia a dia (90 linhas para 3 meses é aceitável em tokens) |
| Alucinação | Prompt instrui: só usar dados fornecidos, não calcular |
| Dados ausentes | Backend marca dias sem dados com "—" + nota no prompt |
| Prompt injection | Prompt de sistema reforça papel, entrada sanitizada |
| Chave exposta | Toda comunicação com Claude via backend, nunca frontend |
| Resposta lenta | Streaming SSE resolve percepção de lentidão |
| Requisições duplicadas | Botão desabilitado durante streaming |
| Idioma | Prompt força português brasileiro |

---

## 10. Modelo e Custo

- **Modelo:** claude-sonnet-4-6 (equilíbrio custo/qualidade)
- **Estimativa por requisição:** ~2k input tokens (prompt + dados 7d) / ~500 output tokens
- **Custo aproximado:** ~$0.01 por requisição com dados de 7 dias
- **Monitoramento:** tabela insights_usage + contador no frontend
