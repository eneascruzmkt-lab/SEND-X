---
description: Redeploy controlado dos serviços SEND-X e sendx-mcp + valida saúde
---

Fluxo de redeploy seguro dos dois serviços principais. Sempre confirma com o user antes de executar ações destrutivas.

**Passos:**

1. **Verificar git status local** dos dois repos:
   - `cd "/Users/aytalooliveira/SEND X" && git status -sb`
   - `cd /Users/aytalooliveira/sendx-mcp && git status -sb`
   Se houver mudanças não commitadas, perguntar se faz commit antes ou faz redeploy do que está no Railway.

2. **Push pendente** se houver commits ahead do origin (`git status` mostra "ahead"):
   - `git push origin main` em cada repo

3. **Trigger redeploy via Railway CLI** (paralelo):
   - SEND-X: `cd "/Users/aytalooliveira/SEND X" && railway link --project SEND-X --service SEND-X && railway up --ci`
   - sendx-mcp: `cd /Users/aytalooliveira/sendx-mcp && railway link --project SEND-X --service sendx-mcp && railway up --ci`

4. **Aguardar build/deploy concluir** — pollar `railway deployment list` (head -1) até status virar SUCCESS, FAILED ou CRASHED. Use Bash com `run_in_background` + `until` loop, não polling síncrono.

5. **Validar healthchecks pós-deploy**:
   - `curl -fsS https://send-x-production.up.railway.app/` → 200
   - `curl -fsS https://sendx-mcp-production.up.railway.app/health` → `{"ok":true}`

6. **Reportar resultado**:
   - Tempo total de cada deploy
   - Status final (SUCCESS/FAILED)
   - Healthcheck pass/fail
   - Se algo falhou: pegar últimas 30 linhas dos logs com `railway logs --tail 30` para diagnose

Argumento opcional: se o user passar `--service=sendx-mcp` ou `--service=SEND-X`, redeploya só esse.
