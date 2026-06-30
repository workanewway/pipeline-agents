/**
 * api/digest.ts  ->  GET/POST /api/digest
 * The pipeline's doorbell. Once a day (14:00 UTC, after the other agents) it gathers everything
 * WAITING ON A HUMAN and — if Resend env is set — emails it. Returns the HTML in the response too,
 * so you can open /api/digest in a browser to preview it.
 *
 * After the stage-contract refactor the human-gated stages are Designing (needs a verdict),
 * Testing / Preview Deployed (needs verification + advance), Ready to Promote (needs a promote),
 * and Blocked (needs attention). Override the set with SOURCE_STAGES (comma-separated) to test.
 *
 * Emails via Resend only if RESEND_API_KEY / DIGEST_FROM / DIGEST_TO are set; otherwise it just
 * returns the HTML (fail-soft — no doorbell, but never an error).
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import { getSheets, readQueue, QueueRow, DEFAULT_MODEL, cronAuthorized } from "../lib/pipeline-common.js";

export const maxDuration = 60;

const MODEL = DEFAULT_MODEL;

// The doorbell's whole purpose: surface what's WAITING ON A HUMAN.
const WAITING_STAGES = (process.env.SOURCE_STAGES || "Designing,Testing,Preview Deployed,Ready to Promote,Blocked")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Per-stage: the action it's waiting on, an instruction, and a sort order (most urgent first).
const STAGE_INFO: Record<string, { label: string; instruction: string; order: number }> = {
  "Blocked":          { label: "Blocked — needs attention", instruction: "A build failed or hit a guard. Open it to see the reason and decide what to do.", order: 1 },
  "Testing":          { label: "Needs your verification", instruction: "Build preview is ready — verify it, then advance it to Ready to Promote.", order: 2 },
  "Preview Deployed": { label: "Needs your verification", instruction: "Build preview is ready — verify it, then advance it to Ready to Promote.", order: 2 },
  "Ready to Promote": { label: "Ready to promote to production", instruction: "Verified and waiting. Promote from the board when you're ready.", order: 3 },
  "Designing":        { label: "Needs your verdict", instruction: "The spec is ready. Open it in resolve to approve, send back, or decline.", order: 4 },
};

const anthropic = new Anthropic();
const sheets = getSheets(true);

const APP_BASE = (process.env.BOARD_URL || "https://pipeline-agents-opal.vercel.app").replace(/\/$/, "");
const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Deep-link to the per-item resolve view (stage-aware). No key in the URL — emails get logged and
// forwarded, so secrets never go in links; act from your keyed board session.
const resolveLink = (id: string) => `${APP_BASE}/resolve.html?id=${encodeURIComponent(id)}`;

async function synthesize(items: QueueRow[]): Promise<string> {
  const compact = items
    .map((it) => `- [${it.get("Stage")}] ${it.get("Product")}: ${it.get("Title")} (priority ${it.get("Priority Score")})`)
    .join("\n");
  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: `You are the chief of staff for Wayne's product pipeline. Below is everything currently
waiting on him — each item tagged with the stage it's stuck at (Designing = needs his verdict,
Testing = needs him to verify a build preview, Ready to Promote = needs him to ship it, Blocked =
something failed). Write a 3-5 sentence editorial brief: what to handle first and why, anything that
looks stuck or risky, any cross-project theme. Direct, no fluff, no markdown headers or bullets.`,
      messages: [{ role: "user", content: `Waiting on you:\n${compact}` }],
    });
    return resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim();
  } catch (e) {
    console.error("[digest] synthesis failed:", e);
    return "";
  }
}

function renderItem(it: QueueRow): string {
  const id = it.get("Idea ID");
  const field = (label: string, key: string) => {
    const v = it.get(key);
    return v ? `<p style="margin:6px 0"><strong>${label}:</strong> ${esc(v)}</p>` : "";
  };
  const priority = it.get("Priority Score");
  const tag = [id, priority ? `priority ${priority}` : ""].filter(Boolean).join(" · ");
  const preview = it.get("Preview URL");
  const blocked = it.get("Blocked Reason");

  return `<div style="border:1px solid #E2E8F0;border-radius:10px;padding:16px;margin:12px 0">
    <div style="display:flex;justify-content:space-between;align-items:baseline">
      <h3 style="margin:0;color:#1A202C;font-size:16px">${esc(it.get("Title"))}</h3>
      <span style="color:#718096;font-size:13px;white-space:nowrap;padding-left:12px">${esc(tag)}</span>
    </div>
    ${blocked ? `<p style="margin:6px 0;color:#B23030"><strong>Blocked:</strong> ${esc(blocked)}</p>` : ""}
    ${field("Reasoning", "Reasoning")}
    ${field("AI-Native Approach", "AI-Native Approach")}
    ${preview ? `<p style="margin:6px 0"><strong>Preview:</strong> <a href="${esc(preview)}" style="color:#3182CE">${esc(preview)}</a></p>` : ""}
    <p style="margin:12px 0 0"><a href="${resolveLink(id)}"
       style="background:#3182CE;color:#fff;text-decoration:none;padding:8px 14px;border-radius:6px;font-size:14px">Open ${esc(id)} →</a></p>
  </div>`;
}

function renderEmail(items: QueueRow[], brief: string): string {
  // Group by the ACTION needed (stage), most urgent first — that's what a doorbell should lead with.
  const groups = new Map<string, QueueRow[]>();
  for (const it of items) {
    const st = it.get("Stage");
    (groups.get(st) ?? groups.set(st, []).get(st)!).push(it);
  }
  const ordered = [...groups.entries()].sort((a, b) => {
    const oa = STAGE_INFO[a[0]]?.order ?? 99, ob = STAGE_INFO[b[0]]?.order ?? 99;
    return oa - ob;
  });

  const sections = ordered.map(([stage, list]) => {
    const info = STAGE_INFO[stage] || { label: stage, instruction: "" };
    list.sort((a, b) => Number(b.get("Priority Score")) - Number(a.get("Priority Score")));
    return `
    <h2 style="color:#305D94;font-size:18px;margin:24px 0 4px;border-bottom:2px solid #305D94;padding-bottom:4px">
      ${esc(info.label)} <span style="color:#A0AEC0;font-weight:normal;font-size:14px">(${list.length})</span></h2>
    ${info.instruction ? `<p style="color:#4A5568;font-size:13px;margin:4px 0 8px">${esc(info.instruction)}</p>` : ""}
    ${list.map(renderItem).join("")}`;
  }).join("");

  return `<div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1A202C">
    <h1 style="font-size:20px;color:#305D94">Pipeline — ${items.length} waiting on you</h1>
    ${brief ? `<p style="background:#F7FAFC;border-left:3px solid #ED8936;padding:12px 14px;margin:12px 0;line-height:1.5">${esc(brief)}</p>` : ""}
    <p style="color:#4A5568;font-size:14px;line-height:1.5">Each item links to its resolve view. Act from your
      <a href="${APP_BASE}/" style="color:#3182CE">Foundry board</a> (signed in) — verdicts and advances happen there.</p>
    ${sections}</div>`;
}

async function sendViaResend(subject: string, html: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key || !process.env.DIGEST_TO || !process.env.DIGEST_FROM) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.DIGEST_FROM, to: process.env.DIGEST_TO, subject, html }),
  });
  if (!r.ok) console.error("[digest] resend failed:", r.status, await r.text());
  return r.ok;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!cronAuthorized(req.headers.authorization)) return res.status(401).json({ error: "unauthorized" });

  try {
    const { rows } = await readQueue(sheets);
    const items = rows.filter((r) => WAITING_STAGES.indexOf(r.get("Stage")) >= 0);

    if (items.length === 0) {
      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Digest-Emailed", "false");
      return res.status(200).send(`<p style="font-family:Arial">Nothing waiting on you right now — no digest sent. (Watching: ${WAITING_STAGES.join(", ")}.)</p>`);
    }

    const brief = await synthesize(items);
    const html = renderEmail(items, brief);
    const sent = await sendViaResend(`Pipeline — ${items.length} waiting on you`, html);

    res.setHeader("Content-Type", "text/html");
    res.setHeader("X-Digest-Emailed", String(sent));
    return res.status(200).send(html);
  } catch (err: any) {
    console.error("[digest] failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
