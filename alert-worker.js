// Gold Signal Desk: background price alerts (Cloudflare Worker, free plan).
// Checks your alert levels every minute, 24/7, and sends a push notification
// through the free ntfy app, so alerts arrive even when your phone screen is off.
//
// Needs (set up in the Cloudflare dashboard):
//   KV namespace binding:  ALERTS
//   Secrets:               APP_KEY     (the key you paste into the web page once)
//                          NTFY_TOPIC  (your private ntfy topic name)
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

async function push(env, title, message, tags) {
  await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
    method: "POST", body: message,
    headers: { Title: title, Priority: "high", Tags: tags || "bell" },
  });
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

async function check(env) {
  const list = await getAlerts(env);
  if (!list.length) return;
  const data = {};
  for (const mk of new Set(list.map((a) => a.mk))) { try { data[mk] = await prices(mk); } catch {} }
  const keep = []; let fired = 0;
  for (const a of list) {
    const d = data[a.mk];
    if (!d) { keep.push(a); continue; }
    let hi = d.now, lo = d.now;
    // only candles after the alert was set (or after it last fired, for repeating alerts)
    for (const k of d.rows) if (a.since ? k.t * 1000 >= a.since : (k.t + 60) * 1000 > a.id) { hi = Math.max(hi, k.h); lo = Math.min(lo, k.l); }
    const target = alertTarget(a);
    if (a.dir > 0 ? hi >= target : lo <= target) {
      fired++;
      const nm = MARKETS[a.mk].name;
      await push(env, `${a.rep ? "Repeat alert" : "Price alert"} · ${nm}`,
        `${nm} ${a.dir > 0 ? (a.n ? "rose back above" : "rose to") : (a.n ? "fell back below" : "fell to")} ${fmt(a.mk, a.p)}. Now ${fmt(a.mk, d.now)}.`,
        a.dir > 0 ? "chart_with_upwards_trend" : "chart_with_downwards_trend");
      if (a.rep) { // stay active and wait for the next crossing the other way
        keep.push({ ...a, dir: -a.dir, n: (a.n || 0) + 1, since: Math.ceil(Date.now() / 60000) * 60000 });
      }
    } else keep.push(a);
  }
  if (fired) {
    // re-read so an alert added or removed during this check is respected
    const latest = await getAlerts(env), mine = new Map(keep.map((a) => [a.id, a])), seen = new Set(list.map((a) => a.id));
    await putAlerts(env, latest.filter((a) => !seen.has(a.id) || mine.has(a.id)).map((a) => mine.get(a.id) || a));
  }
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(check(env)); },

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
      await push(env, "Gold Signal Desk", "Test notification: background alerts are working.", "white_check_mark");
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  },
};
