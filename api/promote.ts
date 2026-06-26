import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSheets, readQueue, updateCells } from '../lib/pipeline-common.js';

// "Promote": merges staging -> main (deploys to production), then marks the idea Live.
// Gated by BOARD_KEY (fail-closed) — this is the most consequential action in the system.
// Uses the same GITHUB_DISPATCH_TOKEN (Contents: read/write) that fires builds.
// It ships CODE only; it does NOT run DB migrations — those stay a deliberate manual step.
export const maxDuration = 60;

const sheets = getSheets();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const gate = process.env.BOARD_KEY;
  if (!gate) { res.status(403).json({ ok: false, error: 'Promote is locked. Set BOARD_KEY in Vercel to enable it.' }); return; }
  if (req.query.key !== gate) { res.status(401).json({ ok: false, error: 'Unauthorized.' }); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Use POST.' }); return; }

  const id = (req.query.id || '').toString().trim();

  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.BUILD_REPO || 'workanewway/vetting-platform-api';
  const base = process.env.PROMOTE_BASE || 'main';
  const head = process.env.PROMOTE_HEAD || 'staging';
  const prodUrl = process.env.PROD_URL || 'https://vetting-platform-api.vercel.app';
  if (!token) { res.status(500).json({ ok: false, error: 'GITHUB_DISPATCH_TOKEN not set — cannot merge.' }); return; }

  try {
    // Merge head (staging) into base (main). 201 = merged, 204 = already up to date.
    const ghRes = await fetch(`https://api.github.com/repos/${repo}/merges`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'pipeline-promote',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ base, head, commit_message: `promote: ${head} -> ${base}${id ? ` (${id})` : ''}` }),
    });

    const text = await ghRes.text();
    let gh: any = text;
    try { gh = JSON.parse(text); } catch { /* keep raw */ }

    if (ghRes.status === 409) {
      res.status(409).json({ ok: false, error: 'Merge conflict between staging and main — resolve it on GitHub, then promote.', detail: (gh && gh.message) || '' });
      return;
    }
    if (!ghRes.ok && ghRes.status !== 204) {
      res.status(502).json({ ok: false, error: `GitHub merge failed (HTTP ${ghRes.status}).`, detail: (gh && gh.message) || String(text).slice(0, 240) });
      return;
    }

    const merged = ghRes.status === 201;
    const sha = (gh && gh.sha) ? String(gh.sha) : '';

    // Mark the idea Live (best-effort — don't fail the promote if the row update hiccups).
    if (id) {
      try {
        const { rows } = await readQueue(sheets);
        const row = rows.find((r) => r.get('Idea ID') === id);
        if (row) {
          await updateCells(sheets, row.rowNum, {
            Stage: 'Live',
            'Prod URL': prodUrl,
            'Review Log': appendLog(row.get('Review Log'), `Promoted ${head} -> ${base}${sha ? ` @ ${sha.slice(0, 7)}` : ''} (production deploy)`),
            'Updated At': new Date().toISOString(),
          });
        }
      } catch (e: any) {
        // Merge already happened; surface the row issue but report success.
        res.status(200).json({ ok: true, merged, sha, prodUrl, warning: `Merged, but couldn't mark ${id} Live: ${e?.message || e}` });
        return;
      }
    }

    res.status(200).json({ ok: true, merged, sha, prodUrl, message: merged ? 'Merged staging into main — production deploying.' : 'main was already up to date with staging.' });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Failed to reach GitHub.' });
  }
}

const stamp = () => new Date().toISOString();
function appendLog(existing: string, line: string): string {
  const entry = `[${stamp()}] ${line}`;
  return existing ? `${existing}\n${entry}` : entry;
}
