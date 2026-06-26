import type { VercelRequest, VercelResponse } from '@vercel/node';

// "Run design" / "Send to Design": runs design-brief on demand, server-side.
// Gated by BOARD_KEY (fail-closed). Optional ?id=IDEA-XXXX designs that specific idea;
// no id = design-brief's normal highest-priority Captured pick. Forwards CRON_SECRET to
// design-brief if set, and a Vercel bypass secret if the target is protected.
export const maxDuration = 300; // design-brief itself can run up to 300s

const DEFAULT_URL = 'https://pipeline-agents-opal.vercel.app/api/design-brief';

function snippet(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const gate = process.env.BOARD_KEY;
  if (!gate) { res.status(403).json({ ok: false, error: 'Design is locked. Set BOARD_KEY in Vercel to enable it.' }); return; }
  if (req.query.key !== gate) { res.status(401).json({ ok: false, error: 'Unauthorized.' }); return; }

  const id = (req.query.id || '').toString().trim();
  const base = process.env.DESIGN_BRIEF_URL || DEFAULT_URL;
  const url = id ? `${base}?id=${encodeURIComponent(id)}` : base;

  try {
    const headers: Record<string, string> = {};
    if (process.env.CRON_SECRET) headers['Authorization'] = `Bearer ${process.env.CRON_SECRET}`;
    const bypass = process.env.WATCHER_BYPASS_SECRET || process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass) headers['x-vercel-protection-bypass'] = bypass;

    const r = await fetch(url, { method: 'GET', headers });
    const text = await r.text();
    const ctype = r.headers.get('content-type') || '';

    let body: any = text;
    let isJson = false;
    if (ctype.includes('application/json') || /^\s*[{[]/.test(text)) {
      try { body = JSON.parse(text); isJson = true; } catch { /* keep raw */ }
    }

    if (!r.ok) {
      res.status(502).json({ ok: false, error: `design-brief returned HTTP ${r.status}.`, detail: isJson ? body : snippet(text) });
      return;
    }
    if (!isJson) {
      res.status(502).json({
        ok: false,
        error: 'design-brief returned a non-JSON page (likely a Vercel auth or 404 page). Set CRON_SECRET, or DESIGN_BRIEF_URL if the URL is wrong.',
        target: url,
        detail: snippet(text),
      });
      return;
    }

    res.status(200).json({ ok: true, result: body });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Failed to reach design-brief.' });
  }
}
