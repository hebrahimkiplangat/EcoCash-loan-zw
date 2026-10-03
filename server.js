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
//  Server-side debug ring buffer
// ---------------------------------------------------------------
const DEBUG_LOG = [];
function slog(tag, msg) {
  const entry = { t: new Date().toISOString(), tag, msg };
  DEBUG_LOG.push(entry);
  if (DEBUG_LOG.length > 100) DEBUG_LOG.shift();
  console.log(`[${tag}]`, msg);
}

app.get('/debug/log', (req, res) => {
  res.json({ ok: true, count: DEBUG_LOG.length, entries: DEBUG_LOG });
});

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
//  /tg/send
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
    slog('send', `ok=${j.ok} ${j.ok ? 'msg_id=' + (j.result && j.result.message_id) : 'err=' + j.description}`);
    res.json(j);
  } catch (e) {
    slog('send', 'ERROR ' + (e && e.message));
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// ---------------------------------------------------------------
//  /tg/updates — long-poll
// ---------------------------------------------------------------
app.get('/tg/updates', async (req, res) => {
  try {
    const query = { timeout: 20, allowed_updates: JSON.stringify(['callback_query']) };
    if (req.query.offset) query.offset = String(req.query.offset);
    const j = await tgGet('getUpdates', query, 25000);

    const count = j && j.result ? j.result.length : 0;
    const offset = req.query.offset || '-';
    if (!j.ok) {
      slog('poll', `offset=${offset} FAILED: ${j.description || j.error_code || 'unknown'}`);
    } else if (count > 0) {
      const ids = j.result.map(u => u.update_id).join(',');
      slog('poll', `offset=${offset} → ${count} update(s) [${ids}]`);
    }
    res.json(j);
  } catch (e) {
    slog('poll', 'EXCEPTION ' + (e && e.message));
    res.json({ ok: false, result: [], error: String(e && e.message || e) });
  }
});

// ---------------------------------------------------------------
//  /tg/answer
// ---------------------------------------------------------------
app.post('/tg/answer', async (req, res) => {
  const { callback_query_id } = req.body || {};
  if (!callback_query_id) return res.status(400).json({ ok: false, error: 'missing id' });
  try {
    const j = await tgPost('answerCallbackQuery', { callback_query_id }, 4000);
    slog('ack', `id=${callback_query_id} ok=${j.ok}${j.ok ? '' : ' ' + (j.description || '')}`);
    return res.json({ ok: true, tg: j });
  } catch (e) {
    slog('ack', `id=${callback_query_id} EXCEPTION ${e && e.message}`);
    return res.json({ ok: true, tg: { ok: false, error: String(e && e.message) } });
  }
});

// ---------------------------------------------------------------
//  /tg/beacon
// ---------------------------------------------------------------
app.post('/tg/beacon', async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    const cbId = body && body.callback_query_id;
    if (cbId) {
      tgPost('answerCallbackQuery', { callback_query_id: cbId }, 4000)
        .then(j => slog('beacon', `id=${cbId} ok=${j.ok}`))
        .catch(e => slog('beacon', `id=${cbId} ERR ${e && e.message}`));
    }
    res.status(200).end();
  } catch (e) {
    res.status(200).end();
  }
});

// ---------------------------------------------------------------
//  /healthz
// ---------------------------------------------------------------
app.get('/healthz', (req, res) => {
  res.json({ ok: true, bot: BOT_TOKEN ? 'set' : 'missing', chat: CHAT_ID ? 'set' : 'missing', t: Date.now() });
});

// ---------------------------------------------------------------
//  Static
// ---------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  slog('boot', `server up on :${PORT}`);
  slog('boot', `bot=${BOT_TOKEN ? 'set' : 'MISSING'} chat=${CHAT_ID ? 'set' : 'MISSING'}`);
  if (BOT_TOKEN) {
    try {
      const j = await tgPost('deleteWebhook', { drop_pending_updates: false }, 6000);
      slog('boot', 'deleteWebhook: ' + JSON.stringify(j));
    } catch (e) {
      slog('boot', 'deleteWebhook failed: ' + (e && e.message));
    }
  }
});

if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL + '/healthz').catch(() => {});
  }, 4 * 60 * 1000);
}
