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
  if (!secret) {
    // No secret configured. Fail OPEN only outside production (dev/preview convenience).
    // In production a missing CRON_SECRET is a misconfiguration, NOT a reason to wave
    // everyone through — the watcher fires real builds and research spends real money.
    // Fail CLOSED so the mistake is loud (routes 401) instead of silently wide open.
    return process.env.VERCEL_ENV !== "production";
  }
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

NO PRODUCT NAME. This product has NO finalized public brand name. NEVER invent, assume, or render a
product/brand name (no "FreightVet", no codename) in any label, placeholder, header, copy, or UI string.
Refer to it generically ("the platform"). Likewise NEVER surface a tenant/client's name in product UI.
Apply only neutral, professional styling — never a name.

ARCHITECTURE — design WITHIN this exact stack; do not substitute a different one.
- Backend: serverless TypeScript functions on Vercel, one file per route under api/ in
  github.com/workanewway/vetting-platform-api (e.g. api/vettings/[id]/assess.ts). NOT Next.js, NOT an
  app/ router, NOT React Server Components. New endpoints follow the canonical apply.ts pattern:
  handler signature (req, _res, ctx); wrap with withHandler(handler, { methods: [...] }); use
  getSupabase() (never a bare client); throw errors.xxx() (never sendError); return plain objects
  (never res.json()); EVERY relative import carries an explicit .js extension; long jobs set
  "export const maxDuration". Do NOT import @anthropic-ai/sdk inside an endpoint — call the Anthropic
  REST API with native fetch.
- Data: Supabase (Postgres) with row-level security; carriers are GLOBAL, but vettings / documents /
  audit are TENANT-scoped (scoped by current_tenant_id() — don't break tenant isolation). Cloudflare R2
  for documents; FMCSA QCMobile as the authoritative carrier source. The vettings table's "conversation"
  column is POLYMORPHIC (classic chat turns AND type:'file' event turns — any iterator must handle both).
- Auth: TENANT-level only. A tenant access code (hashed in access_code_hash) yields an API key the
  browser stores and sends on each call. There is NO per-user auth — no auth.users, no user_id
  ownership, no cookie sessions, no createServerClient, no login.html. Per-user auth (JWT alongside the
  API key, login.html replacing connect.html) is a DEFERRED roadmap item: a design MUST NOT assume it
  exists. Scope ownership by tenant, not user.
- Frontend: static HTML pages on GoDaddy cPanel at workanewway.com, plain vanilla JS calling the API
  with the tenant key (no React, no Next.js, no hooks, no component framework, no Vercel AI SDK). The
  pages are mapped below.

SURFACE MAP — target the right file from this map; do NOT infer the file from the idea's wording. The
similar names (workspace.html / vetting.html / vettings.html) are a trap. If an idea names a surface
that is NOT in this map, ask "which file?" as an open question rather than picking one.
- workspace.html — the carrier-vetting WORKSPACE: a SINGLE-vetting view (one carrier / one vetting at a
  time; ONE conversation thread per vetting — NOT a multi-pane or tabbed multi-carrier view). It is the
  current surface where a vetting is reviewed. THIS is where the "✦ Ask AI" conversation dock lives
  (backed by the vettings.conversation column), alongside the AI recommendation band, severity-tiered
  findings, and the data-sources rail. ANY change to the assistant / chat / conversation dock targets
  workspace.html.
- connect.html — access-code gate: mints/stores the tenant API key, then redirects.
- vetting.html — the linear vetting walkthrough / flow (backend-wired).
- vettings.html — records retrieval: search, detail, re-download the compliance PDF.
- DO NOT TOUCH vetting_walkthrough.html or general_proxy.php — that is the OLD credential-free demo.

BUILD ON WHAT EXISTS — do not reinvent it. The "✦ Ask AI" dock (workspace.html, backed by
vettings.conversation) already works. Ideas about that assistant MODIFY the existing dock and its
endpoints in place — never spec a new conversations/messages data model or a parallel chat system.
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

// ---------------------------------------------------------------------------
// Per-project research toggle.
// Stored in a separate "Config" tab in the same spreadsheet so it can be flipped
// from the Foundry board (or by hand) WITHOUT a code deploy. Schema:
//   A: Project              B: Research Enabled (TRUE / FALSE)
// Default is OFF: a project that isn't listed, or isn't set TRUE, does NOT auto-
// research. Research is opt-in per project — fail-safe toward "don't generate".
// ---------------------------------------------------------------------------
export const CONFIG_TAB = process.env.SHEET_CONFIG_TAB || "Config";

const isTrue = (v: any) => /^(true|yes|on|1)$/i.test(String(v ?? "").trim());

export async function readResearchEnabled(sheets: Sheets): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${CONFIG_TAB}!A2:B1000` });
    for (const row of res.data.values ?? []) {
      const name = String(row[0] || "").trim();
      if (name) map.set(name, isTrue(row[1]));
    }
  } catch {
    // No Config tab yet (or unreadable) -> empty map -> everything defaults OFF.
  }
  return map;
}

// Upsert one project's flag. Creates the Config tab + header on first write.
export async function setResearchEnabled(sheets: Sheets, project: string, enabled: boolean): Promise<void> {
  try {
    await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${CONFIG_TAB}!A1` });
  } catch {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: CONFIG_TAB } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${CONFIG_TAB}!A1:B1`,
      valueInputOption: "USER_ENTERED", requestBody: { values: [["Project", "Research Enabled"]] },
    });
  }
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${CONFIG_TAB}!A2:A1000` });
  const names = (res.data.values ?? []).map((r) => String(r[0] || "").trim());
  const at = names.findIndex((n) => n === project);
  const value = enabled ? "TRUE" : "FALSE";
  if (at >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${CONFIG_TAB}!B${at + 2}`,
      valueInputOption: "USER_ENTERED", requestBody: { values: [[value]] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${CONFIG_TAB}!A:B`,
      valueInputOption: "USER_ENTERED", requestBody: { values: [[project, value]] },
    });
  }
}

// ---------------------------------------------------------------------------
// Live repo manifest — grounds the pre-build stages in what ACTUALLY exists in the
// build-target repo, instead of reasoning from the hand-written context alone (which
// silently drifts). Pages (.html) and endpoints (api/*.ts) get a one-line descriptor
// pulled from their OWN leading title/comment — self-documenting, so it never drifts;
// other source (lib/, supabase/) is listed as bare paths. Cost: resolve branch (1 call)
// + recursive tree (1) + a capped content fetch per high-value file. Cached per
// repo@branch for the warm life of the serverless instance. Fails SOFT: any error
// returns a short "(unavailable)" note so research/design degrade to prior behavior
// (reason from context only) rather than crashing.
// ---------------------------------------------------------------------------
const _manifestCache = new Map<string, { text: string; at: number }>();
const MANIFEST_TTL_MS = 5 * 60 * 1000;

// "github.com/workanewway/vetting-platform-api" -> "workanewway/vetting-platform-api"
export function ghRepoSlug(repo: string): string {
  return repo.replace(/^https?:\/\//, "").replace(/^github\.com\//, "").replace(/\.git$/, "").trim();
}
export const isGithubRepo = (repo: string) => /(^|\/)github\.com\//.test(repo) || /^[\w.-]+\/[\w.-]+$/.test(repo);

async function ghJson(url: string, token: string): Promise<any> {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "pipeline-manifest" },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status} (${(await r.text()).slice(0, 120)})`);
  return r.json();
}

// short descriptor from a file's leading title/comment
function descriptorFrom(path: string, content: string): string {
  if (path.endsWith(".html")) {
    const title = content.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (title && title[1].trim()) return title[1].trim().slice(0, 110);
    const h1 = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1) return h1[1].replace(/<[^>]+>/g, "").trim().slice(0, 110);
    const cmt = content.match(/<!--\s*(.+?)\s*-->/);
    if (cmt) return cmt[1].trim().slice(0, 110);
    return "";
  }
  // .ts/.js: first DESCRIPTIVE comment line, skipping the "api/foo.ts -> ROUTE" header.
  const comments = content.split("\n").slice(0, 60)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("//") || l.startsWith("*"))
    .map((l) => l.replace(/^\/+\s?|^\*+\s?/g, "").trim())
    .filter(Boolean);
  const meaningful = comments.find((c) =>
    !/->/.test(c) && !/^api\//.test(c) && !/^[\w/.-]+\.(ts|js)\b/.test(c) &&
    !/^[-=_*~\s]{6,}$/.test(c) && /[a-zA-Z]/.test(c) && c.length > 12);
  return (meaningful || comments[0] || "").slice(0, 110);
}

export async function getRepoManifest(repo: string, branch: string): Promise<string> {
  const slug = ghRepoSlug(repo);
  const cacheKey = `${slug}@${branch}`;
  const cached = _manifestCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MANIFEST_TTL_MS) return cached.text;

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const header = `BUILD-TARGET REPO — ${slug} @ ${branch} (live manifest of what currently exists)`;
  if (!token) return `${header}\n(manifest unavailable: GITHUB_DISPATCH_TOKEN not set — reasoning from context only)`;

  try {
    // resolve branch -> root tree sha, then one recursive tree call for every path
    const head = await ghJson(`https://api.github.com/repos/${slug}/commits/${encodeURIComponent(branch)}`, token);
    const treeSha = head?.commit?.tree?.sha;
    if (!treeSha) throw new Error("could not resolve branch tree sha");
    const tree = await ghJson(`https://api.github.com/repos/${slug}/git/trees/${treeSha}?recursive=1`, token);

    const keep: string[] = (tree.tree || [])
      .filter((n: any) => n.type === "blob")
      .map((n: any) => n.path as string)
      .filter((p: string) => /\.(html|ts|js|sql)$/.test(p) && !/node_modules\/|\.next\/|dist\/|\.vercel\/|\.d\.ts$/.test(p));

    const pages = keep.filter((p) => p.endsWith(".html"));
    const endpoints = keep.filter((p) => p.startsWith("api/") && p.endsWith(".ts"));
    const lib = keep.filter((p) => p.startsWith("lib/"));
    const db = keep.filter((p) => /^supabase\//.test(p) || p.endsWith(".sql"));
    const other = keep.filter((p) => !pages.includes(p) && !endpoints.includes(p) && !lib.includes(p) && !db.includes(p));

    // annotate only the high-value surface (pages + endpoints), capped, from their own headers
    const HIGH = [...pages, ...endpoints].slice(0, 40);
    const desc = new Map<string, string>();
    await Promise.all(HIGH.map(async (p) => {
      try {
        const f = await ghJson(`https://api.github.com/repos/${slug}/contents/${encodeURIComponent(p)}?ref=${encodeURIComponent(branch)}`, token);
        const content = f.encoding === "base64" ? Buffer.from(f.content, "base64").toString("utf8") : (f.content || "");
        const d = descriptorFrom(p, content);
        if (d) desc.set(p, d);
      } catch { /* leave undescribed */ }
    }));

    const fmt = (p: string) => (desc.has(p) ? `  ${p} — ${desc.get(p)}` : `  ${p}`);
    const section = (title: string, list: string[]) => (list.length ? `\n${title}:\n${list.map(fmt).join("\n")}` : "");

    const text = header +
      section("Pages (browser surface)", pages) +
      section("API endpoints", endpoints) +
      section("Library", lib) +
      section("Database", db) +
      section("Other source", other) +
      (tree.truncated ? "\n(note: GitHub truncated the tree — list is partial)" : "");

    _manifestCache.set(cacheKey, { text, at: Date.now() });
    return text;
  } catch (err: any) {
    return `${header}\n(manifest unavailable: ${String(err?.message || err)} — reasoning from context only)`;
  }
}
