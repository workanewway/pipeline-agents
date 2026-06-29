/**
 * lib/pipeline-common.ts
 * Shared config + Sheet I/O for the pipeline agents. Imported by every route.
 * ESM project: import with the explicit ".js" extension.
 */

import { google } from "googleapis";

export const SHEET_ID = process.env.SHEET_ID!;
export const TAB = process.env.SHEET_TAB || "Queue";
export const SHEET_GID = process.env.SHEET_GID || "0";
export const DEFAULT_MODEL = "claude-sonnet-4-6"; // swap to "claude-opus-4-8" where reasoning matters most

/** Only the cron scheduler (or a caller holding the secret) may trigger a route.
 *  If CRON_SECRET isn't set, routes are open — fine for first tests, set it before going live. */
export function cronAuthorized(authHeader?: string): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return authHeader === `Bearer ${secret}`;
}

/** AI-NATIVE FIRST. Injected into the strategist + design prompts so the bias holds pipeline-wide. */
export const AI_NATIVE_DIRECTIVE = `Design AI-native first. The core value of every product must come from LLM/agent
capabilities - reasoning, language understanding, extraction, conversation, synthesis, judgment - NOT from
hand-coded deterministic logic. Default to an agentic or model-driven approach; the burden of proof is on
NOT using one. Do not propose a CRUD app, a rules engine, a form-and-dashboard, or a static workflow when an
agent could do the job more flexibly. Use conventional code only for (a) scaffolding around the AI - storage,
auth, integrations, deploy - and (b) the narrow places where determinism, exact accuracy, or cost genuinely
demand it; when you fall back to conventional logic, state why in one line.

SCOPE FIDELITY (overrides the bias above). Honor what the idea actually asks for. A reposition, rename,
restyle, layout, copy, refactor, bugfix, or other maintenance change is NOT a license to introduce a new
agent, a new data model, a new auth system, or a parallel feature. Implement it at the scope requested and
REUSE the surfaces that already exist (see the project's architecture). If applying the AI-native bias would
expand a small change into new subsystems, that is a signal you have over-scoped — pull back to the idea.

NO ASSUMING UNBUILT INFRASTRUCTURE. Design only against capabilities the project actually has today. If a
design would require something not yet built (e.g. per-user auth where only tenant auth exists), STOP and
name it as an explicit dependency in the brief ("ships as foundation (blocked by: <dep>)") rather than
silently assuming it into existence.`;

export type Deploy = "one-tap" | "preview-only" | "design-only";

export interface Project {
  name: string;
  kind: "product" | "client-engagement";
  context: string;
  focus: string[];
  repo: string;
  deploy: Deploy;
}

export const PROJECTS: Project[] = [
  {
    name: "Broker Platform",
    kind: "product",
    context: `Your standalone multi-tenant SaaS for freight brokers. Produces court-ready,
tamper-evident records of "reasonable care" in carrier selection - a compliance tool after
Montgomery v. Caribe Transport II (May 2026) let safety-based negligent-selection claims through
the FAAAA preemption safety exception. Sold broadly to SMB brokers; not built for any single broker.

ARCHITECTURE — design WITHIN this exact stack; do not substitute a different one.
- Backend: serverless TypeScript functions on Vercel, one file per route under api/ in
  github.com/workanewway/vetting-platform-api (e.g. api/vettings/[id]/assess.ts). This is NOT Next.js,
  NOT an app/ router, NOT React Server Components. New endpoints follow the canonical apply.ts pattern:
  handler signature (req, _res, ctx); wrap with withHandler(handler, { methods: [...] }); use
  getSupabase() (never a bare client); throw errors.xxx() (never sendError); return plain objects
  (never res.json()); EVERY relative import carries an explicit .js extension; long jobs set
  "export const maxDuration". Do NOT import @anthropic-ai/sdk inside an endpoint — call the Anthropic
  REST API with native fetch.
- Data: Supabase (Postgres) with row-level security scoped by current_tenant_id(); Cloudflare R2 for
  documents; FMCSA QCMobile as the authoritative carrier source. Core entities are tenant-scoped
  (drivers, policies, verifications) plus the vettings table whose "conversation" column is POLYMORPHIC
  (classic chat turns AND type:'file' event turns — any iterator must handle both).
- Auth: TENANT-level only. A tenant access code (hashed in access_code_hash) yields an API key the
  browser stores and sends on each call. There is NO per-user auth — no auth.users, no user_id
  ownership, no cookie sessions, no createServerClient, no on_auth_user_created trigger. Per-user auth
  is a DEFERRED roadmap item: a design MUST NOT assume it exists. Scope ownership by tenant, not user.
- Frontend: static HTML pages on GoDaddy cPanel at workanewway.com/broker-platform/ (workspace.html,
  connect.html, vetting.html, vettings.html), plain vanilla JS calling the API with the tenant key.
  NO React, no Next.js, no hooks, no component framework, no Vercel AI SDK.

BUILD ON WHAT EXISTS — do not reinvent it. The workspace already has an "✦ Ask AI" conversation dock
backed by the vettings.conversation column. Ideas about that assistant must MODIFY the existing dock and
its endpoints in place — never spec a new conversations/messages data model or a parallel chat system.
Internal test tenants are "bivium" and "acme" (not real customers).`,
    focus: [
      "FMCSA / freight broker compliance regulation changes",
      "negligent carrier selection liability case law and broker litigation",
      "carrier vetting / fraud / double-brokering / chameleon carrier trends",
      "competitor moves: Highway, MyCarrierPackets, Carrier411, RMIS, Truckstop RAS, DAT",
      "freight broker software workflow pain points and feature gaps",
      "practitioner discussions: TheTruckersReport, InsideTransport, carrier/broker forums",
    ],
    repo: "github.com/workanewway/vetting-platform-api",
    deploy: "one-tap",
  },
  {
    name: "Roofing Proposals",
    kind: "client-engagement",
    context: `An automated sales-proposal system for a roofing client (Reliable Roofing). A
discovery interview agent gathers job details; the system produces customer-ready proposals
(PPTX -> PDF) faster and more consistently than the sales team does by hand. Runs on the
existing PHP proxy infrastructure at workanewway.com.`,
    focus: [
      "roofing sales and estimating workflow best practices",
      "contractor proposal tools and quote-to-close conversion tactics",
      "roofing materials pricing and industry trends",
      "homeowner buying signals and objection handling in roofing sales",
    ],
    repo: "workanewway.com PHP proxy infra (client-facing)",
    deploy: "design-only",
  },
  {
    name: "United Transportation",
    kind: "client-engagement",
    context: `Dispatch automation for a freight client (United Transportation). A live operation:
an AI dispatch/export-document agent, an iPad-optimized driver app, warehouse ops, and an executive
dashboard. Phase 1 already saves the client ~8 hours/day of manual dispatch work. Production system,
paying client.`,
    focus: [
      "freight dispatch automation and intake workflows",
      "export / customs documentation automation",
      "driver app UX patterns for owner-operators",
      "warehouse operations digitization",
      "TMS and logistics tooling integrations",
    ],
    repo: "client systems (Lindy AI + Notion + driver app)",
    deploy: "design-only",
  },
];

export const projectByName = (name: string) => PROJECTS.find((p) => p.name === name);

// Column contract (A..AB). Writers rely on order; readers map by header.
export const COLUMNS = [
  "Idea ID", "Title", "Stage", "Source", "Product", "Priority Score",
  "Priority Rationale", "Reasoning", "AI-Native Approach", "Evidence / Sources",
  "Open Questions", "Design Brief", "Design Output", "Build Sequence", "Repo + Target",
  "Review", "Review Feedback", "Revisions", "Review Log", "Decided At",
  "Build Status", "Test Results", "Preview URL", "Prod URL", "PR / Commit",
  "Blocked Reason", "Created At", "Updated At",
] as const;

export type ColumnName = (typeof COLUMNS)[number];
export const colIndex = (name: ColumnName) => COLUMNS.indexOf(name);

export function a1(zeroBasedColIndex: number): string {
  let idx = zeroBasedColIndex + 1;
  let s = "";
  while (idx > 0) {
    const m = (idx - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    idx = Math.floor((idx - 1) / 26);
  }
  return s;
}

export const newRow = (): string[] => new Array(COLUMNS.length).fill("");
export function setCell(row: string[], name: ColumnName, value: string): string[] {
  row[colIndex(name)] = value;
  return row;
}

export function getSheets(readonly = false) {
  return google.sheets({
    version: "v4",
    auth: new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY!),
      scopes: [
        readonly
          ? "https://www.googleapis.com/auth/spreadsheets.readonly"
          : "https://www.googleapis.com/auth/spreadsheets",
      ],
    }),
  });
}

type Sheets = ReturnType<typeof getSheets>;

export interface QueueRow {
  rowNum: number;
  get: (name: string) => string;
}

export async function readQueue(sheets: Sheets): Promise<{ headers: string[]; rows: QueueRow[] }> {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!A1:AB` });
  const values = res.data.values ?? [];
  const headers = (values[0] ?? []).map((h: string) => String(h).trim());
  const at = (name: string) => headers.indexOf(name);
  const rows: QueueRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    rows.push({ rowNum: i + 1, get: (name) => (at(name) >= 0 ? r[at(name)] ?? "" : "") });
  }
  return { headers, rows };
}

export async function updateCells(sheets: Sheets, rowNum: number, updates: Partial<Record<ColumnName, string>>) {
  const data = Object.entries(updates).map(([name, value]) => ({
    range: `${TAB}!${a1(colIndex(name as ColumnName))}${rowNum}`,
    values: [[value as string]],
  }));
  if (!data.length) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: "USER_ENTERED", data },
  });
}
