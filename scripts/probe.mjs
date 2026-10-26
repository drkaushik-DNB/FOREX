import fs from "node:fs";
const urls={
 goldapi:"https://api.gold-api.com/price/XAU",
 swissquote:"https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD",
 goldprice:"https://data-asg.goldprice.org/dbXRates/USD",
 stooq:"https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlc&h&e=csv",
 yahoo:"https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=1m&range=1d",
 kitco:"https://proxy.kitco.com/getPM?symbol=AU&currency=USD",
};
const out={at:new Date().toISOString()};
for(const [k,u] of Object.entries(urls)){
  for(let n=0;n<2;n++){
    try{const t=Date.now();const r=await fetch(u,{headers:{Origin:"https://drkaushik-dnb.github.io","User-Agent":"Mozilla/5.0"}});const txt=await r.text();
      (out[k]||=[]).push({status:r.status,ms:Date.now()-t,acao:r.headers.get("access-control-allow-origin"),body:txt.slice(0,400)});}
    catch(e){(out[k]||=[]).push({err:e.message})}
    await new Promise(r=>setTimeout(r,3000));
  }
}
fs.mkdirSync("data",{recursive:true});fs.writeFileSync("data/probe.json",JSON.stringify(out,null,1));
