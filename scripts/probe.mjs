import fs from "node:fs";
const urls={
 binance_fut_xau:"https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=XAUUSDT",
 binance_fut_paxg:"https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=PAXGUSDT",
 bybit_xau:"https://api.bybit.com/v5/market/tickers?category=linear&symbol=XAUUSDT",
 bybit_xaut:"https://api.bybit.com/v5/market/tickers?category=linear&symbol=XAUTUSDT",
 okx_xau:"https://www.okx.com/api/v5/market/ticker?instId=XAU-USDT-SWAP",
 okx_xaut:"https://www.okx.com/api/v5/market/ticker?instId=XAUT-USDT",
 bitget_xau:"https://api.bitget.com/api/v2/mix/market/ticker?productType=USDT-FUTURES&symbol=XAUUSDT",
 gate_xaut:"https://api.gateio.ws/api/v4/spot/tickers?currency_pair=XAUT_USDT",
 kraken_fut:"https://futures.kraken.com/derivatives/api/v3/tickers/PF_XAUUSD",
 hyperliquid:"https://api.hyperliquid.xyz/info",
 swissquote:"https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD",
};
const out={};
for(const [k,u] of Object.entries(urls)){
  try{const opt={headers:{Origin:"https://drkaushik-dnb.github.io"}};if(k==="hyperliquid"){opt.method="POST";opt.headers["Content-Type"]="application/json";opt.body=JSON.stringify({type:"allMids"})}
    const r=await fetch(u,opt);const t=await r.text();let body=t;if(k==="hyperliquid"){try{const j=JSON.parse(t);body=JSON.stringify(Object.fromEntries(Object.entries(j).filter(([a])=>/XAU|GOLD|PAXG/i.test(a))))}catch{}}
    out[k]={status:r.status,acao:r.headers.get("access-control-allow-origin"),body:body.slice(0,300)}}catch(e){out[k]={err:e.message}}
}
fs.mkdirSync("data",{recursive:true});fs.writeFileSync("data/probe.json",JSON.stringify(out,null,1));
