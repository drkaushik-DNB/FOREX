import fs from "node:fs";
const out=[];
for(let i=0;i<24;i++){
  const row={t:new Date().toISOString()};
  try{const r=await fetch("https://api.gold-api.com/price/XAU");row.ga_status=r.status;const j=await r.json();row.ga=j.price;row.ga_upd=j.updatedAt}catch(e){row.ga_err=e.message}
  try{const r=await fetch("https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD");const j=await r.json();const p=j[0].spreadProfilePrices[0];row.sq=+((p.bid+p.ask)/2).toFixed(3)}catch(e){row.sq_err=e.message}
  try{const r=await fetch("https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=PAXGUSDT");const j=await r.json();row.paxg=+((+j.bidPrice + +j.askPrice)/2).toFixed(2)}catch(e){row.px_err=e.message}
  out.push(row);await new Promise(r=>setTimeout(r,5000));
}
fs.mkdirSync("data",{recursive:true});fs.writeFileSync("data/probe.json",JSON.stringify(out,null,0));
