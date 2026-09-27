'use strict';

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '256kb' }));

// ---------------------------------------------------------------
//  CONFIG — set these as Environment Variables in Render dashboard
// ---------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID   = process.env.CHAT_ID   || '';
const TG_BASE   = 'https://api.telegram.org/bot' + BOT_TOKEN;

if (!BOT_TOKEN || !CHAT_ID) {
  console.warn('[WARN] BOT_TOKEN or CHAT_ID missing from env. Telegram calls will fail.');
}

// ---------------------------------------------------------------
//  Helpers
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
//  /tg/send — proxy sendMessage to Telegram
//  Body: { text: string, reply_markup?: object }
// ---------------------------------------------------------------
app.post('/tg/send', async (req, res) => {
  try {
    const { text, reply_markup } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ ok: false, error: 'missing text' });
    }

    const payload = {
      chat_id: CHAT_ID,
      text,
      disable_web_page_preview: true
    };
    if (reply_markup) payload.reply_markup = reply_markup;

    const j = await tgPost('sendMessage', payload, 12000);
    res.json(j);
  } catch (e) {
    console.error('[/tg/send]', e && e.message);
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// ---------------------------------------------------------------
//  /tg/updates — long-poll getUpdates
//  Query: offset (optional)
// ---------------------------------------------------------------
app.get('/tg/updates', async (req, res) => {
  try {
    const query = { timeout: 25, allowed_updates: JSON.stringify(['callback_query']) };
    if (req.query.offset) query.offset = String(req.query.offset);
    const j = await tgGet('getUpdates', query, 30000);
    res.json(j);
  } catch (e) {
    console.error('[/tg/updates]', e && e.message);
    res.json({ ok: false, result: [], error: String(e && e.message || e) });
  }
});

// ---------------------------------------------------------------
//  /tg/answer — answerCallbackQuery
//  MUST be fast. Telegram stops the spinner only when this lands.
//  Always returns 200 to the browser, even if Telegram errors.
// ---------------------------------------------------------------
app.post('/tg/answer', async (req, res) => {
  const { callback_query_id, text } = req.body || {};
  if (!callback_query_id) {
    return res.status(400).json({ ok: false, error: 'missing callback_query_id' });
  }

  try {
    const payload = { callback_query_id };
    if (text) payload.text = text;

    const j = await tgPost('answerCallbackQuery', payload, 4000);
    // Return 200 regardless of Telegram's verdict — a stale callback is
    // not the client's problem and must not trigger a retry.
    return res.json({ ok: true, tg: j });
  } catch (e) {
    console.error('[/tg/answer]', e && e.message);
    return res.json({ ok: true, tg: { ok: false, error: String(e && e.message) } });
  }
});

// ---------------------------------------------------------------
//  Health
// ---------------------------------------------------------------
app.get('/healthz', (req, res) => {
  res.json({ ok: true, bot: BOT_TOKEN ? 'set' : 'missing', chat: CHAT_ID ? 'set' : 'missing' });
});

// ---------------------------------------------------------------
//  Static — serves public/index.html at /
// ---------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[EC] server up on :${PORT}`);
  console.log(`[EC] bot token: ${BOT_TOKEN ? 'set' : 'MISSING'}`);
  console.log(`[EC] chat id:   ${CHAT_ID ? 'set' : 'MISSING'}`);
});
