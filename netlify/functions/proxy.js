'use strict';
const https = require('https');

const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const PROXY_SECRET   = process.env.MELLO_PROXY_SECRET;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MODEL          = 'claude-sonnet-4-20250514';
const MAX_TOKENS     = 4000;
const TIMEOUT_MS     = 20_000; // fail fast so Netlify can return a clean error
const MAX_BODY_BYTES = 300_000;
const MAX_DAYS       = 14;

const _hits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const slot = _hits.get(ip);
  if (!slot || now - slot.t > 60_000) { _hits.set(ip, { t: now, n: 1 }); return false; }
  slot.n++;
  return slot.n > 20;
}

const SECTIONS = [
  'AM Shift Report', 'PM Shift Report', 'AM Concierge', 'PM Concierge',
  'Member Feedback', 'Lost Items', 'Mello House Maintenance', 'Mello House Housekeeping',
  'Flowers / Plants Condition', 'Morning Briefing Como', 'RSA / Incidents',
];
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function buildPrompt(days) {
  const blocks = days.map(d => {
    const dayName = d.date ? (DAY_NAMES[new Date(d.date).getDay()] || '?') : '?';
    let block = `=== ${dayName} ${d.date || d.file} ===\n`;
    SECTIONS.forEach(s => {
      block += `\n[${s}]\n${(d.data[s] || 'NTR').replace(/£/g, '$')}\n`;
    });
    return block;
  }).join('\n\n');

  return `You are summarising a week of End-of-Day (EOD) reports from Mello House, a private members' club in Australia. Always use $ for currency, never £.\n\nHere is the raw data extracted from each day's EOD report:\n\n${blocks}\n\nWrite a concise weekly summary — one short paragraph (3–5 sentences max) per category. Do NOT use bullet points — prose only. Synthesise all days into one narrative per category. Mention key names, numbers and notable events but keep it tight. Always use $ (not £) for any currency. Use professional hospitality tone. Return JSON only in this exact shape:\n\n{\n  "weekRange": "e.g. 2–7 February 2026",\n  "sections": [\n    { "title": "AM Shift Report", "body": "..." },\n    { "title": "PM Shift Report", "body": "..." },\n    { "title": "AM Concierge", "body": "..." },\n    { "title": "PM Concierge", "body": "..." },\n    { "title": "Member Feedback", "body": "..." },\n    { "title": "Lost Items", "body": "..." },\n    { "title": "Mello House Maintenance", "body": "..." },\n    { "title": "Mello House Housekeeping", "body": "..." },\n    { "title": "Flowers / Plants Condition", "body": "..." },\n    { "title": "Morning Briefing Como", "body": "..." },\n    { "title": "RSA / Incidents", "body": "..." }\n  ]\n}\n\nReturn ONLY the JSON, no markdown, no backticks.`;
}

function callAnthropic(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, text: data }));
      }
    );
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('Upstream timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Netlify handler signature ──────────────────────────────────────────────────
exports.handler = async (event, context) => {
  const origin = event.headers['origin'] || event.headers['Origin'] || '';
  const corsOrigin = ALLOWED_ORIGIN === '*' ? '*' : ALLOWED_ORIGIN;

  const corsHeaders = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Mello-Secret',
    'Vary': 'Origin',
  };

  // OPTIONS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'POST only' }) };
  }

  // Rate limiting
  const ip = event.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) {
    return { statusCode: 429, headers: corsHeaders, body: JSON.stringify({ error: 'Too many requests' }) };
  }

  // Optional secret check
  const clientSecret = event.headers['x-mello-secret'] || event.headers['X-Mello-Secret'];
  if (PROXY_SECRET && clientSecret !== PROXY_SECRET) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };
  }

  // Body size check
  const bodyStr = event.body || '';
  if (Buffer.byteLength(bodyStr) > MAX_BODY_BYTES) {
    return { statusCode: 413, headers: corsHeaders, body: JSON.stringify({ error: 'Request too large' }) };
  }

  let input;
  try {
    input = JSON.parse(bodyStr);
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!input || !Array.isArray(input.days) || input.days.length === 0) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: '"days" array is required' }) };
  }
  if (input.days.length > MAX_DAYS) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: `Too many days — max ${MAX_DAYS}` }) };
  }
  for (const d of input.days) {
    if (!d || typeof d.data !== 'object' || d.data === null) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Each day must have a data object' }) };
    }
  }

  try {
    const prompt = buildPrompt(input.days);
    const { status, text } = await callAnthropic(prompt);

    let anthropicJson;
    try { anthropicJson = JSON.parse(text); }
    catch { return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'Malformed Anthropic response' }) }; }

    if (status !== 200) {
      return {
        statusCode: status,
        headers: corsHeaders,
        body: JSON.stringify({ error: anthropicJson?.error?.message || 'Anthropic API error' }),
      };
    }

    const rawText = (anthropicJson.content || [])
      .map(c => c.text || '').join('')
      .replace(/```json|```/g, '').trim();

    let summary;
    try {
      summary = JSON.parse(rawText);
    } catch {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (!match) return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'Could not parse summary' }) };
      try { summary = JSON.parse(match[0]); }
      catch { return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'Summary JSON malformed' }) }; }
    }

    if (!summary.sections || !Array.isArray(summary.sections)) {
      return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'Missing sections in response' }) };
    }

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(summary) };

  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
