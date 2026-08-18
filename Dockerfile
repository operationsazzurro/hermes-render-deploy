# Extends the official Hermes Agent image so the ops-command-center MCP
# tool server is baked into the same container (Render only deploys one
# image per service, so it's simplest to run both from here).
FROM nousresearch/hermes-agent:latest

# ---- Bake in the MCP tool server ----
COPY hermes-mcp-server /opt/mcp/hermes-mcp-server
WORKDIR /opt/mcp/hermes-mcp-server
RUN npm install --omit=dev

# ---- Config + entrypoint ----
# Render's free/starter web services have no persistent disk, so we
# regenerate config.yaml from a template every time the container starts,
# instead of relying on a mounted volume.
COPY render-entrypoint.sh /opt/render-entrypoint.sh
RUN chmod +x /opt/render-entrypoint.sh

WORKDIR /opt/data
ENTRYPOINT ["/opt/render-entrypoint.sh"]
CMD ["gateway", "run"]
