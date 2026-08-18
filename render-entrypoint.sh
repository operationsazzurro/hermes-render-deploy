#!/bin/sh
# Regenerates ~/.hermes (/opt/data) config on every container start, since
# Render's free/Starter tier has no persistent disk. All secrets come from
# Render's environment variables (set them in the Render dashboard, never
# commit them into this repo).
set -e

mkdir -p /opt/data

cat > /opt/data/config.yaml <<EOF

# ============================================================
# MAIN AI MODEL
# ============================================================

model:
  default: "nvidia/nemotron-3-ultra-550b-a55b:free"
  provider: "openrouter"

mcp_servers:
  opscommandcenter:
    command: "node"
    args: ["/opt/mcp/hermes-mcp-server/index.js"]
    env:
      SUPABASE_URL: "${SUPABASE_URL}"
      SUPABASE_SERVICE_ROLE_KEY: "${SUPABASE_SERVICE_ROLE_KEY}"
    timeout: 60
EOF

echo "===== Hermes config ====="
cat /opt/data/config.yaml
echo "========================="

echo "===== Hermes version ====="
hermes --version || true
echo "=========================="

echo "===== Hermes config check ====="
hermes config check || true
echo "================================"

# API_SERVER_ENABLED / API_SERVER_KEY / API_SERVER_HOST / API_SERVER_PORT
# and the model provider key are read directly from the environment -
# Render injects the values you set in its dashboard, no .env file needed.

exec hermes "$@"
