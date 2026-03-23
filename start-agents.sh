#!/bin/bash
# start-agents.sh — Abre VS Code com 2 Pixel Agents (Claude Code)
# Uso: ./start-agents.sh /caminho/da/pasta
#   ou: ./start-agents.sh  (usa pasta atual)

FOLDER="${1:-.}"
FOLDER=$(cd "$FOLDER" 2>/dev/null && pwd || echo "$FOLDER")

if [ ! -d "$FOLDER" ]; then
  echo "Erro: pasta '$FOLDER' nao existe."
  exit 1
fi

# Cria .vscode se nao existe
mkdir -p "$FOLDER/.vscode"

# Preserva tasks.json existente ou cria novo
TASKS_FILE="$FOLDER/.vscode/tasks.json"
if [ -f "$TASKS_FILE" ]; then
  echo "Aviso: $TASKS_FILE ja existe. Pulando criacao."
  echo "Delete o arquivo se quiser recriar."
else
  cat > "$TASKS_FILE" << 'TASKS'
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Pixel Agent 1",
      "type": "shell",
      "command": "claude",
      "isBackground": true,
      "runOptions": { "runOn": "folderOpen" },
      "presentation": {
        "reveal": "always",
        "panel": "dedicated",
        "group": "agents"
      },
      "problemMatcher": []
    },
    {
      "label": "Pixel Agent 2",
      "type": "shell",
      "command": "claude",
      "isBackground": true,
      "runOptions": { "runOn": "folderOpen" },
      "presentation": {
        "reveal": "always",
        "panel": "dedicated",
        "group": "agents"
      },
      "problemMatcher": []
    }
  ]
}
TASKS
  echo "Tasks criadas em $TASKS_FILE"
fi

# Abre VS Code e executa o comando para mostrar o painel Pixel Agents
code "$FOLDER" --command pixel-agents.showPanel

echo ""
echo "=== VS Code aberto com 2 Pixel Agents ==="
echo ""
echo "Primeira vez? Autorize as tasks automaticas:"
echo "  Ctrl+Shift+P > 'Tasks: Manage Automatic Tasks in Folder' > Allow"
