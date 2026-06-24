/**
 * api/watcher.ts  ->  GET/POST /api/watcher
 * ---------------------------------------------------------------------------
 * Turns your Review decisions into action. Runs on a cron (and on demand).
 *
 * For every row at Stage = "In Review" whose Review (col P) is not "Pending",
 * it acts on the decision, then resets Review to "Pending" so it won't re-fire:
 *
 *   Approved        -> Stage "Building"; fire the build (one-tap projects) or
 *                      mark design-only handoff. Logs the decision.
 *   Revise Design   -> Stage "Designing";  Revisions +1; feedback travels (col Q).
 *   Revise Research -> Stage "Enriching";  Revisions +1; feedback travels.
 *   Hold            -> stays In Review; logged.
 *   Declined        -> Stage "Declined" (terminal); reason logged.
 *
 * It ALSO advances rows the build has finished:
 *   Build Status "preview-ready" + Preview URL present  -> Stage "Ready to Promote".
 *
 * Loop guard: when Revisions reaches MAX_REVISIONS on a Revise, the row goes to
 * "Blocked" instead of looping again.
 *
 * The watcher does NOT build. Building is minutes of agentic shell work (Claude
 * Code against the repo) — that's a GitHub Action. The watcher FIRES that Action
 * via repository_dispatch and records that it fired; the Action commits to
 * `staging`, lets Vercel deploy, and writes Build Status + Preview URL back here.
 * ---------------------------------------------------------------------------
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  projectByName, cronAuthorized, getSheets, readQueue, updateCells,
  QueueRow, ColumnName,
} from "../lib/pipeline-common.js";

export const maxDuration = 60;

const MAX_REVISIONS = 3;
const sheets = getSheets();

// --- GitHub build trigger ----------------------------------------------------
// Fires a repository_dispatch event the build workflow listens for. Needs a
// GitHub token with `repo` scope in env. If unset, the watcher still routes
// decisions — it just records that the build couldn't be fired.
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

// --- Helpers -----------------------------------------------------------------
const stamp = () => new Date().toISOString();

function appendLog(existing: string, line: string): string {
  const entry = `[${stamp()}] ${line}`;
  return existing ? `${existing}\n${entry}` : entry;
}

async function write(rowNum: number, updates: Partial<Record<ColumnName, string>>) {
  await updateCells(sheets, rowNum, { ...updates, "Updated At": stamp() });
}

// --- Decision handlers -------------------------------------------------------
async function handleDecision(row: QueueRow): Promise<string> {
  const decision = row.get("Review").trim();
  const feedback = row.get("Review Feedback").trim();
  const log = row.get("Review Log");
  const revisions = Number(row.get("Revisions") || "0");
  const project = projectByName(row.get("Product"));
  const id = row.get("Idea ID");

  switch (decision) {
    case "Approved": {
      // design-only projects don't autonomously build — they stop at an approved spec.
      if (project && project.deploy === "design-only") {
        await write(row.rowNum, {
          Stage: "Ready to Promote", // "ready for a human to build against client infra"
          Review: "Pending",
          "Review Log": appendLog(log, "Approved — design-only project; spec ready for human build (no autonomous deploy)"),
          "Decided At": stamp(),
          "Build Status": "design-only: handed off (no autonomous build)",
        });
        return `${id}: approved (design-only handoff)`;
      }
      // one-tap / preview-only: move to Building and fire the GitHub Action.
      const fired = await fireBuild(row);
      await write(row.rowNum, {
        Stage: "Building",
        Review: "Pending",
        "Decided At": stamp(),
        "Build Status": fired.ok ? "build fired (staging)" : `build NOT fired: ${fired.note}`,
        "Review Log": appendLog(log, `Approved — ${fired.note}`),
        ...(fired.ok ? {} : { "Blocked Reason": fired.note }),
      });
      return `${id}: approved (${fired.ok ? "build fired" : "build NOT fired"})`;
    }

    case "Revise Design":
    case "Revise Research": {
      if (!feedback) {
        await write(row.rowNum, {
          Review: "Hold",
          "Review Log": appendLog(log, `${decision} requested but no feedback given — held; add Review Feedback then re-decide`),
        });
        return `${id}: ${decision} missing feedback — held`;
      }
      const next = revisions + 1;
      if (next >= MAX_REVISIONS) {
        await write(row.rowNum, {
          Stage: "Blocked",
          Review: "Pending",
          Revisions: String(next),
          "Decided At": stamp(),
          "Blocked Reason": `Hit ${MAX_REVISIONS} revisions — needs a real conversation, not another autonomous pass`,
          "Review Log": appendLog(log, `${decision} (rev ${next}) — LOOP GUARD: moved to Blocked. Feedback: ${feedback}`),
        });
        return `${id}: ${decision} -> Blocked (loop guard at ${next})`;
      }
      const backTo = decision === "Revise Design" ? "Designing" : "Enriching";
      await write(row.rowNum, {
        Stage: backTo,
        Review: "Pending",
        Revisions: String(next),
        "Decided At": stamp(),
        "Review Log": appendLog(log, `${decision} (rev ${next}) -> ${backTo}. Feedback: ${feedback}`),
      });
      return `${id}: ${decision} -> ${backTo} (rev ${next})`;
    }

    case "Declined": {
      await write(row.rowNum, {
        Stage: "Declined",
        Review: "Pending",
        "Decided At": stamp(),
        "Review Log": appendLog(log, `Declined.${feedback ? " Reason: " + feedback : ""}`),
      });
      return `${id}: declined`;
    }

    case "Hold": {
      await write(row.rowNum, {
        "Decided At": stamp(),
        "Review Log": appendLog(log, `Hold.${feedback ? " Note: " + feedback : ""}`),
      });
      return `${id}: held`;
    }

    default:
      return `${id}: unknown decision "${decision}" — skipped`;
  }
}

// Advance rows the build has finished into the one-tap promotion queue.
async function advanceFinishedBuilds(row: QueueRow): Promise<string | null> {
  const stage = row.get("Stage");
  const status = row.get("Build Status").toLowerCase();
  const preview = row.get("Preview URL").trim();
  if ((stage === "Building" || stage === "Testing" || stage === "Preview Deployed")
      && status.includes("preview-ready") && preview) {
    await write(row.rowNum, {
      Stage: "Ready to Promote",
      "Review Log": appendLog(row.get("Review Log"), `Build preview ready at ${preview} — Ready to Promote (one-tap to prod)`),
    });
    return `${row.get("Idea ID")}: -> Ready to Promote`;
  }
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!cronAuthorized(req.headers.authorization)) return res.status(401).json({ error: "unauthorized" });

  try {
    const { rows } = await readQueue(sheets);
    const actions: string[] = [];

    // 1. Act on review decisions (In Review rows with a non-Pending Review).
    for (const row of rows) {
      if (row.get("Stage") !== "In Review") continue;
      const decision = row.get("Review").trim();
      if (!decision || decision === "Pending") continue;
      actions.push(await handleDecision(row));
    }

    // 2. Advance any builds that have reported a ready preview.
    for (const row of rows) {
      const a = await advanceFinishedBuilds(row);
      if (a) actions.push(a);
    }

    return res.status(200).json({ ok: true, acted: actions.length, actions });
  } catch (err: any) {
    console.error("[watcher] failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
