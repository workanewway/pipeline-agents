import type { VercelRequest, VercelResponse } from '@vercel/node';

// "Submit": runs the watcher on demand, server-side.
// Gated by BOARD_KEY (fail-closed) so the board's button is protected even though
// /api/watcher itself may be open. Forwards CRON_SECRET to the watcher if it's set,
// so the secret never has to live in the browser.
export const maxDuration = 120;

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

  const watcherUrl =
    process.env.WATCHER_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}/api/watcher` : '') ||
    'https://pipeline-agents-opal.vercel.app/api/watcher';

  try {
    const headers: Record<string, string> = {};
    if (process.env.CRON_SECRET) headers['Authorization'] = `Bearer ${process.env.CRON_SECRET}`;

    const r = await fetch(watcherUrl, { method: 'GET', headers });
    const text = await r.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = text; }

    if (!r.ok) {
      res.status(502).json({ ok: false, error: `Watcher returned ${r.status}.`, watcher: body });
      return;
    }
    res.status(200).json({ ok: true, watcher: body });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Failed to reach the watcher.' });
  }
}
