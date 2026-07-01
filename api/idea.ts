/**
 * api/idea.ts  ->  GET  /api/idea?id=IDEA-0007   (load one idea for the working view)
 *              ->  POST /api/idea                 (save changes back)
 * ---------------------------------------------------------------------------
 * The working view's data endpoint. GET hydrates the card from the Queue.
 *
 * POST has two modes, chosen by payload:
 *   1. RESOLVE SAVE  { id, buildSequence }
 *      The design-chat result. Writes the rewritten Build Sequence, marks the
 *      Open Questions RESOLVED, logs it. Leaves the row at "Designing" so Approve
 *      stays a separate, deliberate act (two-gate design).
 *   2. FIELD EDIT    { id, reasoning?, aiNative?, openQuestions?, title?, lockedScope? }
 *      Pre-design intake tweaks from the read-only/editable card. Writes only the
 *      provided fields with NO "resolved" semantics — you're shaping the idea, not
 *      settling it. Logged plainly so the edit is still auditable.
 *      lockedScope is the machine-readable {in:[],out:[]} the scope-chat rewrite
 *      emits; it's serialized to the "Locked Scope" column with a SERVER-side
 *      lockedAt stamp. An empty column means "scope never explicitly locked" —
 *      the supervisor's Phase-2 drift check skips those rows rather than
 *      inventing a baseline.
 * ---------------------------------------------------------------------------
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSheets, readQueue, updateCells, lintIdea, parseLockedScope } from "../lib/pipeline-common.js";
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

// Editable fields for the field-edit path -> Queue column names.
const EDITABLE: Record<string, string> = {
  reasoning: "Reasoning",
  aiNative: "AI-Native Approach",
  openQuestions: "Open Questions",
  title: "Title",
};

// Sanitize a locked-scope list: strings only, trimmed, bounded — mirrors the
// sanitization idea-chat applies before returning it, so a hand-crafted POST
// can't write garbage either.
const cleanScopeList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x: any) => typeof x === "string" && x.trim()).map((x: string) => x.trim().slice(0, 160)).slice(0, 12)
    : [];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === "GET") {
      const id = String(req.query.id || "").trim();
      if (!id) return res.status(400).json({ error: "missing id" });
      const { rows } = await readQueue(sheets);
      const row = rows.find((r) => r.get("Idea ID") === id);
      if (!row) return res.status(404).json({ error: `no idea ${id}` });
      // Locked Scope is stored as JSON; return it parsed (or null when absent/unparseable)
      // so the client never has to guess the cell format.
      const lockedScope = (() => {
        try {
          const v = JSON.parse(row.get("Locked Scope") || "");
          return v && typeof v === "object" ? v : null;
        } catch { return null; }
      })();
      return res.status(200).json({
        ok: true,
        idea: {
          ideaId: row.get("Idea ID"), title: row.get("Title"),
          stage: row.get("Stage"), product: row.get("Product"),
          priority: row.get("Priority Score"),
          reasoning: row.get("Reasoning"), aiNative: row.get("AI-Native Approach"),
          openQuestions: row.get("Open Questions"),
          designBrief: row.get("Design Brief"), buildSequence: row.get("Build Sequence"),
          lockedScope,
          reviewLog: row.get("Review Log"), rowNum: row.rowNum,
        },
      });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const { id } = body || {};
      if (!id) return res.status(400).json({ error: "missing id" });

      const { rows } = await readQueue(sheets);
      const row = rows.find((r) => r.get("Idea ID") === id);
      if (!row) return res.status(404).json({ error: `no idea ${id}` });

      const now = stamp();
      const log = row.get("Review Log");

      // Mode 1: resolve save (design chat result). Unchanged behavior.
      if (typeof body.buildSequence === "string") {
        const entry = `[${now}] Build Sequence resolved via design chat (open questions worked through).`;
        await updateCells(sheets, row.rowNum, {
          "Build Sequence": body.buildSequence,
          "Open Questions": markResolved(row.get("Open Questions"), now),
          "Review Log": log ? `${log}\n${entry}` : entry,
          Lint: lintIdea({
            title: row.get("Title"), description: row.get("Reasoning"),
            aiNative: row.get("AI-Native Approach"),
            brief: row.get("Design Brief"), sequence: body.buildSequence,
            lockedScope: parseLockedScope(row.get("Locked Scope")),
          }),
          "Updated At": now,
          // Stage stays "Designing"; Review stays whatever it was. Approve is separate.
        });
        return res.status(200).json({ ok: true, savedAt: now, mode: "resolve" });
      }

      // Mode 2: plain field edit (pre-design). Only known editable fields, no
      // "resolved" semantics — this is shaping the idea, not settling it.
      const updates: Record<string, string> = {};
      const changed: string[] = [];
      for (const [key, col] of Object.entries(EDITABLE)) {
        if (typeof body[key] === "string") { updates[col] = body[key]; changed.push(key); }
      }

      // Locked scope (from the scope-chat rewrite): sanitize, stamp lockedAt
      // SERVER-side (the model doesn't own the clock), serialize to the column.
      // Only written when at least one bullet survives sanitization — never
      // overwrite an existing lock with an empty shell.
      let lockedScopeOut: { in: string[]; out: string[]; lockedAt: string } | null = null;
      if (body.lockedScope && typeof body.lockedScope === "object") {
        const scope = {
          in: cleanScopeList(body.lockedScope.in),
          out: cleanScopeList(body.lockedScope.out),
          lockedAt: now,
        };
        if (scope.in.length || scope.out.length) {
          lockedScopeOut = scope;
          updates["Locked Scope"] = JSON.stringify(scope);
          changed.push("lockedScope");
        }
      }

      if (changed.length === 0) {
        return res.status(400).json({ error: "need buildSequence, or an editable field (reasoning/aiNative/openQuestions/title/lockedScope)" });
      }
      const entry = `[${now}] Idea edited pre-design (${changed.join(", ")}).`;
      updates["Review Log"] = log ? `${log}\n${entry}` : entry;
      // Re-lint the RESULTING state — a rewrite lands here, so this catches narration in the
      // new description, name leakage, etc. Effective value = the edit if present, else current.
      updates["Lint"] = lintIdea({
        title: updates["Title"] ?? row.get("Title"),
        description: updates["Reasoning"] ?? row.get("Reasoning"),
        aiNative: updates["AI-Native Approach"] ?? row.get("AI-Native Approach"),
        brief: row.get("Design Brief"), sequence: row.get("Build Sequence"),
        lockedScope: lockedScopeOut ?? parseLockedScope(row.get("Locked Scope")),
      });
      updates["Updated At"] = now;
      await updateCells(sheets, row.rowNum, updates);
      // Echo the stamped scope back so the client can render the saved state
      // (with lockedAt) without a reload.
      return res.status(200).json({
        ok: true, savedAt: now, mode: "edit", changed,
        ...(lockedScopeOut ? { lockedScope: lockedScopeOut } : {}),
      });
    }

    return res.status(405).json({ error: "GET or POST only" });
  } catch (err: any) {
    console.error("[idea] failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
