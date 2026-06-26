/**
 * api/idea.ts  ->  GET  /api/idea?id=IDEA-0007   (load one idea for the working view)
 *              ->  POST /api/idea                 (save the resolved build sequence back)
 * ---------------------------------------------------------------------------
 * The working view's data endpoint. GET hydrates the card from the Queue;
 * POST writes the rewritten Build Sequence back. Saving does NOT approve — it
 * leaves the row at "In Review" so Approve stays a separate, deliberate act
 * (two-gate design). It stamps the Review Log so the resolution is auditable,
 * and marks the Open Questions RESOLVED so a re-opened card reads as settled
 * (the decisions themselves are baked into the rewritten Build Sequence).
 * ---------------------------------------------------------------------------
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSheets, readQueue, updateCells } from "../lib/pipeline-common.js";
export const maxDuration = 30;
const sheets = getSheets();
const stamp = () => new Date().toISOString();

// Prepend a RESOLVED banner to the Open Questions, keeping the original text
// below for context. Idempotent: re-saving won't stack multiple banners.
function markResolved(openQuestions: string, when: string): string {
  const body = (openQuestions || "").replace(/^\[RESOLVED[^\]]*\]\s*/i, "").trim();
  const banner = `[RESOLVED ${when} — worked through via design chat; decisions baked into the Build Sequence below.]`;
  return body ? `${banner}\n\n${body}` : banner;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === "GET") {
      const id = String(req.query.id || "").trim();
      if (!id) return res.status(400).json({ error: "missing id" });
      const { rows } = await readQueue(sheets);
      const row = rows.find((r) => r.get("Idea ID") === id);
      if (!row) return res.status(404).json({ error: `no idea ${id}` });
      return res.status(200).json({
        ok: true,
        idea: {
          ideaId: row.get("Idea ID"), title: row.get("Title"),
          stage: row.get("Stage"), product: row.get("Product"),
          priority: row.get("Priority Score"),
          reasoning: row.get("Reasoning"), aiNative: row.get("AI-Native Approach"),
          openQuestions: row.get("Open Questions"),
          designBrief: row.get("Design Brief"), buildSequence: row.get("Build Sequence"),
          reviewLog: row.get("Review Log"), rowNum: row.rowNum,
        },
      });
    }
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const { id, buildSequence } = body || {};
      if (!id || typeof buildSequence !== "string")
        return res.status(400).json({ error: "need id + buildSequence" });
      const { rows } = await readQueue(sheets);
      const row = rows.find((r) => r.get("Idea ID") === id);
      if (!row) return res.status(404).json({ error: `no idea ${id}` });
      const now = stamp();
      const log = row.get("Review Log");
      const entry = `[${now}] Build Sequence resolved via design chat (open questions worked through).`;
      await updateCells(sheets, row.rowNum, {
        "Build Sequence": buildSequence,
        "Open Questions": markResolved(row.get("Open Questions"), now),
        "Review Log": log ? `${log}\n${entry}` : entry,
        "Updated At": now,
        // Stage stays "In Review"; Review stays whatever it was. Approve is separate.
      });
      return res.status(200).json({ ok: true, savedAt: now });
    }
    return res.status(405).json({ error: "GET or POST only" });
  } catch (err: any) {
    console.error("[idea] failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
