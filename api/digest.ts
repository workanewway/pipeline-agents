/**
 * api/digest.ts  ->  GET/POST /api/digest
 * Builds the review digest from rows at Stage = "In Review" (set SOURCE_STAGE=Captured to test
 * before the design step has run). Returns the digest HTML in the response so you can SEE it in a
 * browser, and ALSO emails it via Resend if RESEND_API_KEY / DIGEST_FROM / DIGEST_TO are set.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import { getSheets, readQueue, QueueRow, SHEET_ID, SHEET_GID, DEFAULT_MODEL, cronAuthorized } from "../lib/pipeline-common.js";

export const maxDuration = 60;

const MODEL = DEFAULT_MODEL;
const SOURCE_STAGE = process.env.SOURCE_STAGE || "In Review";

const anthropic = new Anthropic();
const sheets = getSheets(true);

const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rowLink = (rowNum: number) =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${SHEET_GID}&range=A${rowNum}`;

async function synthesize(items: QueueRow[]): Promise<string> {
  const compact = items
    .map((it) => `- [${it.get("Product")}] ${it.get("Title")} (priority ${it.get("Priority Score")}) - AI-native: ${it.get("AI-Native Approach")}`)
    .join("\n");
  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: `You are the chief of staff for Wayne's product pipeline. He is about to review the items below.
Write a 3-5 sentence editorial brief: what to look at first and why, where you'd be least confident, any
cross-project theme. Direct, no fluff, no markdown headers or bullets. Plain prose only.`,
      messages: [{ role: "user", content: `Items awaiting review:\n${compact}` }],
    });
    return resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim();
  } catch (e) {
    console.error("[digest] synthesis failed:", e);
    return "";
  }
}

function renderItem(it: QueueRow): string {
  const field = (label: string, key: string) => {
    const v = it.get(key);
    return v ? `<p style="margin:6px 0"><strong>${label}:</strong> ${esc(v)}</p>` : "";
  };
  const source = it.get("Source");
  const priority = it.get("Priority Score");
  const tag = [source, priority ? `priority ${priority}` : ""].filter(Boolean).join(" · ");
  return `<div style="border:1px solid #E2E8F0;border-radius:10px;padding:16px;margin:12px 0">
    <div style="display:flex;justify-content:space-between;align-items:baseline">
      <h3 style="margin:0;color:#1A202C;font-size:16px">${esc(it.get("Title"))}</h3>
      <span style="color:#718096;font-size:13px;white-space:nowrap;padding-left:12px">${esc(tag)}</span>
    </div>
    ${field("AI-Native Approach", "AI-Native Approach")}
    ${field("Reasoning", "Reasoning")}
    ${field("Open Questions", "Open Questions")}
    ${field("Where it came from", "Evidence / Sources")}
    ${field("Build Sequence", "Build Sequence")}
    <p style="margin:12px 0 0"><a href="${rowLink(it.rowNum)}"
       style="background:#3182CE;color:#fff;text-decoration:none;padding:8px 14px;border-radius:6px;font-size:14px">Review this idea →</a></p>
  </div>`;
}

function renderEmail(items: QueueRow[], brief: string): string {
  const groups = new Map<string, QueueRow[]>();
  for (const it of items) {
    const p = it.get("Product") || "Unassigned";
    (groups.get(p) ?? groups.set(p, []).get(p)!).push(it);
  }
  for (const list of groups.values()) list.sort((a, b) => Number(b.get("Priority Score")) - Number(a.get("Priority Score")));

  const sections = [...groups.entries()].map(([product, list]) => `
    <h2 style="color:#305D94;font-size:18px;margin:24px 0 4px;border-bottom:2px solid #305D94;padding-bottom:4px">
      ${esc(product)} <span style="color:#A0AEC0;font-weight:normal;font-size:14px">(${list.length})</span></h2>
    ${list.map(renderItem).join("")}`).join("");

  return `<div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1A202C">
    <h1 style="font-size:20px;color:#305D94">Pipeline review — ${items.length} awaiting you</h1>
    ${brief ? `<p style="background:#F7FAFC;border-left:3px solid #ED8936;padding:12px 14px;margin:12px 0;line-height:1.5">${esc(brief)}</p>` : ""}
    <p style="color:#4A5568;font-size:14px;line-height:1.5">To act, open an idea and set the <strong>Review</strong> column
      (Approved / Revise Design / Revise Research / Hold / Declined). When sending back, add <strong>Review Feedback</strong> — it travels to the redo.</p>
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
    const items = rows.filter((r) => r.get("Stage") === SOURCE_STAGE);

    if (items.length === 0) {
      res.setHeader("Content-Type", "text/html");
      return res.status(200).send(`<p style="font-family:Arial">Nothing at "${SOURCE_STAGE}" right now — no digest sent.</p>`);
    }

    const brief = await synthesize(items);
    const html = renderEmail(items, brief);
    const sent = await sendViaResend(`Pipeline review — ${items.length} idea${items.length === 1 ? "" : "s"} awaiting you`, html);

    res.setHeader("Content-Type", "text/html");
    res.setHeader("X-Digest-Emailed", String(sent));
    return res.status(200).send(html);
  } catch (err: any) {
    console.error("[digest] failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
