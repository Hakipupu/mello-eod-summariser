# Mello House — Weekly EOD Summariser

Drag-and-drop weekly report summariser for Mello House. Upload 5–7 daily EOD `.xlsx` files and receive a formatted prose narrative across all eleven operational categories.

---

## For staff — how to use

1. Open the app: **https://hakipupu.github.io/mello-eod-summariser/**
2. Drag your weekly EOD `.xlsx` files onto the drop zone (or click to browse).
3. Click **Generate Summary**.
4. Use **Print / PDF** or **Copy as text** to export.

No login, no API keys, no passwords. The app does everything.

---

## Architecture

```
┌──────────────────────────────┐      ┌─────────────────────────────────────┐
│  docs/index.html             │      │  netlify/functions/proxy.js          │
│  (GitHub Pages)              │      │  (Netlify serverless function)       │
│                              │      │                                      │
│  1. Parse XLSX client-side   │ POST │  2. Validate input                   │
│  2. Send { days } payload  ──┼─────▶│  3. Build prompt server-side         │
│  3. Render summary           │◀─────┼─  4. Call Anthropic API              │
│                              │ JSON │  5. Return clean summary JSON        │
└──────────────────────────────┘      └─────────────────────────────────────┘
```

Raw spreadsheet data is parsed in the browser — files never leave the device. Extracted text is sent to the Netlify function, which calls the Anthropic API on the server using a key stored securely as a Netlify environment variable.

> **Privacy note:** EOD content (including member feedback, staff notes, and incident records) is processed by the Anthropic API. Anthropic does not use API request data for model training by default. This should be a deliberate, documented decision at the venue level before deploying.

---

## Admin setup

### 1 — GitHub Pages (frontend)

The frontend is already live. It is served automatically from the `docs/` folder on the `main` branch via GitHub Pages. Any commit to `docs/index.html` goes live within ~60 seconds.

### 2 — Netlify (API function)

The API runs as a Netlify serverless function. It is deployed automatically from the `netlify/functions/` folder whenever you push to `main`.

Go to **app.netlify.com → your project → Project configuration → Environment variables** and ensure these are set:

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ Yes | Your Anthropic API key (`sk-ant-...`) |
| `ALLOWED_ORIGIN` | Recommended | `https://hakipupu.github.io` |
| `MELLO_PROXY_SECRET` | Optional | Random secret for request authentication |

After adding or changing variables, go to **Deploys → Trigger deploy** to apply them.

### 3 — Set the proxy secret (optional)

Generate a secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

1. Add the output as `MELLO_PROXY_SECRET` in Netlify environment variables.
2. Set the same value as `PROXY_SECRET` in `docs/index.html`.

---

## Security model

The following protections are in place in `netlify/functions/proxy.js`:

| Layer | Detail |
|---|---|
| **No arbitrary relay** | The client sends raw day data only. Model, `max_tokens`, and the full prompt are constructed server-side. |
| **Input validation** | `days` array shape is validated; maximum 14 days enforced; body size capped at 300 KB. |
| **Rate limiting** | 20 requests per minute per IP (in-memory; resets on cold start). |
| **Upstream timeout** | Anthropic call times out at 25 s (Netlify free tier limit). |
| **CORS** | Locked to `ALLOWED_ORIGIN` env var (defaults to `*` if unset). |
| **Optional secret** | When `MELLO_PROXY_SECRET` is set, requests without the matching `X-Mello-Secret` header are rejected with 401. |

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
npm install -g netlify-cli
cp .env.example .env
# fill in ANTHROPIC_API_KEY in .env
netlify dev
# opens at http://localhost:8888
```

---

*Controlled internal tool · Mello House Operations*
