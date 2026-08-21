#!/usr/bin/env node
/**
 * Ops Command Center - MCP Tool Server
 * ------------------------------------
 * Exposes every data domain in the app as MCP tools, following one
 * consistent pattern throughout:
 *   - count_X  -> EXACT total via Postgres count, no row cap, always
 *                 accurate no matter how large the table is.
 *   - list_X   -> browsing/detail tool, capped at a generous limit
 *                 (default 500, max 2000) purely to keep responses a
 *                 sane size for the model - never a small "10" style
 *                 cap that silently hides most of the data.
 * Every list_X tool's description explicitly tells the agent to use
 * the matching count_X tool for "how many" questions instead of
 * counting rows itself, since manually counting a capped/partial list
 * is unreliable.
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
 *
 * NOTE ON app_users: deliberately NOT exposed as a tool. User accounts,
 * emails, and roles stay out of the agent's reach - manage those from
 * the app's Users tab only.
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

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
function cappedLimit(requested) {
  return Math.min(requested || DEFAULT_LIMIT, MAX_LIMIT);
}

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

// ---------------------------------------------------------------------
// Tool definitions - one count_X / list_X pair per data domain, plus a
// handful of write actions at the end.
// ---------------------------------------------------------------------

const countDesc = (thing, listTool) =>
  `Get the EXACT total number of ${thing}. Always use this tool for 'how many ${thing}' type questions instead of counting rows from ${listTool} yourself - that tool is capped for readability and manual counting from a partial list is unreliable.`;
const listDesc = (thing, countTool) =>
  `List ${thing} for browsing/detail purposes. For a total count, use ${countTool} instead - this tool is for details, not counting.`;

const tools = [
  // ---- Sites ----
  { name: "count_sites", description: countDesc("sites (optionally filtered by search term matching site name or city)", "list_sites"),
    inputSchema: { type: "object", properties: { search: { type: "string", description: "Optional text to filter site name or city" } } } },
  { name: "list_sites", description: listDesc("sites, optionally filtered by a search term matching site name or city - returns name, code, city, project, and manpower", "count_sites"),
    inputSchema: { type: "object", properties: {
      search: { type: "string", description: "Optional text to filter site name or city" },
      limit: { type: "number", description: `Max rows to return, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` },
    } } },

  // ---- Clients ----
  { name: "count_clients", description: countDesc("clients (optionally filtered by name or industry)", "list_clients"),
    inputSchema: { type: "object", properties: { search: { type: "string", description: "Optional text to filter client name or industry" } } } },
  { name: "list_clients", description: listDesc("clients with their industry and primary contact details", "count_clients"),
    inputSchema: { type: "object", properties: {
      search: { type: "string", description: "Optional text to filter client name or industry" },
      limit: { type: "number", description: `Max rows to return, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` },
    } } },

  // ---- Contracts ----
  { name: "count_contracts", description: countDesc("contracts (optionally filtered by status: active, expired, under_renewal, terminated)", "list_contracts"),
    inputSchema: { type: "object", properties: { status: { type: "string", description: "Optional status filter" } } } },
  { name: "list_contracts", description: listDesc("contracts with client name, reference, expiry, monthly value, and status", "count_contracts"),
    inputSchema: { type: "object", properties: {
      status: { type: "string", description: "Optional status filter" },
      limit: { type: "number", description: `Max rows to return, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` },
    } } },
  { name: "count_expiring_contracts", description: countDesc("contracts expiring within the next N days (default 60)", "list_expiring_contracts"),
    inputSchema: { type: "object", properties: { within_days: { type: "number", description: "Look-ahead window in days, default 60" } } } },
  { name: "list_expiring_contracts", description: listDesc("contracts expiring within the next N days (default 60), including client name and monthly value", "count_expiring_contracts"),
    inputSchema: { type: "object", properties: {
      within_days: { type: "number", description: "Look-ahead window in days, default 60" },
      limit: { type: "number", description: `Max rows to return, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` },
    } } },

  // ---- Staff ----
  { name: "count_staff", description: countDesc("staff (optionally filtered by site name and/or status: active, on_leave, exited, absconded)", "list_staff"),
    inputSchema: { type: "object", properties: {
      site_name: { type: "string", description: "Optional site name to filter by" },
      status: { type: "string", description: "Optional status filter" },
    } } },
  { name: "list_staff", description: listDesc("staff with name, site, designation, status, and contact number", "count_staff"),
    inputSchema: { type: "object", properties: {
      site_name: { type: "string", description: "Optional site name to filter by" },
      status: { type: "string", description: "Optional status filter" },
      limit: { type: "number", description: `Max rows to return, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` },
    } } },

  // ---- Invoice & WCR submissions ----
  { name: "count_invoice_submissions", description: countDesc("invoice/WCR submission entries (optionally filtered by site name)", "list_invoice_submissions"),
    inputSchema: { type: "object", properties: { site_name: { type: "string", description: "Optional site name to filter by" } } } },
  { name: "list_invoice_submissions", description: listDesc("invoice/WCR submission entries with billing month, amount, and submission status", "count_invoice_submissions"),
    inputSchema: { type: "object", properties: {
      site_name: { type: "string", description: "Optional site name to filter by" },
      limit: { type: "number", description: `Max rows to return, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` },
    } } },

  // ---- KPI ----
  { name: "count_kpi_scores", description: countDesc("KPI score entries (optionally filtered by site name)", "list_kpi_scores"),
    inputSchema: { type: "object", properties: { site_name: { type: "string", description: "Optional site name to filter by" } } } },
  { name: "list_kpi_scores", description: listDesc("KPI score entries, most recent first, with score and remarks", "count_kpi_scores"),
    inputSchema: { type: "object", properties: {
      site_name: { type: "string", description: "Optional site name to filter by" },
      limit: { type: "number", description: `Max rows to return, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` },
    } } },

  // ---- Manager site visits ----
  { name: "count_site_visits", description: countDesc("manager site visit entries (optionally filtered by status: scheduled, completed, missed, rescheduled)", "list_site_visits"),
    inputSchema: { type: "object", properties: { status: { type: "string", description: "Optional status filter" } } } },
  { name: "list_site_visits", description: listDesc("manager site visit entries with site, scheduled/actual date, status, and notes", "count_site_visits"),
    inputSchema: { type: "object", properties: {
      status: { type: "string", description: "Optional status filter" },
      limit: { type: "number", description: `Max rows to return, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` },
    } } },

  // ---- Complaints ----
  { name: "count_complaints", description: countDesc("client complaints (optionally filtered by status and/or site name; pass status='open,in_progress' for unresolved only)", "list_complaints"),
    inputSchema: { type: "object", properties: {
      status: { type: "string", description: "Optional comma-separated status filter, e.g. 'open,in_progress'" },
      site_name: { type: "string", description: "Optional site name to filter by" },
    } } },
  { name: "list_complaints", description: listDesc("client complaints with date, category, severity, status, and description", "count_complaints"),
    inputSchema: { type: "object", properties: {
      status: { type: "string", description: "Optional comma-separated status filter, e.g. 'open,in_progress'" },
      site_name: { type: "string", description: "Optional site name to filter by" },
      limit: { type: "number", description: `Max rows to return, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` },
    } } },

  // ---- Client follow-ups ----
  { name: "count_followups", description: countDesc("client follow-up entries (optionally filtered by status: pending, done, cancelled, and/or site name)", "list_followups"),
    inputSchema: { type: "object", properties: {
      status: { type: "string", description: "Optional status filter" },
      site_name: { type: "string", description: "Optional site name to filter by" },
    } } },
  { name: "list_followups", description: listDesc("client follow-up entries with contact name, dates, status, and notes", "count_followups"),
    inputSchema: { type: "object", properties: {
      status: { type: "string", description: "Optional status filter" },
      site_name: { type: "string", description: "Optional site name to filter by" },
      limit: { type: "number", description: `Max rows to return, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` },
    } } },

  // ---- Customer feedback ----
  { name: "count_feedback", description: countDesc("customer feedback submissions (optionally filtered by site name)", "list_feedback"),
    inputSchema: { type: "object", properties: { site_name: { type: "string", description: "Optional site name to filter by" } } } },
  { name: "list_feedback", description: listDesc("customer feedback submissions including per-area ratings and any 'areas of improvement' notes", "count_feedback"),
    inputSchema: { type: "object", properties: {
      site_name: { type: "string", description: "Optional site name to filter by" },
      limit: { type: "number", description: `Max rows to return, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` },
    } } },

  // ---- To-Do / reminders ----
  { name: "count_tasks", description: countDesc("to-do tasks (pass status='pending', 'done', or omit for all)", "list_tasks"),
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["pending", "done", "all"], description: "Defaults to 'pending' if omitted" } } } },
  { name: "list_tasks", description: listDesc("to-do tasks/reminders with title, due date, and notes, soonest due first (pass status='pending', 'done', or 'all')", "count_tasks"),
    inputSchema: { type: "object", properties: {
      status: { type: "string", enum: ["pending", "done", "all"], description: "Defaults to 'pending' if omitted" },
      limit: { type: "number", description: `Max rows to return, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` },
    } } },

  // ---- Org structure ----
  { name: "count_org_people", description: countDesc("people in the org structure (optionally filtered by name or designation)", "list_org_people"),
    inputSchema: { type: "object", properties: { search: { type: "string", description: "Optional text to filter name or designation" } } } },
  { name: "list_org_people", description: listDesc("people in the org structure with name, designation, department, and contact info", "count_org_people"),
    inputSchema: { type: "object", properties: {
      search: { type: "string", description: "Optional text to filter name or designation" },
      limit: { type: "number", description: `Max rows to return, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` },
    } } },

  // ---- Write actions ----
  { name: "create_task", description: "Create a to-do task/reminder in the Ops Command Center.",
    inputSchema: { type: "object", properties: {
      title: { type: "string", description: "Short task title" },
      description: { type: "string", description: "Optional longer description" },
      due_date: { type: "string", description: "ISO date/time this is due, e.g. 2026-08-20T17:00:00" },
    }, required: ["title", "due_date"] } },
  { name: "log_complaint", description: "Log a new client complaint against a site.",
    inputSchema: { type: "object", properties: {
      site_name: { type: "string", description: "Exact site name to attach the complaint to" },
      category: { type: "string", description: "Complaint category, e.g. Staff, Quality, Billing" },
      description: { type: "string", description: "Details of the complaint" },
      severity: { type: "string", enum: ["low", "medium", "high", "critical"], description: "Default medium" },
      raised_by: { type: "string", description: "Who raised it, optional" },
    }, required: ["site_name", "description"] } },
];

// ---------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------

async function handleToolCall(name, args) {
  switch (name) {
    // ---- Sites ----
    case "count_sites": {
      let q = sb.from("sites").select("*", { count: "exact", head: true });
      if (args.search) q = q.or(`site_name.ilike.%${args.search}%,city.ilike.%${args.search}%`);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return { total_sites: count };
    }
    case "list_sites": {
      let q = sb.from("sites").select("site_name, site_code, city, emirate_or_state, manpower_required, projects(project_name)");
      if (args.search) q = q.or(`site_name.ilike.%${args.search}%,city.ilike.%${args.search}%`);
      const { data, error } = await q.limit(cappedLimit(args.limit));
      if (error) throw new Error(error.message);
      return data;
    }

    // ---- Clients ----
    case "count_clients": {
      let q = sb.from("clients").select("*", { count: "exact", head: true });
      if (args.search) q = q.or(`client_name.ilike.%${args.search}%,industry.ilike.%${args.search}%`);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return { total_clients: count };
    }
    case "list_clients": {
      let q = sb.from("clients").select("client_name, industry, primary_contact_name, primary_contact_email, primary_contact_phone");
      if (args.search) q = q.or(`client_name.ilike.%${args.search}%,industry.ilike.%${args.search}%`);
      const { data, error } = await q.limit(cappedLimit(args.limit));
      if (error) throw new Error(error.message);
      return data;
    }

    // ---- Contracts ----
    case "count_contracts": {
      let q = sb.from("contracts").select("*", { count: "exact", head: true });
      if (args.status) q = q.eq("status", args.status);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return { total_contracts: count };
    }
    case "list_contracts": {
      let q = sb.from("contracts").select("contract_ref, contract_expiry, monthly_invoice_value, status, clients(client_name)");
      if (args.status) q = q.eq("status", args.status);
      const { data, error } = await q.limit(cappedLimit(args.limit));
      if (error) throw new Error(error.message);
      return data;
    }
    case "count_expiring_contracts": {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + (args.within_days || 60));
      const { count, error } = await sb.from("contracts").select("*", { count: "exact", head: true })
        .lte("contract_expiry", cutoff.toISOString().slice(0, 10));
      if (error) throw new Error(error.message);
      return { total_expiring_contracts: count };
    }
    case "list_expiring_contracts": {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + (args.within_days || 60));
      const { data, error } = await sb.from("contracts")
        .select("contract_ref, contract_expiry, monthly_invoice_value, status, clients(client_name)")
        .lte("contract_expiry", cutoff.toISOString().slice(0, 10))
        .order("contract_expiry", { ascending: true })
        .limit(cappedLimit(args.limit));
      if (error) throw new Error(error.message);
      return data;
    }

    // ---- Staff ----
    case "count_staff": {
      let q = sb.from("staff").select("*", { count: "exact", head: true });
      if (args.status) q = q.eq("status", args.status);
      if (args.site_name) q = q.eq("site_id", (await findSiteIdByName(args.site_name)).id);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return { total_staff: count };
    }
    case "list_staff": {
      let q = sb.from("staff").select("full_name, designation, status, contact_number, sites(site_name)");
      if (args.status) q = q.eq("status", args.status);
      if (args.site_name) q = q.eq("site_id", (await findSiteIdByName(args.site_name)).id);
      const { data, error } = await q.limit(cappedLimit(args.limit));
      if (error) throw new Error(error.message);
      return data;
    }

    // ---- Invoice & WCR ----
    case "count_invoice_submissions": {
      let q = sb.from("invoice_wcr_submissions").select("*", { count: "exact", head: true });
      if (args.site_name) q = q.eq("site_id", (await findSiteIdByName(args.site_name)).id);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return { total_invoice_submissions: count };
    }
    case "list_invoice_submissions": {
      let q = sb.from("invoice_wcr_submissions").select("billing_month, invoice_amount, invoice_submitted, wcr_submitted, remarks, sites(site_name)");
      if (args.site_name) q = q.eq("site_id", (await findSiteIdByName(args.site_name)).id);
      const { data, error } = await q.order("billing_month", { ascending: false }).limit(cappedLimit(args.limit));
      if (error) throw new Error(error.message);
      return data;
    }

    // ---- KPI ----
    case "count_kpi_scores": {
      let q = sb.from("kpi_updates").select("*", { count: "exact", head: true });
      if (args.site_name) q = q.eq("site_id", (await findSiteIdByName(args.site_name)).id);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return { total_kpi_scores: count };
    }
    case "list_kpi_scores": {
      let q = sb.from("kpi_updates").select("review_month, kpi_score, remarks, sites(site_name)");
      if (args.site_name) q = q.eq("site_id", (await findSiteIdByName(args.site_name)).id);
      const { data, error } = await q.order("review_month", { ascending: false }).limit(cappedLimit(args.limit));
      if (error) throw new Error(error.message);
      return data;
    }

    // ---- Manager site visits ----
    case "count_site_visits": {
      let q = sb.from("manager_site_visits").select("*", { count: "exact", head: true });
      if (args.status) q = q.eq("status", args.status);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return { total_site_visits: count };
    }
    case "list_site_visits": {
      let q = sb.from("manager_site_visits").select("scheduled_date, actual_visit_date, status, visit_notes, sites(site_name)");
      if (args.status) q = q.eq("status", args.status);
      const { data, error } = await q.order("scheduled_date", { ascending: false }).limit(cappedLimit(args.limit));
      if (error) throw new Error(error.message);
      return data;
    }

    // ---- Complaints ----
    case "count_complaints": {
      let q = sb.from("client_complaints").select("*", { count: "exact", head: true });
      if (args.status) q = q.in("status", args.status.split(",").map(s => s.trim()));
      if (args.site_name) q = q.eq("site_id", (await findSiteIdByName(args.site_name)).id);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return { total_complaints: count };
    }
    case "list_complaints": {
      let q = sb.from("client_complaints").select("date_raised, category, description, severity, status, sites(site_name)");
      if (args.status) q = q.in("status", args.status.split(",").map(s => s.trim()));
      if (args.site_name) q = q.eq("site_id", (await findSiteIdByName(args.site_name)).id);
      const { data, error } = await q.order("date_raised", { ascending: false }).limit(cappedLimit(args.limit));
      if (error) throw new Error(error.message);
      return data;
    }

    // ---- Follow-ups ----
    case "count_followups": {
      let q = sb.from("client_followups").select("*", { count: "exact", head: true });
      if (args.status) q = q.eq("status", args.status);
      if (args.site_name) q = q.eq("site_id", (await findSiteIdByName(args.site_name)).id);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return { total_followups: count };
    }
    case "list_followups": {
      let q = sb.from("client_followups").select("client_contact_name, followup_date, next_action_date, status, notes, sites(site_name)");
      if (args.status) q = q.eq("status", args.status);
      if (args.site_name) q = q.eq("site_id", (await findSiteIdByName(args.site_name)).id);
      const { data, error } = await q.order("followup_date", { ascending: false }).limit(cappedLimit(args.limit));
      if (error) throw new Error(error.message);
      return data;
    }

    // ---- Feedback ----
    case "count_feedback": {
      let q = sb.from("customer_feedback").select("*", { count: "exact", head: true });
      if (args.site_name) q = q.eq("site_id", (await findSiteIdByName(args.site_name)).id);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return { total_feedback: count };
    }
    case "list_feedback": {
      let q = sb.from("customer_feedback").select("reporting_period, client_name, areas_of_improvement, sites(site_name), customer_feedback_ratings(area, rating, remarks)");
      if (args.site_name) q = q.eq("site_id", (await findSiteIdByName(args.site_name)).id);
      const { data, error } = await q.order("reporting_period", { ascending: false }).limit(cappedLimit(args.limit));
      if (error) throw new Error(error.message);
      return data;
    }

    // ---- Tasks / reminders ----
    case "count_tasks": {
      let q = sb.from("reminders").select("*", { count: "exact", head: true });
      const status = args.status || "pending";
      if (status === "pending") q = q.eq("is_done", false);
      else if (status === "done") q = q.eq("is_done", true);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return { total_tasks: count, status_filter: status };
    }
    case "list_tasks": {
      let q = sb.from("reminders").select("title, description, due_date, is_done, created_at");
      const status = args.status || "pending";
      if (status === "pending") q = q.eq("is_done", false);
      else if (status === "done") q = q.eq("is_done", true);
      const { data, error } = await q.order("due_date", { ascending: true }).limit(cappedLimit(args.limit));
      if (error) throw new Error(error.message);
      return data;
    }

    // ---- Org structure ----
    case "count_org_people": {
      let q = sb.from("org_hierarchy").select("*", { count: "exact", head: true });
      if (args.search) q = q.or(`full_name.ilike.%${args.search}%,designation.ilike.%${args.search}%`);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return { total_org_people: count };
    }
    case "list_org_people": {
      let q = sb.from("org_hierarchy").select("full_name, designation, department, email, phone");
      if (args.search) q = q.or(`full_name.ilike.%${args.search}%,designation.ilike.%${args.search}%`);
      const { data, error } = await q.limit(cappedLimit(args.limit));
      if (error) throw new Error(error.message);
      return data;
    }

    // ---- Write actions ----
    case "create_task": {
      const { data, error } = await sb.from("reminders").insert({
        title: args.title,
        description: args.description || null,
        due_date: args.due_date,
      }).select().single();
      if (error) throw new Error(error.message);
      return { created: true, task: data };
    }
    case "log_complaint": {
      const site = await findSiteIdByName(args.site_name);
      const { data, error } = await sb.from("client_complaints").insert({
        site_id: site.id,
        date_raised: new Date().toISOString().slice(0, 10),
        category: args.category || null,
        description: args.description,
        severity: args.severity || "medium",
        raised_by: args.raised_by || null,
      }).select().single();
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
  { name: "ops-command-center-mcp", version: "2.0.0" },
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
