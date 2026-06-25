import type { VercelRequest, VercelResponse } from '@vercel/node';

// "Submit": runs the watcher on demand, server-side.
// Gated by BOARD_KEY (fail-closed) so the board's button is protected even though
// /api/watcher itself may be open. Forwards CRON_SECRET to the watcher if it's set,
// so the secret never has to live in the browser.
//
// NOTE: we target the STABLE production alias, not process.env.VERCEL_URL.
// VERCEL_URL is the per-deployment hostname, which sits behind Vercel's deployment
// protection — a server-side fetch to it returns Vercel's auth/404 HTML page, not the
// watcher's JSON. The prod alias below is the same URL the PowerShell invoke uses.
export const maxDuration = 120;

const DEFAULT_WATCHER_URL = 'https://pipeline-agents-opal.vercel.app/api/watcher';

function snippet(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const gate = process.env.BOARD_KEY;
  if (!gate) {
    res.status(403).json({ ok: false, error: 'Submit is locked. Set BOARD_KEY in Vercel to enable it.' });
    return;
  }
  if (req.query.key !== gate) {
    res.status(401).json({ ok: false, error: 'Unauthorized.' });
    return;
  }

  const watcherUrl = process.env.WATCHER_URL || DEFAULT_WATCHER_URL;

  try {
    const headers: Record<string, string> = {};
    if (process.env.CRON_SECRET) headers['Authorization'] = `Bearer ${process.env.CRON_SECRET}`;
    // If the watcher sits behind Vercel platform protection, a bypass secret lets the
    // server-side call through. Harmless when the target is already open.
    const bypass = process.env.WATCHER_BYPASS_SECRET || process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass) headers['x-vercel-protection-bypass'] = bypass;

    const r = await fetch(watcherUrl, { method: 'GET', headers });
    const text = await r.text();
    const ctype = r.headers.get('content-type') || '';

    // Only treat it as JSON if it really is.
    let body: any = text;
    let isJson = false;
    if (ctype.includes('application/json') || /^\s*[{[]/.test(text)) {
      try { body = JSON.parse(text); isJson = true; } catch { /* keep raw text */ }
    }

    if (!r.ok) {
      res.status(502).json({
        ok: false,
        error: `Watcher returned HTTP ${r.status}.`,
        detail: isJson ? body : snippet(text),
      });
      return;
    }

    if (!isJson) {
      // Reached a non-JSON page — almost always Vercel auth/404, or a wrong URL.
      res.status(502).json({
        ok: false,
        error:
          'The watcher URL returned a non-JSON page (likely a Vercel auth or 404 page, not the watcher). ' +
          'If the watcher needs auth, set CRON_SECRET in Vercel; if the URL is wrong, set WATCHER_URL.',
        target: watcherUrl,
        detail: snippet(text),
      });
      return;
    }

    res.status(200).json({ ok: true, watcher: body });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Failed to reach the watcher.' });
  }
}
