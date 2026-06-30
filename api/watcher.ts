/**
 * api/watcher.ts  ->  GET/POST /api/watcher
 * ---------------------------------------------------------------------------
 * Fires the build for every approved idea. Runs on a cron (and on demand via the
 * board's "Submit" button — an optional accelerator that fires now instead of
 * waiting for the cron).
 *
 * SCOPE (deliberately narrow, after the 2026-06-29 stage-contract refactor):
 * The watcher's ONLY job is the one genuinely-asynchronous transition —
 *   Stage "Approved"  -> fire the GitHub build Action -> Stage "Building".
 *
 * Everything else moved to where it belongs:
 *  - Human verdicts (Approve / Decline / Revise / Hold) are now applied
 *    SYNCHRONOUSLY in the browser via /api/decide. The watcher no longer reads
 *    the Review column or routes decisions.
 *  - Building -> Testing is written by the build workflow itself (pipeline-build.yml)
 *    when the preview is ready. The watcher does not touch it.
 *  - Testing -> Ready to Promote is a HUMAN hold: the person verifies the preview
 *    and advances it from the board. The watcher must NOT auto-advance it.
 *
 * Design-only projects don't autonomously build — an approved spec is the deliverable,
 * so they go straight to "Ready to Promote" (a human builds against client infra).
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

// Approved -> fire build -> Building (or design-only handoff, or Blocked on failure).
async function fireApproved(row: QueueRow): Promise<string> {
  const id = row.get("Idea ID");
  const log = row.get("Review Log");
  const project = projectByName(row.get("Product"));

  // design-only projects: the approved spec IS the deliverable — no autonomous build.
  if (project && project.deploy === "design-only") {
    await write(row.rowNum, {
      Stage: "Ready to Promote",
      "Build Status": "design-only: handed off (no autonomous build)",
      "Review Log": appendLog(log, "Approved — design-only project; spec ready for human build against client infra"),
    });
    return `${id}: approved (design-only handoff)`;
  }

  const fired = await fireBuild(row);
  if (fired.ok) {
    await write(row.rowNum, {
      Stage: "Building",
      "Build Status": "build fired (staging)",
      "Review Log": appendLog(log, `Build fired — ${fired.note}`),
    });
    return `${id}: build fired -> Building`;
  }
  // Fire failed: surface it as Blocked rather than silently retrying forever.
  await write(row.rowNum, {
    Stage: "Blocked",
    "Build Status": "build NOT fired",
    "Blocked Reason": fired.note,
    "Review Log": appendLog(log, `Build fire FAILED — ${fired.note}`),
  });
  return `${id}: build NOT fired -> Blocked (${fired.note})`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!cronAuthorized(req.headers.authorization)) return res.status(401).json({ error: "unauthorized" });

  try {
    const { rows } = await readQueue(sheets);
    const actions: string[] = [];

    for (const row of rows) {
      if (row.get("Stage").trim() === "Approved") {
        actions.push(await fireApproved(row));
      }
    }

    return res.status(200).json({ ok: true, acted: actions.length, actions });
  } catch (err: any) {
    console.error("[watcher] failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
