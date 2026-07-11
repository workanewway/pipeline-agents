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
    // FALLBACK STUB ONLY. The canonical context for this project is CONTEXT.md at the root of
    // the build-target repo, fetched live by getProjectContext() below. This stub is
    // DELIBERATELY thin: if the fetch fails, agents should degrade VISIBLY (hold invariants,
    // defer structure) rather than silently reasoning from a rich-but-stale copy — stale-copy
    // drift is the exact failure this design exists to kill. Do not grow this stub.
    context: `FALLBACK STUB — canonical project context is CONTEXT.md at the root of
github.com/workanewway/vetting-platform-api, normally fetched live. If you are reading THIS
text in a prompt, that fetch FAILED and you are running with degraded context. Hold these
invariants and defer anything structural:
- Standalone multi-tenant SaaS for freight brokers broadly; NOT built for any single broker.
- NO PRODUCT NAME exists. Never invent or render a product/brand name; never surface a
  tenant name in customer-facing copy or UI.
- Stack: serverless TypeScript on Vercel (one file per api/ route, canonical apply.ts
  pattern, native fetch to the Anthropic REST API — never the SDK inside an endpoint);
  Supabase Postgres with RLS (carriers GLOBAL; vettings/documents/audit TENANT-scoped);
  Cloudflare R2 for documents; FMCSA QCMobile; static vanilla-JS pages on cPanel (no
  frameworks).
- Auth is TENANT-level only (access code -> API key). NO per-user auth exists; designs must
  not assume it.
- Internal test tenants: "bivium" and "acme" (not real customers).
Do NOT make surface-map or file-level design decisions from this stub. Name the missing
canonical context as an open question / dependency instead of guessing.`,
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

// Column contract. COLUMNS now serves TWO narrower jobs: it's the source of the ColumnName
// TYPE (so callers get autocomplete + typo-checking), and it's the FALLBACK order if the live
// header can't be read. It is NO LONGER the authority on where a column physically sits — that
// comes from the live header (see liveColumnMap). So a column added to the sheet by hand no
// longer has to be mirrored here for writes to land correctly; add it here only to get the type.
export const COLUMNS = [
  "Idea ID", "Title", "Stage", "Source", "Product", "Priority Score",
  "Priority Rationale", "Reasoning", "AI-Native Approach", "Evidence / Sources",
  "Open Questions", "Design Brief", "Design Output", "Build Sequence", "Repo + Target",
  "Review", "Review Feedback", "Revisions", "Review Log", "Decided At",
  "Build Status", "Test Results", "Preview URL", "Prod URL", "PR / Commit",
  "Blocked Reason", "Created At", "Updated At",
  "Migration Files", "Pending Migration", "Build Report", "Lint", "Locked Scope",
  "Build Order",
] as const;

export type ColumnName = (typeof COLUMNS)[number];
// Static/positional index — kept for the fallback path only. Do NOT use it to place writes;
// use the live header via liveColumnMap so hand-added columns work. -1 if unknown.
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

// ---------------------------------------------------------------------------
// Live column map — the WRITE side resolves each column's position from the ACTUAL header row
// of the Queue tab, not from a hardcoded array. This is the fix for a recurring class of bug:
// a column added to the sheet by hand (Build Report, Lint, Migration Files…) used to require a
// matching edit to COLUMNS, or writes would error ("Queue!9") or — worse — land in the WRONG
// column silently. Now they just work, in whatever order the sheet has them.
// Cached briefly (the header changes rarely). If the header read fails, we fall back to the
// static COLUMNS order so a transient error degrades to the old behavior rather than dropping
// every write.
// ---------------------------------------------------------------------------
let _colCache: { at: number; map: Map<string, number> } | null = null;
const COL_TTL_MS = 60_000;

async function liveColumnMap(sheets: Sheets): Promise<Map<string, number>> {
  const now = Date.now();
  if (_colCache && now - _colCache.at < COL_TTL_MS) return _colCache.map;
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!A1:AZ1` });
    const headers = (res.data.values?.[0] ?? []).map((h: string) => String(h).trim());
    const map = new Map<string, number>();
    headers.forEach((h, i) => { if (h) map.set(h, i); });
    if (map.size === 0) throw new Error("empty header row");
    _colCache = { at: now, map };
    return map;
  } catch (e: any) {
    console.error(`[liveColumnMap] live header read failed (${String(e?.message || e)}); falling back to static COLUMNS`);
    const map = new Map<string, number>();
    COLUMNS.forEach((h, i) => map.set(h, i));
    return map; // not cached — retry the live read next call
  }
}

/** Drop the cached header (call after adding a column to the sheet mid-session). */
export function invalidateColumnCache() { _colCache = null; }

// A new-row draft keyed by column NAME (not position). Serialized to sheet order at append time
// via the live header, so row-building no longer depends on column position either.
export type RowDraft = Partial<Record<ColumnName, string>>;
export const newRow = (): RowDraft => ({});
export function setCell(draft: RowDraft, name: ColumnName, value: string): RowDraft {
  draft[name] = value;
  return draft;
}

/** Append new rows, placing each field by the LIVE header position. Full-width, order-proof. */
export async function appendRows(sheets: Sheets, drafts: RowDraft[]) {
  if (!drafts.length) return;
  const cmap = await liveColumnMap(sheets);
  const width = Math.max(...Array.from(cmap.values())) + 1;
  const lastCol = a1(width - 1);
  const values = drafts.map((d) => {
    const arr = new Array(width).fill("");
    for (const [name, val] of Object.entries(d)) {
      const i = cmap.get(name);
      if (i === undefined) { console.error(`[appendRows] "${name}" not in the live header — dropped from the new row.`); continue; }
      arr[i] = val ?? "";
    }
    return arr;
  });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A:${lastCol}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
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
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!A1:AF` });
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
  const cmap = await liveColumnMap(sheets);
  const data = Object.entries(updates)
    .filter(([name, value]) => {
      if (value === undefined) return false;
      const has = cmap.has(name);
      // Unknown column: skip loudly instead of building an unparseable range that would fail the
      // ENTIRE batch. Means the header is missing from the sheet or spelled differently.
      if (!has) console.error(`[updateCells] "${name}" not in the live Queue header — skipped. Add the header to the sheet.`);
      return has;
    })
    .map(([name, value]) => ({
      range: `${TAB}!${a1(cmap.get(name)!)}${rowNum}`,
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
    console.error(`[getRepoManifest] FAILED ${slug}@${branch} — ${String(err?.message || err)}`);
    return `${header}\n(manifest unavailable: ${String(err?.message || err)} — reasoning from context only)`;
  }
}

// ---------------------------------------------------------------------------
// getFile — the CONTENTS layer. The manifest tells the pre-build stages which files EXIST;
// this returns what's INSIDE one. Deliberately NOT autonomous: it's exposed as a chat TOOL so
// a file is only read because a conversation turn asked for it (the human points; the model
// doesn't graze the repo). Scope of access = scope of the question, by construction.
// Guards: source files only, no path traversal, size-capped with a truncation marker, fails
// soft (returns a note, never throws). Cached briefly like the manifest.
// FAILURES ARE LOGGED (console.error) — a silent soft-fail made "files aren't reachable"
// undiagnosable from the Vercel logs (2026-07-09). Bare page names retry under public/.
// ---------------------------------------------------------------------------
const _fileCache = new Map<string, { text: string; at: number }>();
const FILE_TTL_MS = 5 * 60 * 1000;
const FILE_MAX_CHARS = 12000; // keep a single chat turn bounded
const FILE_READABLE = /\.(html|ts|tsx|js|jsx|sql|json|md|css|ya?ml)$/;

export async function getFile(repo: string, branch: string, path: string): Promise<string> {
  const slug = ghRepoSlug(repo);
  const clean = String(path || "").replace(/^\/+/, "").trim();

  if (!clean || /\.\./.test(clean)) return `(refused: invalid path "${path}")`;
  if (!FILE_READABLE.test(clean)) return `(refused: "${clean}" is not a readable source file — source/config only)`;

  const cacheKey = `${slug}@${branch}:${clean}`;
  const cached = _fileCache.get(cacheKey);
  if (cached && Date.now() - cached.at < FILE_TTL_MS) return cached.text;

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    console.error(`[getFile] GITHUB_DISPATCH_TOKEN not set — cannot read ${slug}#${branch}:${clean}`);
    return `(file unavailable: GITHUB_DISPATCH_TOKEN not set)`;
  }

  const fetchOne = async (p: string): Promise<string> => {
    const encPath = p.split("/").map(encodeURIComponent).join("/");
    const f = await ghJson(`https://api.github.com/repos/${slug}/contents/${encPath}?ref=${encodeURIComponent(branch)}`, token);
    if (Array.isArray(f)) throw new Error(`"${p}" is a directory, not a file`);
    return f.encoding === "base64" ? Buffer.from(f.content, "base64").toString("utf8") : (f.content || "");
  };

  try {
    let servedPath = clean;
    let content: string;
    try {
      content = await fetchOne(clean);
    } catch (first: any) {
      // Forgiving retry: pages live under public/ in the build-target repo, and models
      // (and humans) habitually ask for the bare filename. On a 404 for a page-like path
      // that doesn't already start with public/, try public/<path> before giving up.
      const is404 = /GitHub 404/.test(String(first?.message || ""));
      if (is404 && !clean.startsWith("public/") && /\.(html|css|js)$/.test(clean)) {
        servedPath = `public/${clean}`;
        console.error(`[getFile] ${slug}#${branch}:${clean} not found — retrying as ${servedPath}`);
        content = await fetchOne(servedPath);
      } else {
        throw first;
      }
    }
    const total = content.length;
    const body = total > FILE_MAX_CHARS
      ? content.slice(0, FILE_MAX_CHARS) + `\n\n…(truncated — first ${FILE_MAX_CHARS} of ${total} chars)`
      : content;
    const text = `FILE ${servedPath} @ ${slug}#${branch} (${total} chars)\n\n${body}`;
    _fileCache.set(cacheKey, { text, at: Date.now() });
    return text;
  } catch (err: any) {
    // LOG the real failure — previously this failed soft with no log line, which made
    // "files aren't reachable" undiagnosable from the Vercel logs.
    console.error(`[getFile] FAILED ${slug}#${branch}:${clean} — ${String(err?.message || err)}`);
    return `(file unavailable: ${clean} — ${String(err?.message || err)})`;
  }
}

// ---------------------------------------------------------------------------
// searchFile — grep for the chats. getFile truncates at 12k chars, which makes
// large pages (workspace.html is ~220k) unreadable; but they are perfectly
// SEARCHABLE: fetch the full content server-side, return only matching lines
// with line numbers. This is the cure for the recurring silent-death pattern
// where a chat chained truncated reads hunting for a code detail and blew the
// function's time budget. Same guards as getFile; fail-soft; failures logged.
// ---------------------------------------------------------------------------
export async function searchFile(repo: string, branch: string, path: string, pattern: string): Promise<string> {
  const slug = ghRepoSlug(repo);
  const clean = String(path || "").replace(/^\/+/, "").trim();
  if (!clean || /\.\./.test(clean)) return `(refused: invalid path "${path}")`;
  if (!FILE_READABLE.test(clean)) return `(refused: "${clean}" is not a searchable source file — source/config only)`;
  const pat = String(pattern || "").trim();
  if (!pat) return `(refused: empty search pattern)`;
  if (pat.length > 200) return `(refused: pattern too long)`;

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    console.error(`[searchFile] GITHUB_DISPATCH_TOKEN not set — cannot search ${slug}#${branch}:${clean}`);
    return `(search unavailable: GITHUB_DISPATCH_TOKEN not set)`;
  }

  try {
    const encPath = clean.split("/").map(encodeURIComponent).join("/");
    const f = await ghJson(`https://api.github.com/repos/${slug}/contents/${encPath}?ref=${encodeURIComponent(branch)}`, token);
    if (Array.isArray(f)) return `(refused: "${clean}" is a directory, not a file)`;
    const content = f.encoding === "base64" ? Buffer.from(f.content, "base64").toString("utf8") : (f.content || "");

    // Try the pattern as a regex (case-insensitive); fall back to substring.
    let re: RegExp | null = null;
    try { re = new RegExp(pat, "i"); } catch { re = null; }
    const needle = pat.toLowerCase();

    const lines = content.split("\n");
    const MAX_MATCHES = 40;
    const out: string[] = [];
    for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
      const l = lines[i];
      const hit = re ? re.test(l) : l.toLowerCase().includes(needle);
      if (hit) out.push(`${i + 1}: ${l.trim().slice(0, 200)}`);
    }
    if (!out.length) return `SEARCH ${clean} @ ${slug}#${branch} for /${pat}/ — no matches (${lines.length} lines scanned)`;
    return `SEARCH ${clean} @ ${slug}#${branch} for /${pat}/ — ${out.length} match(es)${out.length === MAX_MATCHES ? " (capped at 40)" : ""} of ${lines.length} lines\n${out.join("\n")}`;
  } catch (err: any) {
    console.error(`[searchFile] FAILED ${slug}#${branch}:${clean} /${pat}/ — ${String(err?.message || err)}`);
    return `(search unavailable: ${clean} — ${String(err?.message || err)})`;
  }
}

// ---------------------------------------------------------------------------
// getProjectContext — canonical-context resolution. For repo-backed projects, the canonical
// context lives IN the build-target repo (CONTEXT.md at root) so it travels with the code,
// follows the same branch semantics as the manifest (research reads main, design reads
// staging), and can be updated by the very builds that change the platform's shape. The
// static Project.context string is a thin FALLBACK stub — deliberately minimal, so a failed
// fetch degrades VISIBLY instead of silently serving a rich-but-stale copy (the drift this
// design exists to kill). Non-repo projects (client engagements) keep their static context
// as canonical.
// Reuses getFile: same token, same 5-min cache, same guards, fail-soft by construction.
// NOTE: getFile truncates at 12,000 chars — keep CONTEXT.md under ~11,000.
// ---------------------------------------------------------------------------
export const PROJECT_CONTEXT_FILE = "CONTEXT.md";

export async function getProjectContext(p: Project, branch = "main"): Promise<string> {
  if (!isGithubRepo(p.repo)) return p.context; // no repo -> static context IS canonical
  const file = await getFile(p.repo, branch, PROJECT_CONTEXT_FILE);
  // Success: getFile returns "FILE <path> @ <slug>#<branch> …" — keep the provenance header,
  // it tells the model (and anyone reading the prompt) exactly which version it's seeing.
  if (file.startsWith("FILE ")) return file;
  // Failure: getFile returned a "(…)" note. LOG it loudly — a degraded context silently
  // weakens every scope and design conversation — then fall back to the stub and surface
  // the failure INSIDE the context so the degradation is legible, not silent.
  console.error(`[getProjectContext] CONTEXT.md fetch FAILED for ${p.name} (${p.repo}#${branch}): ${file}`);
  return `${p.context}\n\n(canonical ${PROJECT_CONTEXT_FILE} unavailable on ${p.repo}#${branch}: ${file})`;
}

// ---------------------------------------------------------------------------
// Locked scope — the machine-readable in/out boundary the scope-chat rewrite emits
// (written to the "Locked Scope" column by idea.ts, with a server-side lockedAt).
// An absent/empty cell means "scope was never explicitly locked": consumers (the
// design-brief constraint block, the scope-drift lint) SKIP those rows rather than
// inventing a baseline.
// ---------------------------------------------------------------------------
export interface LockedScope { in: string[]; out: string[]; lockedAt?: string }

/** Parse the "Locked Scope" cell (JSON {in,out,lockedAt}). Null when absent, unparseable, or empty. */
export function parseLockedScope(cell: string): LockedScope | null {
  try {
    const v = JSON.parse(cell || "");
    if (!v || typeof v !== "object") return null;
    const list = (x: any): string[] =>
      Array.isArray(x) ? x.filter((s: any) => typeof s === "string" && s.trim()).map((s: string) => s.trim()) : [];
    const scope: LockedScope = { in: list(v.in), out: list(v.out) };
    if (typeof v.lockedAt === "string") scope.lockedAt = v.lockedAt;
    return scope.in.length || scope.out.length ? scope : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Deterministic lint — the supervisor's SAFE half. Flags (never blocks, never edits)
// the mechanical consistency mistakes that recurred in practice: name leakage, stale
// rewrite-narration, and dead stage vocabulary. RULES ONLY — no LLM judgment, so there's
// no supervisor-agent that can itself drift. Writes a short string to the "Lint" column.
// Scope-drift detection (needs a machine-readable locked-scope field) and title/description
// coherence are deliberately NOT here — those are phase 2.
//
// EDIT THE TWO NAME LISTS to match reality — they are the leak check's data.
// ---------------------------------------------------------------------------

// HARD: brand/product names that must NEVER appear anywhere — invented product names, or a
// brand that was explicitly removed (its reappearance is a regression). Checked everywhere.
const LINT_BRAND_NAMES = ["FreightVet", "B&I Ventures", "B and I Ventures"];

// SOFT: tenant identities that shouldn't surface in customer-facing FRAMING (title /
// description / AI-native) but ARE legitimate in build-sequence test steps
// ("test with the bivium tenant"). So these are checked against framing ONLY.
const LINT_TENANT_NAMES = ["Bivium Freight", "Bivium", "acme"];

// Change-narration tells — a rewritten description should state what the idea IS, not narrate
// how it changed. (The rewrite prompt already avoids these; this catches any that slip through
// via any path.)
const LINT_NARRATION = [
  /scope narrowed/i, /\bthis is not a\b/i, /we decided against/i,
  /narrowed (significantly )?from the original/i, /\boriginally,? (this|the idea|it)\b/i,
  /as (we )?discussed/i, /per (our|the) (conversation|chat)/i,
];

// Stage names retired by the stage-machine refactor — a leftover means stale text.
const LINT_DEAD_STAGES = [/\bIn Review\b/];

const lintWordRe = (name: string) =>
  new RegExp("\\b" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");

// Filenames inside a locked-scope OUT bullet — the one anchor a RULE can check
// reliably. General keyword matching against prose is deliberately NOT done here:
// it floods the Lint column with noise and erodes trust in it. Semantic drift is
// caught upstream (the lock is injected into the design prompt as binding) and at
// the verdict (the lock renders beside the brief for the human). Phase 2 stays
// rules-only by checking only what rules can actually check.
const LINT_FILE_RE = /\b[\w.\/-]*[\w-]+\.(html|ts|tsx|js|jsx|sql|css|ya?ml|php)\b/gi;

/** Deterministic consistency lint. Returns a short " · "-joined findings string, or "" if clean. */
export function lintIdea(f: {
  title?: string; description?: string; aiNative?: string; brief?: string; sequence?: string;
  lockedScope?: LockedScope | null;
}): string {
  const framing = [f.title, f.description, f.aiNative].filter(Boolean).join("\n");
  const all = [f.title, f.description, f.aiNative, f.brief, f.sequence].filter(Boolean).join("\n");
  const out: string[] = [];

  for (const n of LINT_BRAND_NAMES) if (lintWordRe(n).test(all)) out.push(`name-leak: brand "${n}" in spec`);
  for (const n of LINT_TENANT_NAMES) if (lintWordRe(n).test(framing)) out.push(`name-leak: tenant "${n}" in idea framing`);
  for (const re of LINT_NARRATION) { const m = all.match(re); if (m) out.push(`narration: "${m[0]}" — state what it IS, not the change`); }
  for (const re of LINT_DEAD_STAGES) { const m = all.match(re); if (m) out.push(`stale-stage: "${m[0]}" (renamed)`); }

  // scope-drift (narrow, deterministic): an OUT bullet that names a source file is the
  // highest-signal lock ("no changes to vetting.html"). Flag when that file shows up in
  // the DESIGN OUTPUT (brief/sequence — not the idea framing, which legitimately states
  // the boundary). Surfaces with a "?" — a brief saying "leave vetting.html untouched"
  // trips this too, and that's fine: the flag asks for a human glance, it never gates.
  const scope = f.lockedScope;
  if (scope && scope.out.length) {
    const design = [f.brief, f.sequence].filter(Boolean).join("\n").toLowerCase();
    if (design) {
      const flagged = new Set<string>();
      for (const bullet of scope.out) {
        for (const file of bullet.match(LINT_FILE_RE) || []) {
          const fl = file.toLowerCase();
          if (!flagged.has(fl) && design.includes(fl)) {
            flagged.add(fl);
            out.push(`scope-drift?: out-of-scope "${file}" appears in the design output — verify against the locked scope`);
          }
        }
      }
    }
  }

  return out.join(" · ");
}
