// api/decide.ts  ->  POST /api/decide
//
// Applies a human review verdict SYNCHRONOUSLY and sets Stage directly. This replaces
// the old "write the Review column, let the watcher route it later" pattern: a verdict
// is a human decision made at the keyboard (in resolve.html), so it takes effect the
// moment it's made — same pattern as "Run design". The watcher no longer routes verdicts;
// it only fires builds for cards already at Stage="Approved".
//
// POST { id, verdict, feedback? }
//   "Approve"          -> Stage "Approved"   (watcher fires the build on its next run / Submit)
//   "Revise Research"  -> Stage "Enriching"  (the idea/research is wrong; re-enrich) + Revisions+1
//   "Revise Build"     -> Stage "Approved"   (the BUILD drifted from a correct spec; rebuild with
//                         the testing findings) + Revisions+1. Only valid from a build-done stage.
//                         The feedback travels INSIDE the Build Sequence column as a delimited
//                         revision preamble — the watcher's dispatch payload and the build
//                         workflow's prompt already carry Build Sequence, so no watcher or
//                         workflow change is needed. The preamble tells the agent the prior
//                         build is already committed on staging and to apply ONLY the
//                         adjustments — preventing the honest "already implemented" no-op.
//                         A later revision REPLACES the preamble (never stacks).
//                         Unlike Revise Research, the design brief is NOT regenerated:
//                         the spec was right; the implementation drifted.
//   "Decline"          -> Stage "Declined"   (terminal)
//   "Hold"             -> stays put, logged
// Loop guard: a Revise at MAX_REVISIONS routes to "Blocked" instead of looping again.
//
// ("Revise Design" is NOT a verdict here — when the spec is wrong the human is already in
//  the design workspace and re-runs design / rewrites it in place, via /api/design-brief.)

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSheets, readQueue, updateCells } from "../lib/pipeline-common.js";
export const maxDuration = 30;

const MAX_REVISIONS = 3;

// Delimiters for the Revise Build preamble injected into Build Sequence. The END line
// doubles as the strip marker so a second revision replaces (not stacks) the first.
const REV_START = "=== BUILD REVISION";
const REV_END = "=== END REVISION — original build sequence follows for context ===";

const sheets = getSheets();
const stamp = () => new Date().toISOString();
const appendLog = (existing: string, line: string) => {
  const entry = `[${stamp()}] ${line}`;
  return existing ? `${existing}\n${entry}` : entry;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  // This endpoint can pass the build gate (Approve -> Approved -> watcher builds), so it is
  // ALWAYS gated and fails closed — same posture as /api/review.
  const gate = process.env.BOARD_KEY;
  if (!gate) return res.status(403).json({ ok: false, error: "Decisions are locked. Set BOARD_KEY in Vercel to enable them." });
  if (req.query.key !== gate) return res.status(401).json({ ok: false, error: "Unauthorized." });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const id = String(body?.id || "").trim();
    const verdict = String(body?.verdict || "").trim();
    const feedback = String(body?.feedback || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "missing id" });
    if (!verdict) return res.status(400).json({ ok: false, error: "missing verdict" });

    const { rows } = await readQueue(sheets);
    const row = rows.find((r) => r.get("Idea ID").trim() === id);
    if (!row) return res.status(404).json({ ok: false, error: `idea ${id} not found` });

    const log = row.get("Review Log");
    const revisions = Number(row.get("Revisions") || "0");
    const write = (u: Record<string, string>) =>
      updateCells(sheets, row.rowNum, { ...u, "Updated At": stamp(), "Decided At": stamp() } as any);

    switch (verdict) {
      case "Approve":
      case "Approved": {
        await write({ Stage: "Approved", Review: "Pending",
          "Review Log": appendLog(log, `Approved — queued for build (watcher fires on next run / Submit).${feedback ? " Note: " + feedback : ""}`) });
        return res.status(200).json({ ok: true, id, stage: "Approved" });
      }
      case "Decline":
      case "Declined": {
        await write({ Stage: "Declined", Review: "Pending",
          "Review Log": appendLog(log, `Declined.${feedback ? " Reason: " + feedback : ""}`) });
        return res.status(200).json({ ok: true, id, stage: "Declined" });
      }
      case "Revise Research": {
        if (!feedback) return res.status(400).json({ ok: false, error: "Revise needs feedback so the redo has direction" });
        const next = revisions + 1;
        if (next >= MAX_REVISIONS) {
          await write({ Stage: "Blocked", Review: "Pending", Revisions: String(next),
            "Blocked Reason": `Hit ${MAX_REVISIONS} revisions — needs a real conversation, not another autonomous pass`,
            "Review Log": appendLog(log, `Revise Research (rev ${next}) — LOOP GUARD -> Blocked. Feedback: ${feedback}`) });
          return res.status(200).json({ ok: true, id, stage: "Blocked" });
        }
        await write({ Stage: "Enriching", Review: "Pending", Revisions: String(next), "Review Feedback": feedback,
          "Review Log": appendLog(log, `Revise Research (rev ${next}) -> Enriching. Feedback: ${feedback}`) });
        return res.status(200).json({ ok: true, id, stage: "Enriching" });
      }
      case "Revise Build": {
        // Testing found implementation drift: the spec is right, the committed build needs
        // adjustment. Route back through the NORMAL build path (Stage -> Approved; the
        // watcher's claim-before-fire dispatch and the build workflow run unchanged).
        if (!feedback) return res.status(400).json({ ok: false, error: "Revise Build needs the testing findings so the rebuild has direction" });
        const stageNow = row.get("Stage").trim();
        if (["Testing", "Building", "Preview Deployed"].indexOf(stageNow) < 0) {
          return res.status(400).json({ ok: false, error: `Revise Build is only valid from a build-done stage (idea is at "${stageNow}")` });
        }
        const next = revisions + 1;
        if (next >= MAX_REVISIONS) {
          await write({ Stage: "Blocked", Review: "Pending", Revisions: String(next),
            "Blocked Reason": `Hit ${MAX_REVISIONS} revisions — needs a real conversation, not another autonomous pass`,
            "Review Log": appendLog(log, `Revise Build (rev ${next}) — LOOP GUARD -> Blocked. Findings: ${feedback}`) });
          return res.status(200).json({ ok: true, id, stage: "Blocked" });
        }

        // Strip any previous revision preamble so revisions replace, never stack.
        let seq = String(row.get("Build Sequence") || "");
        if (seq.startsWith(REV_START)) {
          const endIdx = seq.indexOf(REV_END);
          if (endIdx >= 0) seq = seq.slice(endIdx + REV_END.length).replace(/^\s+/, "");
        }

        const preamble = [
          `${REV_START} (rev ${next}) — ${stamp()} ===`,
          ``,
          `The prior build for this idea is ALREADY COMMITTED on the staging branch.`,
          `The base feature exists and was verified working on the staging preview.`,
          `Do NOT re-implement it, and do NOT conclude "already implemented" and stop:`,
          `your task is to apply ONLY the adjustments below to the existing`,
          `implementation. Change nothing else. All original scope locks still apply.`,
          ``,
          `Adjustments requested from preview testing:`,
          feedback,
          ``,
          REV_END,
        ].join("\n");

        await write({ Stage: "Approved", Review: "Pending", Revisions: String(next),
          "Review Feedback": feedback,
          "Build Sequence": `${preamble}\n\n${seq}`,
          "Review Log": appendLog(log, `Revise Build (rev ${next}) -> Approved for rebuild (watcher fires on next run / Submit). Findings: ${feedback}`) });
        return res.status(200).json({ ok: true, id, stage: "Approved" });
      }
      case "Advance": {
        // Human hold-release: the person verified the staging preview and advances the
        // build to the promotion queue. Only valid from Testing (or an equivalent build-done
        // stage) — the build must have produced a preview to advance.
        const stageNow = row.get("Stage").trim();
        if (["Testing", "Building", "Preview Deployed"].indexOf(stageNow) < 0) {
          return res.status(400).json({ ok: false, error: `Advance is only valid from a build-done stage (idea is at "${stageNow}")` });
        }
        await write({ Stage: "Ready to Promote",
          "Review Log": appendLog(log, `Preview verified — advanced to Ready to Promote.${feedback ? " Note: " + feedback : ""}`) });
        return res.status(200).json({ ok: true, id, stage: "Ready to Promote" });
      }
      case "Hold": {
        await write({ "Review Log": appendLog(log, `Hold.${feedback ? " Note: " + feedback : ""}`) });
        return res.status(200).json({ ok: true, id, stage: row.get("Stage") });
      }
      default:
        return res.status(400).json({ ok: false, error: `unknown verdict "${verdict}"` });
    }
  } catch (err: any) {
    console.error("[decide] failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
