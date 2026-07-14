import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import {
  PROJECTS, projectByName, AI_NATIVE_DIRECTIVE,
  getSheets, readQueue, newRow, setCell, updateCells, RowDraft, DEFAULT_MODEL,
} from "../lib/pipeline-common.js";

export const maxDuration = 120;

const MODEL = DEFAULT_MODEL;
const MAX_WEB_SEARCHES = 4;
const PRIORITY_FLOOR = 60;

const anthropic = new Anthropic();
const sheets = getSheets();

const PRODUCT_NAMES = PROJECTS.map((p) => p.name);

interface Draft {
  title: string;
  product: string;
  reasoning: string;
  aiNativeApproach: string;
  priorityScore: number;
  priorityRationale: string;
  openQuestions: string;
  sources: string;
  designBrief: string;
  buildSequence: string;
  baked: boolean;
}

const clampStr = (v: any, max = 20000): string => (typeof v === "string" ? v.slice(0, max) : "");
// F2 guard: a Source cell must never start with = + - @ (Sheets would parse it as
// a formula -> #ERROR! -> every API read of that row breaks). Broker-supplied
// attribution passes through here.
const sanitizeSource = (v: any): string => {
  const s = clampStr(v, 120).trim().replace(/^[=+\-@]+/, "").trim();
  return s || "Intake";
};
const clampPriority = (v: any): number =>
  Math.max(PRIORITY_FLOOR, Math.min(100, Math.round(Number(v) || PRIORITY_FLOOR)));

function normalizeDraft(d: any): Draft {
  const product = PRODUCT_NAMES.includes(d?.product) ? d.product : "Broker Platform";
  const designBrief = clampStr(d?.designBrief);
  const buildSequence = clampStr(d?.buildSequence);
  return {
    title: clampStr(d?.title, 200) || "(untitled idea)",
    product,
    reasoning: clampStr(d?.reasoning),
    aiNativeApproach: clampStr(d?.aiNativeApproach),
    priorityScore: clampPriority(d?.priorityScore),
    priorityRationale: clampStr(d?.priorityRationale, 1000),
    openQuestions: clampStr(d?.openQuestions),
    sources: clampStr(d?.sources, 4000),
    designBrief,
    buildSequence,
    baked: !!(buildSequence || designBrief),
  };
}

async function enrich(text: string): Promise<Draft> {
  const projectList = PROJECTS
    .map((p) => `- ${p.name}: ${p.kind === "product" ? "product we sell" : "client engagement"}`)
    .join("\n");

  const system = `You are a senior product + solutions strategist running intake for a build pipeline.
A user has pasted ONE idea. Bring it to "Captured-grade": a clear title, grounded reasoning, an
explicit AI-native approach, open questions, and a priority. Use web search where it helps ground a
thin idea in evidence; skip it when the idea is already detailed.

${AI_NATIVE_DIRECTIVE}

Classify which project this idea belongs to (choose EXACTLY one of these names):
${projectList}
If unclear, choose "Broker Platform".

PRESERVE BAKED SPECS: If the pasted idea already contains a build sequence and/or a design brief
(detailed, ordered, build-ready instructions), capture them VERBATIM into "buildSequence" and
"designBrief" and set "baked": true. Do NOT rewrite, summarize, or thin a baked spec — a later step
refines it. If the idea is a thin seed with no build steps, set "baked": false and leave
"buildSequence" and "designBrief" as "".

PRIORITY: This idea was deliberately submitted for the pipeline. Score "priorityScore" 60-100
reflecting its importance among deliberately-chosen work, with a one-line rationale.

Output ONLY a JSON object, no prose, no fences:
{ "title": string, "product": string, "reasoning": string, "aiNativeApproach": string,
  "priorityScore": number, "priorityRationale": string, "openQuestions": string,
  "sources": string, "designBrief": string, "buildSequence": string, "baked": boolean }`;

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_WEB_SEARCHES } as any],
    messages: [{ role: "user", content: `Idea pasted by the user:\n\n${text}` }],
  });

  const raw = resp.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .replace(/```json|```/g, "")
    .trim();

  let parsed: any;
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    parsed = { title: text.slice(0, 80), reasoning: text, baked: false };
  }
  return normalizeDraft(parsed);
}

async function nextRowAndId(): Promise<{ rowNum: number; ideaId: string }> {
  const { rows } = await readQueue(sheets);
  let maxNum = 0;
  let lastRow = 1;
  for (const r of rows) {
    const m = /IDEA-(\d+)/.exec(r.get("Idea ID"));
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    if (r.rowNum > lastRow) lastRow = r.rowNum;
  }
  return { rowNum: lastRow + 1, ideaId: `IDEA-${String(maxNum + 1).padStart(4, "0")}` };
}

// FIX: returns RowDraft (named-fields) not string[].
// updateCells resolves each column's position from the live sheet header — drift-proof.
function buildRow(d: Draft, ideaId: string, now: string, source: string): RowDraft {
  const project = projectByName(d.product);
  const row = newRow();
  setCell(row, "Idea ID", ideaId);
  setCell(row, "Title", d.title);
  setCell(row, "Stage", "Captured");
  setCell(row, "Source", source);
  setCell(row, "Product", d.product);
  setCell(row, "Priority Score", String(d.priorityScore));
  setCell(row, "Priority Rationale", d.priorityRationale);
  setCell(row, "Reasoning", d.reasoning);
  setCell(row, "AI-Native Approach", d.aiNativeApproach);
  setCell(row, "Evidence / Sources", d.sources);
  setCell(row, "Open Questions", d.openQuestions);
  if (d.designBrief)    setCell(row, "Design Brief",    d.designBrief);
  if (d.buildSequence)  setCell(row, "Build Sequence",  d.buildSequence);
  setCell(row, "Repo + Target", project?.repo ?? "");
  setCell(row, "Review",      "Pending");
  setCell(row, "Revisions",   "0");
  setCell(row, "Created At",  now);
  setCell(row, "Updated At",  now);
  return row;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // BOARD_KEY: the board UI's key. INTAKE_KEY (optional): a narrow-scope key valid
  // for THIS endpoint only — set it in Vercel to give an external system (e.g. the
  // vetting platform's broker feedback tile) intake access without handing it the
  // board key. Fail-closed: locked unless at least one key is configured.
  const validKeys = [process.env.BOARD_KEY, process.env.INTAKE_KEY].filter(Boolean);
  if (validKeys.length === 0)                       { res.status(403).json({ ok: false, error: "Intake is locked. Set BOARD_KEY in Vercel to enable it." }); return; }
  if (!validKeys.includes(String(req.query.key)))   { res.status(401).json({ ok: false, error: "Unauthorized." }); return; }
  if (req.method !== "POST")      { res.status(405).json({ ok: false, error: "Use POST." }); return; }

  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const isConfirm = !!(body.confirm && body.draft && typeof body.draft === "object");
  const text = clampStr(body.text, 40000).trim();
  if (!isConfirm && !text) { res.status(400).json({ ok: false, error: "Paste an idea first." }); return; }

  try {
    if (isConfirm) {
      const draft = normalizeDraft(body.draft);
      const source = sanitizeSource(body.source); // optional; defaults to "Intake" (board modal unchanged)
      const now = new Date().toISOString();
      const { rowNum, ideaId } = await nextRowAndId();
      const row = buildRow(draft, ideaId, now, source);
      // FIX: was sheets.spreadsheets.values.update with values:[row] where row is a
      // RowDraft object — Sheets API requires string[][] not Record<string,string>[].
      // updateCells resolves each column via the live header and writes correct ranges.
      await updateCells(sheets, rowNum, row);
      res.status(200).json({ ok: true, ideaId, product: draft.product, stage: "Captured", baked: draft.baked });
      return;
    }

    const draft = await enrich(text);
    res.status(200).json({ ok: true, draft });
  } catch (err: any) {
    console.error("[intake] failed:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
