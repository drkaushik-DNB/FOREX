// Gold Signal Desk: read-only OANDA price proxy (Cloudflare Worker, free plan).
// Keeps your OANDA demo API key secret and lets the web page read real spot prices.
// Setup: paste this into a new Cloudflare Worker, then add a secret named OANDA_TOKEN
// (Settings -> Variables and Secrets) holding your OANDA demo (practice) API token.

const ALLOWED_ORIGINS = ["https://drkaushik-dnb.github.io"];
const API = "https://api-fxpractice.oanda.com";
const STREAM = "https://stream-fxpractice.oanda.com";
const INSTRUMENTS = new Set(["XAU_USD", "EUR_USD", "GBP_USD"]);
const GRANULARITY = new Set(["M1", "M5", "M15", "M30", "H1", "H4", "D"]);
let ACCOUNT_ID = null;

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Vary": "Origin",
      "Cache-Control": "no-store",
    };
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" } });
    }
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });
    // browsers on other websites are refused; the GitHub 24/7 job (no Origin header) is allowed
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response("Forbidden", { status: 403, headers: cors });
    if (!env.OANDA_TOKEN) return new Response("OANDA_TOKEN secret is not set", { status: 500, headers: cors });

    const auth = { Authorization: `Bearer ${env.OANDA_TOKEN}`, "Accept-Datetime-Format": "RFC3339" };
    const url = new URL(req.url);
    try {
      if (url.pathname === "/candles") {
        const inst = url.searchParams.get("instrument") || "";
        const gran = url.searchParams.get("granularity") || "";
        if (!INSTRUMENTS.has(inst) || !GRANULARITY.has(gran)) return new Response("Bad request", { status: 400, headers: cors });
        const r = await fetch(`${API}/v3/instruments/${inst}/candles?price=M&granularity=${gran}&count=500&alignmentTimezone=UTC&dailyAlignment=0`, { headers: auth });
        return new Response(r.body, { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
      }
      if (url.pathname === "/stream") {
        const list = (url.searchParams.get("instruments") || "").split(",");
        if (!list.length || !list.every((i) => INSTRUMENTS.has(i))) return new Response("Bad request", { status: 400, headers: cors });
        if (!ACCOUNT_ID) {
          const a = await fetch(`${API}/v3/accounts`, { headers: auth });
          const j = await a.json();
          ACCOUNT_ID = j.accounts && j.accounts[0] && j.accounts[0].id;
          if (!ACCOUNT_ID) return new Response("No OANDA account found for this token", { status: 502, headers: cors });
        }
        const r = await fetch(`${STREAM}/v3/accounts/${ACCOUNT_ID}/pricing/stream?instruments=${list.join(",")}`, { headers: auth });
        return new Response(r.body, { status: r.status, headers: { ...cors, "Content-Type": "application/octet-stream" } });
      }
      if (url.pathname === "/test") {
        const r = await fetch(`${API}/v3/instruments/XAU_USD/candles?price=M&granularity=M1&count=1`, { headers: auth });
        const j = await r.json();
        const c = j.candles && j.candles[0];
        return new Response(c ? `OK - gold spot ${c.mid.c} at ${c.time}` : `OANDA said: ${JSON.stringify(j)}`, { status: r.status, headers: { ...cors, "Content-Type": "text/plain" } });
      }
      return new Response("Gold Signal Desk price proxy. Open /test to check it.", { headers: { ...cors, "Content-Type": "text/plain" } });
    } catch (e) {
      return new Response("Could not reach OANDA: " + e.message, { status: 502, headers: cors });
    }
  },
};
