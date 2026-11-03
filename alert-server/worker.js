// Gold Signal Desk: background price alerts (Cloudflare Worker, free plan). Deployed from GitHub.
// Checks your alert levels every minute, 24/7, and sends a push notification
// through the free ntfy app, so alerts arrive even when your phone screen is off.
//
// Needs (set up in the Cloudflare dashboard):
//   KV namespace binding:  ALERTS
//   Secrets:               APP_KEY     (the key you paste into the web page once)
//                          NTFY_TOPIC  (your private ntfy topic name)
//                          TG_TOKEN    (optional: Telegram bot token; alerts then go to Telegram)
//   Cron trigger:          * * * * *   (every minute)

const ORIGINS = ["https://drkaushik-dnb.github.io"];
const MARKETS = {
  XAUUSD: { name: "Gold", kraken: "PAXGUSD", spot: true, dp: 2 },
  BTCUSD: { name: "Bitcoin", kraken: "XBTUSD", dp: 2 },
  EURUSD: { name: "EUR/USD", kraken: "EURUSD", dp: 5 },
  GBPUSD: { name: "GBP/USD", kraken: "GBPUSD", dp: 5 },
};
const fmt = (mk, v) => Number(v).toFixed(Math.abs(v) < 20 ? MARKETS[mk].dp : 2);

// repeating alerts: after the first touch, the price must move a little past the level (0.03%)
// before it can fire again, so small wobbles around the level don't send a burst of notifications
const alertTarget = (a) => a.p + (a.n ? a.dir * a.p * 0.0003 : 0);
const getAlerts = async (env) => (await env.ALERTS.get("alerts", { type: "json" })) || [];
const putAlerts = (env, list) => env.ALERTS.put("alerts", JSON.stringify(list));

// Telegram (preferred when TG_TOKEN is set and the chat is linked), otherwise ntfy
const EMOJI = { chart_with_upwards_trend: "\u{1F4C8}", chart_with_downwards_trend: "\u{1F4C9}", white_check_mark: "\u2705", bell: "\u{1F514}" };
async function tgChat(env) { return env.TG_CHAT_ID || (await env.ALERTS.get("tgchat")); }
async function push(env, title, message, tags) {
  if (env.TG_TOKEN) {
    const chat = await tgChat(env);
    let res;
    if (!chat) res = { ok: false, status: 0, via: "telegram", at: Date.now(), info: "Telegram not linked yet: send /start to your bot, then tap Link Telegram on the page." };
    else {
      try {
        const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chat, text: title ? `${title}\n${message}` : message }),
        });
        res = { ok: r.ok, status: r.status, via: "telegram", at: Date.now(), info: r.ok ? "" : (await r.text()).slice(0, 200) };
      } catch (e) { res = { ok: false, status: 0, via: "telegram", at: Date.now(), info: String(e.message || e) }; }
    }
    await env.ALERTS.put("lastpush", JSON.stringify(res));
    return res;
  }
  return ntfyPush(env, title, message, tags);
}
async function ntfyPush(env, title, message, tags) {
  const topic = String(env.NTFY_TOPIC || "").trim();
  const headers = { Priority: "high", Tags: tags || "bell" };
  if (title) headers.Title = title;
  if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`; // optional free ntfy account token
  try {
    const r = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: "POST", body: message, headers });
    const res = { ok: r.ok, status: r.status, at: Date.now(), info: r.ok ? "" : (await r.text()).slice(0, 200) };
    await env.ALERTS.put("lastpush", JSON.stringify(res));
    return res;
  } catch (e) {
    const res = { ok: false, status: 0, at: Date.now(), info: String(e.message || e) };
    await env.ALERTS.put("lastpush", JSON.stringify(res));
    return res;
  }
}

// last few 1-minute candles (so touches between checks are caught) and the latest price
async function prices(mk) {
  const m = MARKETS[mk];
  const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${m.kraken}&interval=1`);
  const j = await r.json();
  if (j.error && j.error.length) throw new Error(j.error.join(","));
  const key = Object.keys(j.result).find((k) => k !== "last");
  let rows = j.result[key].slice(-4).map((k) => ({ t: +k[0], h: +k[2], l: +k[3], c: +k[4] }));
  let now = rows[rows.length - 1].c;
  if (m.spot) { // gold: move the PAXG candles onto the real spot price
    try {
      const g = await (await fetch("https://api.gold-api.com/price/XAU")).json();
      const spot = +g.price;
      if (spot > 0) { const off = now - spot; rows = rows.map((k) => ({ t: k.t, h: k.h - off, l: k.l - off, c: k.c - off })); now = spot; }
    } catch {}
  }
  return { rows, now };
}

const msgFor = (a, now) => `${a.mk === "XAUUSD" ? "" : MARKETS[a.mk].name + " "}${a.dir > 0 ? "Above" : "Below"} ${+Number(a.p).toFixed(MARKETS[a.mk].dp)} Now ${fmt(a.mk, now)}`;
const tagFor = (a) => (a.dir > 0 ? "chart_with_upwards_trend" : "chart_with_downwards_trend");
const hit = (a, hi, lo) => (a.dir > 0 ? hi >= alertTarget(a) : lo <= alertTarget(a));
const after = (a) => (a.rep ? { ...a, dir: -a.dir, n: (a.n || 0) + 1, since: Date.now() } : null); // repeat alerts re-arm the other way

// save the alerts that changed, keeping any added or removed by the page meanwhile
async function save(env, changed) {
  const latest = await getAlerts(env);
  return putAlerts(env, latest.map((a) => (changed.has(a.id) ? changed.get(a.id) : a)).filter(Boolean));
}

// catch-up pass: touches inside the last few 1-minute candles (covers any gap between runs)
async function catchUp(env, list) {
  const data = {};
  for (const mk of new Set(list.map((a) => a.mk))) { try { data[mk] = await prices(mk); } catch {} }
  const changed = new Map();
  for (const a of list) {
    const d = data[a.mk]; if (!d) continue;
    let hi = d.now, lo = d.now;
    for (const k of d.rows) if (a.since ? k.t * 1000 >= a.since : (k.t + 60) * 1000 > a.id) { hi = Math.max(hi, k.h); lo = Math.min(lo, k.l); }
    if (hit(a, hi, lo)) { await push(env, "", msgFor(a, d.now), tagFor(a)); changed.set(a.id, after(a)); }
  }
  if (changed.size) await save(env, changed);
  return changed.size;
}

// live quotes for the watch loop
async function goldSpot() { const g = await (await fetch("https://api.gold-api.com/price/XAU")).json(); return +g.price > 0 ? +g.price : null; }
async function okxGold() {
  const j = await (await fetch("https://www.okx.com/api/v5/market/ticker?instId=XAU-USDT-SWAP")).json();
  const t = j && j.data && j.data[0]; return t ? (+t.bidPx + +t.askPx) / 2 : null;
}
async function krakenNow(mks) {
  const pairs = mks.map((m) => MARKETS[m].kraken).join(",");
  const j = await (await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pairs}`)).json();
  const out = {}, keys = Object.keys(j.result || {});
  for (const mk of mks) {
    const tag = { BTCUSD: "XBT", EURUSD: "EUR", GBPUSD: "GBP" }[mk];
    const k = keys.find((x) => x.includes(tag)); if (!k) continue;
    const r = j.result[k]; out[mk] = (+r.b[0] + +r.a[0]) / 2;
  }
  return out;
}

// one run per minute: a catch-up pass, then watch the live price every 2-3 seconds for about 50 seconds
async function run(env) {
  const t0 = Date.now(), END = t0 + 50000;
  let list = await getAlerts(env);
  if (!list.length) return;
  await catchUp(env, list);
  list = await getAlerts(env);
  if (!list.length) return;
  let spot = null, off = null, spotAt = 0, lastRead = Date.now(), budget = 36; // stay well under 50 outbound requests per run
  const mks = () => [...new Set(list.map((a) => a.mk))];
  while (Date.now() < END && budget > 0) {
    const m = mks(), price = {};
    const wantGold = m.includes("XAUUSD"), others = m.filter((x) => x !== "XAUUSD");
    try {
      if (wantGold) {
        const g = await okxGold(); budget--;
        if (g && (off === null || Date.now() - spotAt > 25000)) { try { spot = await goldSpot(); budget--; if (spot) { off = g - spot; spotAt = Date.now(); } } catch {} }
        if (g && off !== null) price.XAUUSD = g - off;
      }
      if (others.length) { Object.assign(price, await krakenNow(others)); budget--; }
    } catch {}
    const changed = new Map();
    for (const a of list) { const p = price[a.mk]; if (p != null && hit(a, p, p)) { await push(env, "", msgFor(a, p), tagFor(a)); budget--; changed.set(a.id, after(a)); } }
    if (changed.size) { await save(env, changed); list = await getAlerts(env); lastRead = Date.now(); if (!list.length) return; }
    else if (Date.now() - lastRead > 15000) { list = await getAlerts(env); lastRead = Date.now(); if (!list.length) return; }
    const ticksLeft = Math.max(1, Math.floor(budget / (1 + (others.length ? 1 : 0) + (wantGold ? 0.1 : 0))));
    const wait = Math.max(2000, (END - Date.now()) / ticksLeft);
    await new Promise((r) => setTimeout(r, wait));
  }
}

export default {
  // note the check time every 10 minutes only (the free plan allows 1,000 storage writes a day)
  async scheduled(event, env, ctx) { ctx.waitUntil((async () => { if (new Date().getUTCMinutes() % 10 === 0) await env.ALERTS.put("lastrun", String(Date.now())); await run(env); })()); },

  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
      "Access-Control-Allow-Headers": "Content-Type, X-Key",
      "Access-Control-Allow-Methods": "GET, POST, DELETE",
      "Vary": "Origin", "Cache-Control": "no-store",
    };
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(req.url);
    if (url.pathname === "/") {
      const missing = ["APP_KEY", "NTFY_TOPIC"].filter((k) => !env[k]).concat(env.ALERTS ? [] : ["ALERTS (KV binding)"]);
      return new Response(missing.length ? `Not ready. Missing: ${missing.join(", ")}` : "OK - alert server is running", { headers: { ...cors, "Content-Type": "text/plain" } });
    }
    if (!env.APP_KEY || req.headers.get("X-Key") !== env.APP_KEY) return json({ error: "Wrong or missing key" }, 401);

    if (url.pathname === "/alerts" && req.method === "GET") return json(await getAlerts(env));
    if (url.pathname === "/alerts" && req.method === "POST") {
      const a = await req.json().catch(() => null);
      if (!a || !MARKETS[a.mk] || !(+a.p > 0) || ![1, -1].includes(+a.dir)) return json({ error: "Bad alert" }, 400);
      const list = await getAlerts(env);
      const id = +a.id || Date.now();
      const clean = { id, mk: a.mk, p: +a.p, dir: +a.dir, rep: a.rep ? 1 : 0, n: +a.n || 0, since: +a.since || 0 };
      const i = list.findIndex((x) => x.id === id);
      if (i < 0 && list.length >= 50) return json({ error: "Too many alerts (50 max)" }, 400);
      if (i >= 0) list[i] = clean; else list.push(clean); // same id = update (the page fired it first)
      await putAlerts(env, list);
      return json(list);
    }
    if (url.pathname === "/alerts" && req.method === "DELETE") {
      const id = +url.searchParams.get("id");
      const list = (await getAlerts(env)).filter((x) => x.id !== id);
      await putAlerts(env, list);
      return json(list);
    }
    if (url.pathname === "/test" && req.method === "POST") {
      const r = await push(env, "Gold Signal Desk", "Test notification: background alerts are working.", "white_check_mark");
      return json({ ok: r.ok, ntfy: r.status, via: r.via || "ntfy", info: r.info, topicSet: !!env.NTFY_TOPIC });
    }
    // link Telegram: read the latest message sent to the bot and remember that chat
    if (url.pathname === "/tg-link" && req.method === "POST") {
      if (!env.TG_TOKEN) return json({ ok: false, info: "Add the TG_TOKEN secret in Cloudflare first." });
      const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getUpdates?limit=50`);
      const j = await r.json().catch(() => ({}));
      if (!j.ok) return json({ ok: false, info: "Telegram rejected the bot token. Check TG_TOKEN." });
      const msgs = (j.result || []).map((u) => u.message || u.edited_message || u.channel_post).filter(Boolean);
      const m = msgs[msgs.length - 1];
      if (!m) return json({ ok: false, info: "No message found. Open your bot in Telegram, tap Start (or send hi), then try again." });
      await env.ALERTS.put("tgchat", String(m.chat.id));
      await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: m.chat.id, text: "\u2705 Gold Signal Desk is linked. Price alerts will arrive here." }) });
      return json({ ok: true, name: m.chat.first_name || m.chat.title || "" });
    }
    if (url.pathname === "/status" && req.method === "GET") {
      const lastrun = +(await env.ALERTS.get("lastrun")) || 0;
      const lastpush = await env.ALERTS.get("lastpush", { type: "json" });
      return json({ lastrun, lastpush, alerts: (await getAlerts(env)).length, now: Date.now(), telegram: !!env.TG_TOKEN, tgLinked: !!(await tgChat(env)) });
    }
    return json({ error: "Not found" }, 404);
  },
};
