// 24/7 signal log for Gold Signal Desk.
// Runs on GitHub Actions every 15 minutes. It reuses the exact indicator and
// signal code from index.html, so the log follows the same rules as the page.
import fs from "node:fs";

const DEF = { th: 35, adx: 20, slm: 1.5, rr: 2, hold: 50 };
const MKS = {
  XAUUSD: { kraken: "PAXGUSD", binance: "PAXGUSDT", dp: 2, closesWeekend: true },
  BTCUSD: { kraken: "XBTUSD", binance: "BTCUSDT", dp: 2, closesWeekend: false },
  EURUSD: { kraken: "EURUSD", binance: "EURUSDT", dp: 5, closesWeekend: true },
  GBPUSD: { kraken: "GBPUSD", binance: "GBPUSDT", dp: 5, closesWeekend: true },
};
const LOG_TF = ["15m", "1h", "4h"];
const FETCH_TF = ["15m", "1h", "4h", "1d"];
const KR = { "15m": 15, "1h": 60, "4h": 240, "1d": 1440 };
const SEC = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const HTF = { "15m": ["1h", "4h"], "1h": ["4h", "1d"], "4h": ["1d"] };
const FILE = "data/signals.json";

// ---- load the engine straight out of index.html ----
const html = fs.readFileSync("index.html", "utf8");
const a = html.indexOf("/* ---------- indicator maths ---------- */");
const b = html.indexOf("/* ---------- render ---------- */");
if (a < 0 || b < 0) throw new Error("Engine markers not found in index.html");
const makeEngine = new Function("CFG", "SPR", "M", "MK",
  html.slice(a, b) + "\nreturn {series, evalAt};");
const engineFor = (mk) => makeEngine(DEF, { [mk]: 0 }, () => ({ dp: MKS[mk].dp }), mk);

// ---- data ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function kraken(pair, tf) {
  const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${KR[tf]}`);
  if (!r.ok) throw new Error(`Kraken HTTP ${r.status}`);
  const j = await r.json();
  if (j.error && j.error.length) throw new Error("Kraken " + j.error.join(","));
  const key = Object.keys(j.result).find((k) => k !== "last");
  return j.result[key].map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
}
async function binance(sym, tf) {
  const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=${tf}&limit=500`);
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
  return (await r.json()).map((k) => ({ t: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
}
async function candles(mk, tf) {
  try { return { src: "kraken", cs: await kraken(MKS[mk].kraken, tf) }; }
  catch (e) { console.log(`  ${mk} ${tf}: ${e.message}, trying Binance`); }
  try { return { src: "binance", cs: await binance(MKS[mk].binance, tf) }; }
  catch (e) { console.log(`  ${mk} ${tf}: ${e.message}`); errors.push(`${mk} ${tf}: ${e.message}`); return null; }
}

function fxWeekend(now) {
  const p = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" })
    .formatToParts(new Date(now)).forEach((x) => (p[x.type] = x.value));
  const h = +p.hour;
  return p.weekday === "Sat" || (p.weekday === "Fri" && h >= 17) || (p.weekday === "Sun" && h < 17);
}

// ---- main ----
const now = Date.now();
let store = { signals: [] };
try { store = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
const before = JSON.stringify(store.signals);
let SIG = store.signals || [];
const status = {}, errors = [];

for (const mk of Object.keys(MKS)) {
  const E = engineFor(mk);
  const data = {};
  for (const tf of FETCH_TF) { const d = await candles(mk, tf); if (d) data[tf] = d; await sleep(1200); }
  // gold: shift the PAXG candles onto the real spot price (same method as the web page)
  if (mk === "XAUUSD") {
    try {
      const r = await fetch("https://api.gold-api.com/price/XAU"); const j = await r.json(); const spot = +j.price;
      const ref = (data["15m"] || data["1h"]); const off = ref ? ref.cs[ref.cs.length - 1].c - spot : 0;
      if (spot > 0 && Math.abs(off) < 200) {
        for (const tf in data) data[tf].cs = data[tf].cs.map((k) => ({ t: k.t, o: k.o - off, h: k.h - off, l: k.l - off, c: k.c - off }));
        console.log(`  gold matched to spot ${spot} (offset ${off.toFixed(2)})`);
      }
    } catch (e) { console.log("  gold spot unavailable: " + e.message); }
  }
  const raw = {};
  for (const tf of FETCH_TF) {
    const d = data[tf]; if (!d) continue;
    const done = d.cs.slice(0, -1); // completed candles only
    if (done.length < 210) { console.log(`  ${mk} ${tf}: only ${done.length} candles`); continue; }
    raw[tf] = E.evalAt(E.series(done), done.length - 1);
  }
  for (const tf of LOG_TF) {
    const d = data[tf], e = raw[tf]; if (!d || !e) continue;
    const all = d.cs, live = all[all.length - 1], price = live.c;
    let v = e.verdict;
    const hs = HTF[tf].map((h) => raw[h]);
    if (v !== "WAIT" && !hs.every((h) => h && (v === "BUY" ? h.score >= 0.1 : h.score <= -0.1))) v = "WAIT";
    if (MKS[mk].closesWeekend && fxWeekend(now)) v = "WAIT";

    // resolve open signals for this market/timeframe
    for (const s of SIG) {
      if (s.st !== "open" || s.mk !== mk || s.tf !== tf) continue;
      const after = all.filter((k) => k.t > s.tc);
      let res = null;
      for (const k of after) {
        const hs2 = s.d > 0 ? k.l <= s.sl : k.h >= s.sl, ht = s.d > 0 ? k.h >= s.tp : k.l <= s.tp;
        if (hs2) { res = ["LOSS", -1, s.sl]; break; }
        if (ht) { res = ["WIN", s.rr, s.tp]; break; }
      }
      // the current price also counts (covers moves inside the candle the signal opened in)
      if (!res && (s.d > 0 ? price <= s.sl : price >= s.sl)) res = ["LOSS", -1, s.sl];
      if (!res && (s.d > 0 ? price >= s.tp : price <= s.tp)) res = ["WIN", s.rr, s.tp];
      const pr = s.d * (price - s.en) / s.risk;
      if (!res && after.length >= s.hold) res = [pr > 0 ? "WIN" : "LOSS", pr, price, "time limit"];
      if (!res && v !== "WAIT" && (v === "BUY" ? 1 : -1) !== s.d) res = [pr > 0 ? "WIN" : "LOSS", pr, price, "reversed"];
      if (res) { [s.st, s.r, s.px] = res; s.r = +s.r.toFixed(3); s.tx = now; if (res[3]) s.note = res[3]; console.log(`  closed ${mk} ${tf} ${s.st} ${s.r}R`); }
    }

    // open a new signal
    if (v !== "WAIT") {
      const dir = v === "BUY" ? 1 : -1;
      const open = SIG.find((s) => s.st === "open" && s.mk === mk && s.tf === tf);
      const recent = SIG.find((s) => s.mk === mk && s.tf === tf && s.d === dir && now - s.t0 < DEF.hold * SEC[tf] * 1000);
      if (!open && !recent) {
        const risk = DEF.slm * e.atr;
        SIG.push({ id: now + LOG_TF.indexOf(tf), mk, tf, d: dir, t0: now, tc: live.t, en: price,
          sl: +(price - dir * risk).toFixed(6), tp: +(price + dir * DEF.rr * risk).toFixed(6),
          risk: +risk.toFixed(6), rr: DEF.rr, hold: DEF.hold, st: "open", src: data[tf].src, score: +e.score.toFixed(3) });
        console.log(`  NEW ${v} ${mk} ${tf} at ${price}`);
      }
    }
    (status[mk] ||= {})[tf] = { signal: v, raw: e.verdict, score: +e.score.toFixed(3), price, src: data[tf].src };
    console.log(`${mk} ${tf}: ${e.verdict} -> ${v} (score ${(e.score * 100).toFixed(0)}%, ${data[tf].src})`);
  }
}

if (SIG.length > 1500) SIG = SIG.slice(-1500);
const changed = JSON.stringify(SIG) !== before;
const stale = process.env.GITHUB_EVENT_NAME === "workflow_dispatch" || !store.lastRun || now - store.lastRun > 55 * 60 * 1000 || JSON.stringify(store.errors || []) !== JSON.stringify(errors); // heartbeat at most hourly
if (changed || stale) {
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ lastRun: now, rules: DEF, status, errors, signals: SIG }, null, 1));
  console.log(changed ? "Signals changed, saved." : "Heartbeat saved.");
} else console.log("No change.");
