/**
 * api/research.ts  ->  GET/POST /api/research
 * Researches every project, writes new idea cards to the Sheet at Stage = "Captured".
 * Triggered by Vercel Cron (see vercel.json) or hit manually to test.
 *
 * Enrichment does NOT form design/implementation questions. Those are created later, at
 * the design step, once the idea's SCOPE has been locked (scope check + Run design).
 * Forming them here would presuppose a scope nobody has decided yet — the exact failure
 * where "make the pane taller" silently became "build a resize system." The agent instead
 * states the idea's scope plainly in its reasoning; the Open Questions column starts empty.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import {
  PROJECTS, AI_NATIVE_DIRECTIVE, Project, cronAuthorized,
  getSheets, readQueue, newRow, setCell, SHEET_ID, TAB, DEFAULT_MODEL,
} from "../lib/pipeline-common.js";
export const maxDuration = 60;

const MODEL = DEFAULT_MODEL;
const MAX_IDEAS_PER_PROJECT = 3;
const MAX_WEB_SEARCHES = 6;

const anthropic = new Anthropic();
const sheets = getSheets();

interface IdeaCard {
  title: string;
  reasoning: string;
  aiNativeApproach: string;
  priorityScore: number;
  priorityRationale: string;
  sources: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function rowFor(idea: IdeaCard, project: Project, ideaId: string, now: string): string[] {
  const row = newRow();
  setCell(row, "Idea ID", ideaId);
  setCell(row, "Title", idea.title);
  setCell(row, "Stage", "Captured");
  setCell(row, "Source", "Research Agent");
  setCell(row, "Product", project.name);
  setCell(row, "Priority Score", String(Math.round(idea.priorityScore ?? 0)));
  setCell(row, "Priority Rationale", idea.priorityRationale ?? "");
  setCell(row, "Reasoning", idea.reasoning ?? "");
  setCell(row, "AI-Native Approach", idea.aiNativeApproach ?? "");
  setCell(row, "Evidence / Sources", idea.sources ?? "");
  // Design questions are formed at the design step (after scope is locked), not here.
  setCell(row, "Open Questions", "");
  setCell(row, "Repo + Target", project.repo);
  setCell(row, "Review", "Pending");
  setCell(row, "Revisions", "0");
  setCell(row, "Created At", now);
  setCell(row, "Updated At", now);
  return row;
}

async function existingByProject() {
  const { rows } = await readQueue(sheets);
  const titlesByProduct = new Map<string, string[]>();
  let maxNum = 0;
  for (const r of rows) {
    const title = r.get("Title");
    const product = r.get("Product");
    if (title && product) {
      const list = titlesByProduct.get(product) ?? [];
      list.push(title);
      titlesByProduct.set(product, list);
    }
    const m = /IDEA-(\d+)/.exec(r.get("Idea ID"));
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  }
  return { titlesByProduct, nextNum: maxNum + 1 };
}

async function research(project: Project, existingTitles: string[]): Promise<IdeaCard[]> {
  const role =
    project.kind === "product"
      ? "a senior product strategist for the following product you sell"
      : "a senior solutions strategist for the following client engagement; propose improvements that serve the client better and deepen the relationship";

  const system = `You are ${role}.

${project.context}

${AI_NATIVE_DIRECTIVE}

Your job: monitor the focus areas, find what's genuinely new or shifting, and propose ideas
that would move this forward. Be specific and grounded - every idea must trace to evidence you
actually found, not speculation. Prefer a few strong ideas over many weak ones. Score priority
0-100 on impact vs. effort, and explain the score.

In "reasoning", make the idea's SCOPE clear: what the change is and, where it helps, what it does
and does not include — one coherent change, not several bundled together. Do NOT raise design or
implementation questions (which control to use, how to build it, whether to persist state, edge
behaviors). Those are formed later, at the design step, once the scope has been locked. Raising
them now would bake in a scope that has not been decided yet.

These ideas already exist in the queue for this project - do NOT propose anything that overlaps:
${existingTitles.length ? existingTitles.map((t) => `- ${t}`).join("\n") : "(none yet)"}

Output ONLY a JSON array, no prose, no markdown fences. Each element:
{ "title": string, "reasoning": string, "aiNativeApproach": string, "priorityScore": number,
  "priorityRationale": string, "sources": string }
Return at most ${MAX_IDEAS_PER_PROJECT} ideas.`;

  const user = `Research these focus areas and propose ideas:\n${project.focus.map((f) => `- ${f}`).join("\n")}`;

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_WEB_SEARCHES } as any],
    messages: [{ role: "user", content: user }],
  });

  const text = resp.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .replace(/```json|```/g, "")
    .trim();

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.error(`[${project.name}] could not parse idea JSON. Raw:\n`, text);
    return [];
  }
}

function dedupe(ideas: IdeaCard[], existingTitles: string[]): IdeaCard[] {
  const seen = new Set(existingTitles.map(norm));
  return ideas.filter((i) => i.title && !seen.has(norm(i.title)));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!cronAuthorized(req.headers.authorization)) return res.status(401).json({ error: "unauthorized" });

  const now = new Date().toISOString();
  try {
    const { titlesByProduct, nextNum } = await existingByProject();
    let n = nextNum;
    const rows: string[][] = [];
    const summary: Record<string, number> = {};

    for (const project of PROJECTS) {
      const existing = titlesByProduct.get(project.name) ?? [];
      const candidates = await research(project, existing);
      const fresh = dedupe(candidates, existing);
      summary[project.name] = fresh.length;
      for (const idea of fresh) {
        rows.push(rowFor(idea, project, `IDEA-${String(n++).padStart(4, "0")}`, now));
      }
    }

    if (rows.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${TAB}!A:AB`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: rows },
      });
    }

    return res.status(200).json({ ok: true, created: rows.length, perProject: summary });
  } catch (err: any) {
    console.error("[research] failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
