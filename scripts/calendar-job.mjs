// High-impact economic calendar for Gold Signal Desk (all countries).
// Runs inside the 15-minute GitHub job but only downloads about once an hour,
// because the free ForexFactory feed rate-limits frequent requests.
import fs from "node:fs";

const FILE = "data/calendar.json";
const FEEDS = [
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
  "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
];

let old = { fetchedAt: 0, events: [] };
try { old = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
const now = Date.now();
if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" && now - (old.fetchedAt || 0) < 55 * 60 * 1000) {
  console.log("Calendar fetched recently, skipping.");
  process.exit(0);
}

const got = [];
let ok = 0;
for (const url of FEEDS) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "gold-signal-desk (github.com/drkaushik-DNB/FOREX)" } });
    if (!r.ok) { console.log(`${url}: HTTP ${r.status}`); continue; }
    const list = await r.json();
    if (!Array.isArray(list)) { console.log(`${url}: unexpected format`); continue; }
    ok++;
    for (const e of list) {
      if (String(e.impact || "").toLowerCase() !== "high") continue;
      const t = Date.parse(e.date);
      if (!isFinite(t)) continue;
      got.push({ t, cur: String(e.country || "").toUpperCase(), n: String(e.title || "").slice(0, 80),
        f: e.forecast || "", p: e.previous || "" });
    }
  } catch (err) { console.log(`${url}: ${err.message}`); }
}

if (!ok) {
  console.log("No calendar feed reachable; keeping the old file.");
  if (old.events && old.events.length) process.exit(0);
}

// keep the last 2 days of old events so recent releases still show, then add the fresh ones
const key = (e) => `${e.t}|${e.cur}|${e.n}`;
const map = new Map();
for (const e of old.events || []) if (e.t > now - 2 * 864e5) map.set(key(e), e);
for (const e of got) map.set(key(e), e);
const events = [...map.values()].sort((a, b) => a.t - b.t);

fs.mkdirSync("data", { recursive: true });
fs.writeFileSync(FILE, JSON.stringify({ fetchedAt: now, source: "ForexFactory", events }, null, 1));
console.log(`Saved ${events.length} high-impact events (${got.length} from ${ok} feed(s)).`);
for (const e of events.slice(0, 12)) console.log(new Date(e.t).toISOString(), e.cur, e.n);
