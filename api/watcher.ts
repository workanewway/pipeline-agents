/**
 * api/watcher.ts  ->  GET/POST /api/watcher
 * ---------------------------------------------------------------------------
 * Fires builds for approved ideas. Runs on a cron (and on demand via the
 * board — either "Submit" for the next queued build, or a per-card "Build now"
 * for one specific idea).
 *
 * SCOPE (deliberately narrow, after the 2026-06-29 stage-contract refactor):
 * The watcher's ONLY job is the one genuinely-asynchronous transition —
 *   Stage "Approved"  -> fire the GitHub build Action -> Stage "Building".
 *
 * FIRE SEMANTICS (2026-07-09 selective-fire + sequencing):
 *  - TARGETED: pass ?id=IDEA-0042 (or {id} in the body) to fire exactly that
 *    idea. It must be at Stage "Approved" — anything else is a 400. Targeted
 *    fire ignores Build Order (the human pointing at a card IS the ordering).
 *  - QUEUE MODE (no id — the cron path and the board's Submit): fires ONE
 *    buildable idea per run, chosen by the optional "Build Order" column in
 *    the Queue sheet — lowest number first; blanks build after all numbered
 *    ideas, in sheet (creation) order. One-per-run is deliberate: the build
 *    workflow's concurrency group holds only a single pending run, so firing
 *    several dispatches at once can silently drop the middle ones. Remaining
 *    Approved ideas are reported back as `queued` and fire on later runs.
 *  - Design-only projects don't consume the build slot: an approved spec is
 *    the deliverable, so ALL of them are handed off every run regardless.
 *
 * Everything else stays where it belongs:
 *  - Human verdicts (Approve / Decline / Revise / Hold / Revise Build) are
 *    applied SYNCHRONOUSLY via /api/decide. The watcher no longer reads the
 *    Review column or routes decisions.
 *  - Building -> Testing is written by the build workflow itself (pipeline-build.yml)
 *    when the preview is ready. The watcher does not touch it.
 *  - Testing -> Ready to Promote is a HUMAN hold: the person verifies the preview
 *    and advances it from the board. The watcher must NOT auto-advance it.
 * ---------------------------------------------------------------------------
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  projectByName, cronAuthorized, getSheets, readQueue, updateCells,
  QueueRow, ColumnName,
} from "../lib/pipeline-common.js";

export const maxDuration = 60;
const sheets = getSheets();
const stamp = () => new Date().toISOString();

function appendLog(existing: string, line: string): string {
  const entry = `[${stamp()}] ${line}`;
  return existing ? `${existing}\n${entry}` : entry;
}
async function write(rowNum: number, updates: Partial<Record<ColumnName, string>>) {
  await updateCells(sheets, rowNum, { ...updates, "Updated At": stamp() });
}

// Read a column that may not exist in every deployment of the sheet ("Build Order"
// is optional). Missing column or any read error = "", never a throw.
function safeGet(row: QueueRow, name: string): string {
  try { return ((row as any).get(name) || "").toString(); } catch { return ""; }
}

// Build Order sort key: lowest number first; blank / non-numeric = Infinity
// (builds after all numbered ideas, in sheet order — Array.sort is stable).
function orderOf(row: QueueRow): number {
  const n = parseInt(safeGet(row, "Build Order"), 10);
  return isNaN(n) ? Infinity : n;
}

// Fire a repository_dispatch the build workflow listens for. Needs a GitHub token
// with `repo` scope in env. If unset, the build can't fire — surfaced as Blocked.
async function fireBuild(row: QueueRow): Promise<{ ok: boolean; note: string }> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.BUILD_REPO || "workanewway/vetting-platform-api";
  if (!token) return { ok: false, note: "GITHUB_DISPATCH_TOKEN not set — build not fired" };

  const payload = {
    event_type: "pipeline-build",
    client_payload: {
      ideaId: row.get("Idea ID"),
      title: row.get("Title"),
      product: row.get("Product"),
      rowNum: row.rowNum,
      buildSequence: row.get("Build Sequence"),
      designBrief: row.get("Design Brief"),
      repoTarget: row.get("Repo + Target"),
      branch: "staging",
    },
  };

  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "pipeline-watcher",
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 204) return { ok: true, note: `build fired on ${repo}@staging` };
  return { ok: false, note: `dispatch failed ${res.status}: ${(await res.text()).slice(0, 200)}` };
}

// Design-only handoff: the approved spec IS the deliverable — no autonomous build.
async function handOffDesignOnly(row: QueueRow): Promise<string> {
  const id = row.get("Idea ID");
  const log = row.get("Review Log");
  await write(row.rowNum, {
    Stage: "Ready to Promote",
    "Build Status": "design-only: handed off (no autonomous build)",
    "Review Log": appendLog(log, "Approved — design-only project; spec ready for human build against client infra"),
  });
  return `${id}: approved (design-only handoff)`;
}

// Approved -> CLAIM (Stage=Building) -> fire build (or Blocked on failure).
async function fireApproved(row: QueueRow): Promise<string> {
  const id = row.get("Idea ID");
  const log = row.get("Review Log");

  // CLAIM the row BEFORE dispatching. Two watcher invocations can overlap (the daily
  // cron + a Submit click, or a double-clicked Submit); each reads the sheet before the
  // other writes. Firing first meant BOTH could dispatch the same idea — the workflow's
  // concurrency group serializes them, so the second build runs against a staging that
  // already contains the first's work, makes no edits, and its writeback overwrites the
  // first's Testing with Blocked ("no edits"). Claiming first (Stage=Building, then
  // dispatch) shrinks the race window from read→GitHub-call→write (seconds) to
  // read→write (sub-second). Not a true lock — Sheets has no compare-and-swap — but it
  // removes the realistic collision.
  // Named edge: a crash BETWEEN the claim and the dispatch leaves the row at Building
  // with status "claimed — firing build…" and no build coming. That's a visible stuck
  // state on the board (the remedy is setting the row back to Approved), which is the
  // right trade against a silent Testing→Blocked overwrite.
  const claimLog = appendLog(log, "Claimed for build (pre-dispatch)");
  await write(row.rowNum, {
    Stage: "Building",
    "Build Status": "claimed — firing build…",
    "Review Log": claimLog,
  });

  const fired = await fireBuild(row);
  if (fired.ok) {
    await write(row.rowNum, {
      "Build Status": "build fired (staging)",
      "Review Log": appendLog(claimLog, `Build fired — ${fired.note}`),
    });
    return `${id}: build fired -> Building`;
  }
  // Dispatch failed AFTER the claim: revert loudly to Blocked — never leave a phantom
  // "Building" row that no build will ever write back to.
  await write(row.rowNum, {
    Stage: "Blocked",
    "Build Status": "build NOT fired",
    "Blocked Reason": fired.note,
    "Review Log": appendLog(claimLog, `Build fire FAILED — ${fired.note}`),
  });
  return `${id}: build NOT fired -> Blocked (${fired.note})`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!cronAuthorized(req.headers.authorization)) return res.status(401).json({ error: "unauthorized" });

  try {
    // Optional targeted fire: ?id=IDEA-0042 or {id} in the POST body.
    const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
    const idParam = String((req.query.id as string) || body?.id || "").trim();

    const { rows } = await readQueue(sheets);
    const actions: string[] = [];

    // ── TARGETED MODE: fire exactly one named idea ─────────────────────────
    if (idParam) {
      const row = rows.find((r) => r.get("Idea ID").trim() === idParam);
      if (!row) return res.status(404).json({ ok: false, error: `idea ${idParam} not found` });
      const stage = row.get("Stage").trim();
      if (stage !== "Approved") {
        return res.status(400).json({ ok: false, error: `Build now is only valid from Approved (idea is at "${stage}")` });
      }
      const project = projectByName(row.get("Product"));
      actions.push(project && (project as any).deploy === "design-only"
        ? await handOffDesignOnly(row)
        : await fireApproved(row));
      return res.status(200).json({ ok: true, acted: actions.length, actions, queued: [] });
    }

    // ── QUEUE MODE (cron / Submit): all design-only handoffs + ONE build ──
    const approved = rows.filter((r) => r.get("Stage").trim() === "Approved");

    const buildable: QueueRow[] = [];
    for (const row of approved) {
      const project = projectByName(row.get("Product"));
      if (project && (project as any).deploy === "design-only") {
        actions.push(await handOffDesignOnly(row));   // never consumes the build slot
      } else {
        buildable.push(row);
      }
    }

    // Lowest Build Order first; blanks after numbered, in sheet order (stable sort).
    buildable.sort((a, b) => orderOf(a) - orderOf(b));

    const queued: string[] = [];
    if (buildable.length > 0) {
      actions.push(await fireApproved(buildable[0]));
      for (const row of buildable.slice(1)) {
        const ord = safeGet(row, "Build Order");
        queued.push(row.get("Idea ID") + (ord ? ` (order ${ord})` : ""));
      }
      if (queued.length) {
        actions.push(`queued for later runs (one build per run): ${queued.join(", ")}`);
      }
    }

    return res.status(200).json({ ok: true, acted: actions.length, actions, queued });
  } catch (err: any) {
    console.error("[watcher] failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
