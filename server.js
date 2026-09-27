'use strict';

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.text({ type: '*/*', limit: '16kb' }));

// ---------------------------------------------------------------
//  CONFIG
// ---------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID   = process.env.CHAT_ID   || '';
const TG_BASE   = 'https://api.telegram.org/bot' + BOT_TOKEN;

if (!BOT_TOKEN || !CHAT_ID) {
  console.warn('[WARN] BOT_TOKEN or CHAT_ID missing from env.');
}

// ---------------------------------------------------------------
//  Telegram helpers
// ---------------------------------------------------------------
async function tgPost(method, payload, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs || 12000);
  try {
    const res = await fetch(`${TG_BASE}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function tgGet(method, query, timeoutMs) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs || 30000);
  try {
    const res = await fetch(`${TG_BASE}/${method}${qs}`, { signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------
//  /tg/send — sendMessage
// ---------------------------------------------------------------
app.post('/tg/send', async (req, res) => {
  try {
    const { text, reply_markup } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ ok: false, error: 'missing text' });
    }
    const payload = { chat_id: CHAT_ID, text, disable_web_page_preview: true };
    if (reply_markup) payload.reply_markup = reply_markup;
    const j = await tgPost('sendMessage', payload, 12000);
    res.json(j);
  } catch (e) {
    console.error('[/tg/send]', e && e.message);
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// ---------------------------------------------------------------
//  /tg/updates — single long-poll call. Client must call
//  sequentially, NOT with setInterval. Long-poll blocks up to 25s.
// ---------------------------------------------------------------
app.get('/tg/updates', async (req, res) => {
  try {
    const query = {
      timeout: 20,
      allowed_updates: JSON.stringify(['callback_query'])
    };
    if (req.query.offset) query.offset = String(req.query.offset);
    const j = await tgGet('getUpdates', query, 25000);
    res.json(j);
  } catch (e) {
    console.error('[/tg/updates]', e && e.message);
    res.json({ ok: false, result: [], error: String(e && e.message || e) });
  }
});

// ---------------------------------------------------------------
//  /tg/answer — answerCallbackQuery. Fast. Always 200.
// ---------------------------------------------------------------
app.post('/tg/answer', async (req, res) => {
  const { callback_query_id } = req.body || {};
  if (!callback_query_id) return res.status(400).json({ ok: false, error: 'missing id' });
  try {
    const j = await tgPost('answerCallbackQuery', { callback_query_id }, 4000);
    return res.json({ ok: true, tg: j });
  } catch (e) {
    console.error('[/tg/answer]', e && e.message);
    return res.json({ ok: true, tg: { ok: false, error: String(e && e.message) } });
  }
});

// ---------------------------------------------------------------
//  /tg/beacon — sendBeacon fallback (text/plain body)
// ---------------------------------------------------------------
app.post('/tg/beacon', async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    const cbId = body && body.callback_query_id;
    if (cbId) {
      tgPost('answerCallbackQuery', { callback_query_id: cbId }, 4000).catch(() => {});
    }
    res.status(200).end();
  } catch (e) {
    res.status(200).end();
  }
});

// ---------------------------------------------------------------
//  /healthz — keep-alive target
// ---------------------------------------------------------------
app.get('/healthz', (req, res) => {
  res.json({ ok: true, bot: BOT_TOKEN ? 'set' : 'missing', chat: CHAT_ID ? 'set' : 'missing', t: Date.now() });
});

// ---------------------------------------------------------------
//  Static
// ---------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------------------------------------------------------------
//  Boot — clear webhook so getUpdates works
// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[EC] server up on :${PORT}`);
  console.log(`[EC] bot token: ${BOT_TOKEN ? 'set' : 'MISSING'}`);
  console.log(`[EC] chat id:   ${CHAT_ID ? 'set' : 'MISSING'}`);
  if (BOT_TOKEN) {
    try {
      const j = await tgPost('deleteWebhook', { drop_pending_updates: false }, 6000);
      console.log('[EC] deleteWebhook:', JSON.stringify(j));
    } catch (e) {
      console.warn('[EC] deleteWebhook failed:', e && e.message);
    }
  }
});

// Self keep-alive so Render free tier doesn't sleep
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL + '/healthz').catch(() => {});
  }, 4 * 60 * 1000);
}
