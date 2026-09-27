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
async function tgPost(method, payload) {
  const res = await fetch(`${TG_BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.json();
}

async function tgGet(method, query) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const res = await fetch(`${TG_BASE}/${method}${qs}`);
  return res.json();
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

    const j = await tgPost('sendMessage', payload);
    res.json(j);
  } catch (e) {
    console.error('[/tg/send]', e);
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
    const j = await tgGet('getUpdates', query);
    res.json(j);
  } catch (e) {
    console.error('[/tg/updates]', e);
    res.status(500).json({ ok: false, result: [], error: String(e && e.message || e) });
  }
});

// ---------------------------------------------------------------
//  /tg/answer — answerCallbackQuery
//  Body: { callback_query_id: string }
// ---------------------------------------------------------------
app.post('/tg/answer', async (req, res) => {
  try {
    const { callback_query_id } = req.body || {};
    if (!callback_query_id) {
      return res.status(400).json({ ok: false, error: 'missing callback_query_id' });
    }
    const j = await tgPost('answerCallbackQuery', { callback_query_id });
    res.json(j);
  } catch (e) {
    console.error('[/tg/answer]', e);
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
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