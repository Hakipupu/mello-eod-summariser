'use strict';
const https = require('https');

const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const PROXY_SECRET   = process.env.MELLO_PROXY_SECRET;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MODEL          = 'claude-sonnet-4-20250514';
const MAX_TOKENS     = 4000;
const TIMEOUT_MS     = 55_000;
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

  return `You are summarising a week of End-of-Day (EOD) reports from Mello House, a private members' club in Australia. Always use $ for currency, never £.\n\nHere is the raw data extracted from each day's EOD report:\n\n${blocks}\n\nWrite a concise weekly summary — one short paragraph (3–5 sentences max) per category. Do NOT use bullet points — prose only. Synthesise all days into one narrative per category. Mention key names, numbers and notable events but keep it tight. Always use $ (not £) for any currency. Use professional hospitality tone. Return JSON only in this exact shape:\n\n{\n  "weekRange": "e.g. 2-7 February 2026",\n  "sections": [\n    { "title": "AM Shift Report", "body": "..." },\n    { "title": "PM Shift Report", "body": "..." },\n    { "title": "AM Concierge", "body": "..." },\n    { "title": "PM Concierge", "body": "..." },\n    { "title": "Member Feedback", "body": "..." },\n    { "title": "Lost Items", "body": "..." },\n    { "title": "Mello House Maintenance", "body": "..." },\n    { "title": "Mello House Housekeeping", "body": "..." },\n    { "title": "Flowers / Plants Condition", "body": "..." },\n    { "title": "Morning Briefing Como", "body": "..." },\n    { "title": "RSA / Incidents", "body": "..." }\n  ]\n}\n\nReturn ONLY the JSON, no markdown, no backticks.`;
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '', bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) { req.destroy(); reject(Object.assign(new Error('Request too large'), { status: 413 })); return; }
      buf += chunk.toString();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(buf)); }
      catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Mello-Secret');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'POST only' }); return; }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (isRateLimited(ip)) { res.status(429).json({ error: 'Too many requests' }); return; }

  if (PROXY_SECRET && req.headers['x-mello-secret'] !== PROXY_SECRET) {
    res.status(401).json({ error: 'Unauthorised' }); return;
  }

  if (!ANTHROPIC_KEY) { res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' }); return; }

  let input;
  try { input = await readBody(req); }
  catch (err) { res.status(err.status || 400).json({ error: err.message }); return; }

  if (!input || !Array.isArray(input.days) || input.days.length === 0) {
    res.status(400).json({ error: '"days" array is required' }); return;
  }
  if (input.days.length > MAX_DAYS) {
    res.status(400).json({ error: `Too many days — max ${MAX_DAYS}` }); return;
  }
  for (const d of input.days) {
    if (!d || typeof d.data !== 'object' || d.data === null) {
      res.status(400).json({ error: 'Each day must have a data object' }); return;
    }
  }

  try {
    const prompt = buildPrompt(input.days);
    const { status, text } = await callAnthropic(prompt);

    let anthropicJson;
    try { anthropicJson = JSON.parse(text); }
    catch { res.status(502).json({ error: 'Malformed Anthropic response' }); return; }

    if (status !== 200) {
      res.status(status).json({ error: anthropicJson?.error?.message || 'Anthropic API error' }); return;
    }

    const rawText = (anthropicJson.content || [])
      .map(c => c.text || '').join('')
      .replace(/```json|```/g, '').trim();

    let summary;
    try { summary = JSON.parse(rawText); }
    catch {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (!match) { res.status(502).json({ error: 'Could not parse summary' }); return; }
      try { summary = JSON.parse(match[0]); }
      catch { res.status(502).json({ error: 'Summary JSON malformed' }); return; }
    }

    if (!summary.sections || !Array.isArray(summary.sections)) {
      res.status(502).json({ error: 'Missing sections in response' }); return;
    }

    res.status(200).json(summary);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports.config = { maxDuration: 60 };
