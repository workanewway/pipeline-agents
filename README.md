# Pipeline Agents

Three serverless agents for the autonomous product pipeline, deployed on Vercel.
State lives in the Google Sheet ("Pipeline Queue"); these jobs read and write it.

| Route | What it does | Cron (UTC) |
|---|---|---|
| `/api/research` | Researches all projects, writes new ideas at Stage = **Captured** | 13:00 daily |
| `/api/design-brief` | Top **Captured** ideas (+ sent-back **Designing** rows) → Design Brief + Build Sequence → **In Review** | 13:30 daily |
| `/api/digest` | Renders the review digest from **In Review** rows; returns HTML and emails it (if configured) | 14:00 daily |

Cron times are **UTC** — 13:00 / 13:30 / 14:00 UTC is ~8:00 / 8:30 / 9:00 AM Central in summer. Edit in `vercel.json`.

## Deploy (GitHub web UI → Vercel)

1. Create a new GitHub repo (e.g. `pipeline-agents`) and upload these files — drag the whole folder into GitHub's web uploader so the `api/` and `lib/` structure is preserved.
2. In Vercel: **Add New → Project → Import** that repo. No build command or framework needed — Vercel detects the `api/` functions.
3. Add the environment variables below (Project → Settings → Environment Variables).
4. **Deploy.** Then test by visiting the routes in order (see below).

## Environment variables

**Required**
- `ANTHROPIC_API_KEY` — your Anthropic API key (the pipeline key, not the subscription).
- `GOOGLE_SERVICE_ACCOUNT_KEY` — paste the **entire** service-account JSON, as-is.
- `SHEET_ID` — the long ID from the sheet URL (between `/d/` and `/edit`).

**Recommended**
- `CRON_SECRET` — if set, every route requires `Authorization: Bearer <secret>`. Leave it unset for your first manual tests, then set it before going live. (Vercel sends this header automatically on scheduled cron runs.)

**Optional**
- `SHEET_TAB` — defaults to `Queue`.
- `SHEET_GID` — the tab's gid for digest deep-links; defaults to `0` (first tab).
- `SOURCE_STAGE` — what the digest reads; defaults to `In Review`. **Set to `Captured` to test the digest before the design step has run anything.**
- `RESEND_API_KEY`, `DIGEST_FROM`, `DIGEST_TO` — to email the digest. Without these, the digest still renders and is returned in the response; it just doesn't send.

## First run (manual, in order)

With `CRON_SECRET` unset you can just open the URLs in a browser:

1. `…/api/research` → returns `{ created, perProject }`. Check the sheet: new **Captured** rows.
2. `…/api/design-brief` → returns `{ designed, count }`. The top ideas flip to **In Review** with a Design Brief + Build Sequence filled in.
3. `…/api/digest` → renders the digest **right in the browser**. Set `SOURCE_STAGE=Captured` first if you ran only step 1.

Once you've set `CRON_SECRET`, trigger manually with:
`curl -H "Authorization: Bearer <secret>" https://<your-app>.vercel.app/api/research`

## Notes
- `research` is the only duration-sensitive route (web-search heavy); it's given `maxDuration: 300` in `vercel.json`. If it ever times out, lower `MAX_WEB_SEARCHES` in `api/research.ts` or process one project per run.
- Minute-precise cron and the 300s function budget require Vercel **Pro** (you're on it — your repo is under a GitHub org, which Hobby can't deploy).
- Never commit the service-account JSON — it goes in env vars only.
