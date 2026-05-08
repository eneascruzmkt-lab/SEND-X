---
description: Overview consolidado dos serviços SEND-X (deploys, logs com erro, alertas das métricas)
---

Faz um snapshot operacional completo do projeto SEND-X. Roda em paralelo:

1. **Status dos deploys Railway** — `railway deployment list` para SEND-X, sendx-mcp e scraper (mostra os 3 últimos de cada serviço, destaca FAILED/CRASHED)
2. **Healthchecks** — `curl -s` em https://send-x-production.up.railway.app/ e https://sendx-mcp-production.up.railway.app/health (códigos HTTP)
3. **Métricas do negócio** — chama `mcp__sendx__get_dashboard_overview` (alertas heurísticos, P&L, disparos)
4. **Git status** — verifica se há commits locais não pushed nos repos SEND X e sendx-mcp

Resume em formato bullet:
- 🟢/🔴 por serviço com último status de deploy
- ⚠️ qualquer alerta de métrica (P&L negativo, custo/FTD anormal, gasto sem FTD)
- ✉️ disparos com erro nas últimas 24h se houver
- 🔄 commits locais pendentes se houver

Não execute nenhuma ação corretiva — só reporta. Se algo estiver errado, sugira o próximo comando (ex: `/redeploy-tudo` se um serviço caiu).
