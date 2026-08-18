# Ops Command Center - MCP Tool Server

Gives Hermes Agent real, live access to your Supabase data: sites,
complaints, feedback, contracts, and KPIs - plus two write actions
(create a reminder, log a complaint).

## Tools exposed

| Tool | What it does |
|---|---|
| `list_sites` | List/search sites |
| `get_open_complaints` | Complaints not yet resolved |
| `get_recent_feedback` | Recent customer feedback + ratings |
| `get_expiring_contracts` | Contracts expiring soon |
| `get_kpi_scores` | Recent KPI scores per site |
| `create_reminder` | Adds a reminder (write) |
| `log_complaint` | Logs a new complaint (write) |

## Setup

```bash
cd hermes-mcp-server
npm install
```

Get your Supabase **service_role** key: Supabase Dashboard → Project
Settings → API → `service_role` (this is different from the
`anon`/`publishable` key already used in your app - keep this one secret,
it bypasses Row Level Security, and it must never appear in index.html or
any browser-facing file).

Add to `~/.hermes/.env`:

```
SUPABASE_URL=https://rvqhzfxotyiphundbagm.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<paste it here>
```

Add the block from `hermes-config-snippet.yaml` into
`~/.hermes/config.yaml` (update the path in `args` to wherever you put
this folder).

Restart Hermes, then:

```bash
hermes tools list
```

You should see tools like `mcp_opscommandcenter_list_sites`. Try asking
Hermes something like *"any open complaints this week?"* or *"what
contracts are expiring in the next 30 days?"*.

## Extending it

To add more tools (e.g. staff headcount by site, invoice/WCR submission
status), copy the pattern in `index.js`: add an entry to the `tools`
array with an `inputSchema`, then a matching `case` in `handleToolCall`.
