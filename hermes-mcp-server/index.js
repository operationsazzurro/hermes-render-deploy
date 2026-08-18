#!/usr/bin/env node
/**
 * Ops Command Center - MCP Tool Server
 * ------------------------------------
 * Exposes the Supabase-backed ops data (sites, complaints, feedback, KPIs,
 * contracts, reminders) as MCP tools that Hermes Agent can call.
 *
 * SETUP
 *   1. cd hermes-mcp-server && npm install
 *   2. Set these two environment variables (put them in Hermes's
 *      ~/.hermes/.env so config.yaml can reference them with ${VAR}):
 *        SUPABASE_URL=https://rvqhzfxotyiphundbagm.supabase.co
 *        SUPABASE_SERVICE_ROLE_KEY=<service_role key from Supabase Settings -> API>
 *   3. IMPORTANT: use the SERVICE ROLE key here, not the publishable/anon
 *      key. This server runs on your own machine, never in a browser, so
 *      it's safe to hold a privileged key - and it needs to bypass RLS
 *      to read data cleanly (your RLS requires an authenticated session,
 *      which a server-side agent doesn't have). Never put the service
 *      role key in index.html or anywhere browser-facing.
 *   4. Register it in ~/.hermes/config.yaml, see hermes-config-snippet.yaml
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables."
  );
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------

const tools = [
  {
    name: "list_sites",
    description:
      "List all sites, optionally filtered by a search term matching the site name or city. Returns site name, code, city, project, and manpower.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional text to filter site name or city" },
      },
    },
  },
  {
    name: "get_open_complaints",
    description:
      "List client complaints that are not yet resolved (status open or in_progress), most recent first. Optionally filter by site name.",
    inputSchema: {
      type: "object",
      properties: {
        site_name: { type: "string", description: "Optional site name to filter by" },
        limit: { type: "number", description: "Max rows to return, default 20" },
      },
    },
  },
  {
    name: "get_recent_feedback",
    description:
      "Get recent customer feedback submissions including their per-area ratings and any 'areas of improvement' notes.",
    inputSchema: {
      type: "object",
      properties: {
        site_name: { type: "string", description: "Optional site name to filter by" },
        limit: { type: "number", description: "Max rows to return, default 10" },
      },
    },
  },
  {
    name: "get_expiring_contracts",
    description:
      "List contracts expiring within the next N days (default 60), including client name and monthly value.",
    inputSchema: {
      type: "object",
      properties: {
        within_days: { type: "number", description: "Look-ahead window in days, default 60" },
      },
    },
  },
  {
    name: "get_kpi_scores",
    description:
      "Get the most recent KPI score(s) for a site, or across all sites if no site is given.",
    inputSchema: {
      type: "object",
      properties: {
        site_name: { type: "string", description: "Optional site name to filter by" },
        limit: { type: "number", description: "Max rows to return, default 20" },
      },
    },
  },
  {
    name: "create_reminder",
    description:
      "Create a reminder/task in the Ops Command Center reminders list.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short reminder title" },
        description: { type: "string", description: "Optional longer description" },
        due_date: { type: "string", description: "ISO date/time this is due, e.g. 2026-08-20" },
      },
      required: ["title", "due_date"],
    },
  },
  {
    name: "log_complaint",
    description:
      "Log a new client complaint against a site.",
    inputSchema: {
      type: "object",
      properties: {
        site_name: { type: "string", description: "Exact site name to attach the complaint to" },
        category: { type: "string", description: "Complaint category, e.g. Staff, Quality, Billing" },
        description: { type: "string", description: "Details of the complaint" },
        severity: { type: "string", enum: ["low", "medium", "high", "critical"], description: "Default medium" },
        raised_by: { type: "string", description: "Who raised it, optional" },
      },
      required: ["site_name", "description"],
    },
  },
];

// ---------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------

async function findSiteIdByName(name) {
  const { data, error } = await sb
    .from("sites")
    .select("id, site_name")
    .ilike("site_name", `%${name}%`)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No site found matching "${name}"`);
  return data;
}

async function handleToolCall(name, args) {
  switch (name) {
    case "list_sites": {
      let q = sb.from("sites").select("site_name, site_code, city, emirate_or_state, manpower_required, projects(project_name)");
      if (args.search) q = q.or(`site_name.ilike.%${args.search}%,city.ilike.%${args.search}%`);
      const { data, error } = await q.limit(100);
      if (error) throw new Error(error.message);
      return data;
    }

    case "get_open_complaints": {
      let q = sb
        .from("client_complaints")
        .select("date_raised, category, description, severity, status, sites(site_name)")
        .in("status", ["open", "in_progress"])
        .order("date_raised", { ascending: false })
        .limit(args.limit || 20);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      let rows = data;
      if (args.site_name) {
        rows = rows.filter((r) =>
          r.sites?.site_name?.toLowerCase().includes(args.site_name.toLowerCase())
        );
      }
      return rows;
    }

    case "get_recent_feedback": {
      let q = sb
        .from("customer_feedback")
        .select("reporting_period, client_name, areas_of_improvement, sites(site_name), customer_feedback_ratings(area, rating, remarks)")
        .order("reporting_period", { ascending: false })
        .limit(args.limit || 10);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      let rows = data;
      if (args.site_name) {
        rows = rows.filter((r) =>
          r.sites?.site_name?.toLowerCase().includes(args.site_name.toLowerCase())
        );
      }
      return rows;
    }

    case "get_expiring_contracts": {
      const withinDays = args.within_days || 60;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + withinDays);
      const { data, error } = await sb
        .from("contracts")
        .select("contract_ref, contract_expiry, monthly_invoice_value, status, clients(client_name)")
        .lte("contract_expiry", cutoff.toISOString().slice(0, 10))
        .order("contract_expiry", { ascending: true });
      if (error) throw new Error(error.message);
      return data;
    }

    case "get_kpi_scores": {
      let q = sb
        .from("kpi_updates")
        .select("review_month, kpi_score, category_scores, remarks, sites(site_name)")
        .order("review_month", { ascending: false })
        .limit(args.limit || 20);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      let rows = data;
      if (args.site_name) {
        rows = rows.filter((r) =>
          r.sites?.site_name?.toLowerCase().includes(args.site_name.toLowerCase())
        );
      }
      return rows;
    }

    case "create_reminder": {
      const { data, error } = await sb
        .from("reminders")
        .insert({
          title: args.title,
          description: args.description || null,
          due_date: args.due_date,
        })
        .select()
        .single();
      if (error) throw new Error(error.message);
      return { created: true, reminder: data };
    }

    case "log_complaint": {
      const site = await findSiteIdByName(args.site_name);
      const { data, error } = await sb
        .from("client_complaints")
        .insert({
          site_id: site.id,
          date_raised: new Date().toISOString().slice(0, 10),
          category: args.category || null,
          description: args.description,
          severity: args.severity || "medium",
          raised_by: args.raised_by || null,
        })
        .select()
        .single();
      if (error) throw new Error(error.message);
      return { created: true, complaint: data, matched_site: site.site_name };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------

const server = new Server(
  { name: "ops-command-center-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleToolCall(name, args || {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Ops Command Center MCP server running on stdio.");
