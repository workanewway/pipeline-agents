# CONTEXT.md — Canonical Platform Context

> This file is the SINGLE SOURCE OF TRUTH for what this platform IS. The Foundry's
> research and design agents fetch it live (research reads `main`, design reads
> `staging`); Claude chat sessions and the vetting-platform skill defer to it for
> platform shape. If a build or manual change alters the platform's shape —
> surfaces, endpoints, data model, auth, conventions — **updating this file is
> part of "done"** and belongs in the same change.
>
> Rules for this file: keep it under ~11,000 characters (the pipeline's file
> reader truncates at 12,000); state what the platform IS, never narrate how it
> changed; never render a product/brand name (none exists) or surface a tenant
> name as customer-facing framing.

## What this platform is

A standalone multi-tenant SaaS for freight brokers. It produces court-ready,
tamper-evident records of "reasonable care" in carrier selection — a compliance
tool after *Montgomery v. Caribe Transport II* (May 2026) let safety-based
negligent-selection claims through the FAAAA preemption safety exception. Sold
broadly to SMB brokers; **not built for any single broker.**

## NO PRODUCT NAME

This product has NO finalized public brand name. NEVER invent, assume, or render
a product/brand name (no "FreightVet", no codename) in any label, placeholder,
header, copy, or UI string. Refer to it generically ("the platform"). Likewise
NEVER surface a tenant/client's name in product UI. Apply only neutral,
professional styling — never a name.

## Architecture — design WITHIN this exact stack; do not substitute

- **Backend:** serverless TypeScript functions on Vercel, one file per route
  under `api/` in this repo (e.g. `api/vettings/[id]/assess.ts`). NOT Next.js,
  NOT an app/ router, NOT React Server Components. New endpoints follow the
  canonical `apply.ts` pattern: handler signature `(req, _res, ctx)`; wrap with
  `withHandler(handler, { methods: [...] })`; use `getSupabase()` (never a bare
  client); `throw errors.xxx()` (never sendError); return plain objects (never
  `res.json()`); EVERY relative import carries an explicit `.js` extension; long
  jobs set `export const maxDuration`. Do NOT import `@anthropic-ai/sdk` inside
  an endpoint — call the Anthropic REST API with native fetch.
- **Data:** Supabase (Postgres) with row-level security; carriers are GLOBAL,
  but vettings / documents / audit are TENANT-scoped (scoped by
  `current_tenant_id()` — don't break tenant isolation). Cloudflare R2 for
  documents; FMCSA QCMobile as the authoritative carrier source. The vettings
  table's `conversation` column is POLYMORPHIC (classic chat turns AND
  `type:'file'` event turns — any iterator must handle both).
- **Auth:** TENANT-level only. A tenant access code (hashed in
  `access_code_hash`) yields an API key the browser stores and sends on each
  call. There is NO per-user auth — no auth.users, no user_id ownership, no
  cookie sessions, no createServerClient, no login.html. Per-user auth (JWT
  alongside the API key, login.html replacing connect.html) is a DEFERRED
  roadmap item: a design MUST NOT assume it exists. Scope ownership by tenant,
  not user.
- **Frontend:** static HTML pages on GoDaddy cPanel at workanewway.com, plain
  vanilla JS calling the API with the tenant key (no React, no Next.js, no
  hooks, no component framework, no Vercel AI SDK). The pages are mapped below.

## Surface map — target the right file; do NOT infer the file from wording

The similar names (workspace.html / vetting.html / vettings.html) are a trap. If
an idea names a surface that is NOT in this map, ask "which file?" as an open
question rather than picking one.

- **workspace.html** — the carrier-vetting WORKSPACE: a SINGLE-vetting view (one
  carrier / one vetting at a time; ONE conversation thread per vetting — NOT a
  multi-pane or tabbed multi-carrier view). It is the current surface where a
  vetting is reviewed. THIS is where the "✦ Ask AI" conversation dock lives
  (backed by the vettings.conversation column), alongside the AI recommendation
  band, severity-tiered findings, and the data-sources rail. ANY change to the
  assistant / chat / conversation dock targets workspace.html.
- **connect.html** — access-code gate: mints/stores the tenant API key, then
  redirects.
- **vetting.html** — the linear vetting walkthrough / flow (backend-wired).
- **vettings.html** — records retrieval: search, detail, re-download the
  compliance PDF.
- **DO NOT TOUCH** vetting_walkthrough.html or general_proxy.php — that is the
  OLD credential-free demo.

## Key backend files — names are a trap; verify by reading

- `api/vettings/[id]/lock.ts` — approval persistence (the real approval
  handler).
- `api/vettings/[id]/assess.ts` — the AI recommendation (reasoning prompt).
- `api/vettings/[id]/apply.ts` — per-check evidence, and the canonical endpoint
  pattern for the whole API.

## Invariants & standing decisions

- **The JSON snapshot is the cryptographic source of truth; the PDF is
  presentation.** At lock time the full vetting is serialized to JSON, SHA-256
  hashed, and stored in R2; the PDF renders FROM that snapshot and displays the
  hash. Never treat the PDF as authoritative.
- **Dual-mode must survive.** vetting.html works with OR without the backend
  (integration JS wraps the in-memory functions; backend errors degrade to
  toasts). Never remove in-memory mode.
- **API keys are hashed-only.** `/api/access` mints a fresh key per connect and
  stores only its SHA-256 hash; plaintext is returned once and unrecoverable
  afterward. Accumulating api_keys rows is intentional.
- **Cross-tenant signal without cross-tenant leakage.** A carrier lookup by one
  tenant caches globally-shared carrier data all tenants benefit from; the
  network_signal view aggregates cross-tenant vetting counts WITHOUT revealing
  which tenants.
- **Document analysis degrades gracefully.** If AI analysis fails, the document
  is still stored in R2 and the endpoint returns partial success
  (analysis_error) — an upload is never lost.
- **Methodology lives in two places intentionally:** `lib/recommendation.ts`
  (backend, authoritative) and the walkthrough's own JS (UI display) — same
  rules, kept in agreement. Auto-declines: inactive authority; fraud/theft/
  freight-loss flags; no insurance. Review flags: conditional rating, insurance
  lapses/gaps, carrier changes, address/contact mismatches, limited inspection
  history.

## Build on what exists — do not reinvent it

The "✦ Ask AI" dock (workspace.html, backed by vettings.conversation) already
works. Ideas about that assistant MODIFY the existing dock and its endpoints in
place — never spec a new conversations/messages data model or a parallel chat
system.

## Tenants

Internal test tenants are **"bivium"** and **"acme"** (access codes
"bivium"/"acme"). They exist to exercise multi-tenancy. They are not real
customers, and their names never appear in customer-facing copy, titles, or UI.

## Deferred roadmap (design against these as EXPLICIT dependencies, never as if built)

- Per-user auth (JWT alongside the tenant API key; login.html replacing
  connect.html).
- Customer-facing share page for a completed vetting.
- Vendor API integrations: Highway, MyCarrierPortal, Carrier411, RMIS.
