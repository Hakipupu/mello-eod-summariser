# Mello House — Weekly EOD Summariser

Drag-and-drop weekly report summariser for Mello House. Upload 5–7 daily EOD `.xlsx` files and receive a formatted prose narrative across all eleven operational categories.

---

## For staff — how to use

1. Open the app in your browser.
2. Drag your weekly EOD `.xlsx` files onto the drop zone (or click to browse).
3. Click **Generate Summary**.
4. Use **Print / PDF** or **Copy as text** to export.

No login, no API keys, no passwords. The app does everything.

---

## Architecture

```
┌─────────────────────────────┐      ┌────────────────────────────────┐
│  docs/index.html            │      │  api/proxy.js                  │
│  (Vercel static)            │      │  (Vercel serverless function)  │
│                             │      │                                │
│  1. Parse XLSX client-side  │ POST │  2. Validate input             │
│  2. Send { days } payload ──┼─────▶│  3. Build prompt server-side   │
│  3. Render summary          │◀─────┼─  4. Call Anthropic API        │
│                             │ JSON │  5. Return clean summary JSON  │
└─────────────────────────────┘      └────────────────────────────────┘
```

Raw spreadsheet data is parsed in the browser — files never leave the device. Extracted text is sent to the proxy, which calls the Anthropic API on the server using a key stored securely as a Vercel environment variable.

> **Privacy note:** EOD content (including member feedback, staff notes, and incident records) is processed by the Anthropic API. Anthropic does not use API request data for model training by default. This should be a deliberate, documented decision at the venue level before deploying.

---

## Admin setup (first deployment)

### 1 — Deploy to Vercel

```bash
npm install -g vercel
vercel deploy --prod
```

Vercel serves `docs/` as static files and `api/proxy.js` as a serverless function automatically.

### 2 — Set environment variables in Vercel

Go to **Vercel Dashboard → Your Project → Settings → Environment Variables** and add:

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ Yes | Your Anthropic API key (`sk-ant-...`) |
| `MELLO_PROXY_SECRET` | Recommended | A random secret to authenticate requests (see below) |
| `ALLOWED_ORIGIN` | Recommended | Your Vercel deployment URL, e.g. `https://mello-eod-summariser.vercel.app` |

Redeploy after setting variables.

### 3 — Set the proxy secret (recommended)

Generate a secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

1. Add the output as `MELLO_PROXY_SECRET` in Vercel.
2. Set the same value as `PROXY_SECRET` in `docs/index.html` (the `const PROXY_SECRET = ''` line).

> **Important:** Because this repo is public, do **not** commit a real secret value into `docs/index.html`. Set `PROXY_SECRET` locally, deploy via the Vercel CLI, then revert the source file before pushing to GitHub. For a fully clean setup, move the frontend to a private repo or enable [Vercel Deployment Protection](https://vercel.com/docs/security/deployment-protection).

---

## Security model

The following protections are in place in `api/proxy.js`:

| Layer | Detail |
|---|---|
| **No arbitrary relay** | The client sends raw day data only. Model, `max_tokens`, and the full prompt are constructed server-side. |
| **Input validation** | `days` array shape is validated; maximum 14 days enforced; body size capped at 300 KB. |
| **Rate limiting** | 20 requests per minute per IP (in-memory; resets on cold start). |
| **Upstream timeout** | Anthropic call times out at 55 s to prevent hung Vercel functions. |
| **CORS** | Locked to `ALLOWED_ORIGIN` env var (defaults to `*` if unset). |
| **Optional secret** | When `MELLO_PROXY_SECRET` is set, requests without the matching `X-Mello-Secret` header are rejected with 401. |

CORS alone does not protect against non-browser callers (e.g. `curl`). The shared secret adds a meaningful barrier even for direct API calls. For the strongest protection, enable Vercel Deployment Protection.

---

## Spreadsheet requirements

- File must contain a sheet named `EOD` (case-insensitive).
- A cell containing the word "date" must appear with the date value in the adjacent cell.
- Section headings must match (case-insensitive):
  - AM Shift Report, PM Shift Report, AM Concierge, PM Concierge
  - Member Feedback, Lost Items, Mello House Maintenance, Mello House Housekeeping
  - Flowers / Plants Condition, Morning Briefing Como, RSA / Incidents
- Up to 30 rows of content per section are extracted.

---

## Local development

```bash
npm install -g vercel
cp .env.example .env
# fill in ANTHROPIC_API_KEY in .env
vercel dev
# opens at http://localhost:3000
```

---

*Controlled internal tool · Mello House Operations*
