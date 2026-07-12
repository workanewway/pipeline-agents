// api/promote.ts  ->  POST /api/promote?id=IDEA-0042
//
// The production step: merges staging -> main on the build-target repo (Vercel's
// main-branch integration deploys production), then marks the idea Live on the
// queue. Gated by BOARD_KEY — promotion is a human decision made on the board,
// never an automatic transition. Stage contract: only valid from "Ready to
// Promote" (the human verified the staging preview and advanced the hold).
//
// Response: { ok, merged, prodUrl?, warning? }
//   merged=false + ok=true -> main already contained staging (nothing to merge).
//   warning -> non-fatal post-merge issue the board surfaces in the toast.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSheets, readQueue, updateCells, projectByName, ghRepoSlug } from "../lib/pipeline-common.js";

export const maxDuration = 60;

const sheets = getSheets();
const stamp = () => new Date().toISOString();
const appendLog = (existing: string, line: string) => {
  const entry = `[${stamp()}] ${line}`;
  return existing ? `${existing}\n${entry}` : entry;
};

const PROD_URL = process.env.PROD_URL || "https://broker.workanewway.com";

// Back-sync main -> staging after a successful promote, so the staging branch starts
// the next build from shipped reality (every promote otherwise leaves staging N commits
// behind, requiring a manual sync PR). Near-guaranteed conflict-free — staging just
// became an ancestor of main. FAIL-SOFT: never throws, never fails the promote
// (production shipped — the primary op); a failure returns a note carrying the manual
// remedy, surfaced as a response `warning` and a Review Log line.
async function backSyncStaging(token: string, slug: string, ideaId: string): Promise<{ ok: boolean; note: string }> {
  try {
    const r = await fetch(`https://api.github.com/repos/${slug}/merges`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "pipeline-promote",
      },
      body: JSON.stringify({
        base: "staging",
        head: "main",
        commit_message: `Back-sync main into staging after promoting ${ideaId}`,
      }),
    });
    if (r.status === 201) return { ok: true, note: "Staging back-synced with main." };
    if (r.status === 204) return { ok: true, note: "Staging already up to date with main." };
    if (r.status === 409) return { ok: false, note: "Staging back-sync CONFLICT — merge main into staging manually before the next build." };
    const detail = (await r.text()).slice(0, 140);
    return { ok: false, note: `Staging back-sync failed (HTTP ${r.status}: ${detail}) — merge main into staging manually.` };
  } catch (err: any) {
    return { ok: false, note: `Staging back-sync failed (${String(err?.message || err)}) — merge main into staging manually.` };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  // Promotion deploys PRODUCTION — always gated, fails closed.
  const gate = process.env.BOARD_KEY;
  if (!gate) return res.status(403).json({ ok: false, error: "Promote is locked. Set BOARD_KEY in Vercel to enable it." });
  if (req.query.key !== gate) return res.status(401).json({ ok: false, error: "Unauthorized." });

  const id = String(req.query.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "missing id" });

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: "GITHUB_DISPATCH_TOKEN not set — cannot merge" });

  try {
    const { rows } = await readQueue(sheets);
    const row = rows.find((r) => r.get("Idea ID").trim() === id);
    if (!row) return res.status(404).json({ ok: false, error: `idea ${id} not found` });

    const stage = row.get("Stage").trim();
    if (stage !== "Ready to Promote") {
      return res.status(400).json({ ok: false, error: `Promote is only valid from "Ready to Promote" (idea is at "${stage}")` });
    }

    // ── The release set ──────────────────────────────────────────────────
    // Promote is a BRANCH action: the staging -> main merge ships everything on
    // staging, so every card at Ready to Promote ships together — one merge, one
    // release. The clicked card is just the anchor; ALL release members are
    // marked Live with a shared release line so the record tells the truth
    // (previously each remaining card needed its own no-op promote click).
    const release = rows.filter((r) => r.get("Stage").trim() === "Ready to Promote");
    const releaseIds = release.map((r) => r.get("Idea ID").trim());

    const project = projectByName(row.get("Product"));
    if (!project || !/github\.com\//.test(project.repo)) {
      return res.status(400).json({ ok: false, error: `no promotable GitHub repo for product "${row.get("Product")}"` });
    }
    const slug = ghRepoSlug(project.repo);

    const mergeRes = await fetch(`https://api.github.com/repos/${slug}/merges`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "pipeline-promote",
      },
      body: JSON.stringify({
        base: "main",
        head: "staging",
        commit_message: (releaseIds.length > 1
          ? `Promote release (${releaseIds.length}): ${releaseIds.join(", ")}`
          : `Promote ${id}: ${row.get("Title")}`).slice(0, 100),
      }),
    });

    if (mergeRes.status !== 201 && mergeRes.status !== 204) {
      if (mergeRes.status === 409) {
        return res.status(409).json({ ok: false, error: "Merge conflict between staging and main — resolve on GitHub, then promote again." });
      }
      const detail = (await mergeRes.text()).slice(0, 200);
      return res.status(502).json({ ok: false, error: `GitHub merge failed (HTTP ${mergeRes.status}): ${detail}` });
    }
    const merged = mergeRes.status === 201; // 204 = main already contained staging

    // Automatic back-sync (fail-soft; see backSyncStaging above).
    const sync = await backSyncStaging(token, slug, releaseIds.join(", ") || id);

    const releaseNote = merged
      ? (releaseIds.length > 1
          ? `Promoted to production in a release of ${releaseIds.length} (${releaseIds.join(", ")}).`
          : `Promoted to production (staging -> main merged).`)
      : `Promote: main already up to date with staging.`;

    for (const r of release) {
      await updateCells(sheets, r.rowNum, {
        Stage: "Live",
        "Prod URL": PROD_URL,
        "Build Status": merged ? "promoted to production" : "promoted (main already current)",
        "Pending Migration": "",
        "Review Log": appendLog(r.get("Review Log"), releaseNote + " " + sync.note),
        "Updated At": stamp(),
        "Decided At": stamp(),
      });
    }

    return res.status(200).json({ ok: true, merged, prodUrl: PROD_URL, released: releaseIds, ...(sync.ok ? {} : { warning: sync.note }) });
  } catch (err: any) {
    console.error("[promote] failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
