#!/usr/bin/env python3
import argparse, json, os, re, time
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import pandas as pd
import requests
import yfinance as yf

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "screening.json"
FINMIND = "https://api.finmindtrade.com/api/v4/data"
TAIPEI = ZoneInfo("Asia/Taipei")

def fetch_tw_universe():
    r = requests.get(FINMIND, params={"dataset":"TaiwanStockInfo"}, timeout=45)
    r.raise_for_status()
    rows = r.json().get("data", [])
    if not rows:
        raise RuntimeError("FinMind TaiwanStockInfo 無資料")
    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.sort_values("date").drop_duplicates("stock_id", keep="last")
    df = df[df["type"].isin(["twse","tpex"])]
    # Common stocks only; remove ETF/index and unusual alphanumeric products.
    bad_cat = df["industry_category"].fillna("").astype(str).str.contains("ETF|Index|大盤|所有證券", case=False, regex=True)
    df = df[~bad_cat]
    df = df[df["stock_id"].astype(str).str.fullmatch(r"\d{4}")]
    out=[]
    for _,r in df.iterrows():
        suffix=".TW" if r["type"]=="twse" else ".TWO"
        out.append({"symbol":str(r["stock_id"]), "name":str(r["stock_name"]), "yf":str(r["stock_id"])+suffix})
    return out

def fetch_us_universe():
    # Practical V1 US universe: S&P 500 + Nasdaq-100.
    # This avoids trying to download every thinly-traded US listing every day.
    headers={"User-Agent":"Mozilla/5.0"}
    tickers={}
    try:
        sp=pd.read_html(requests.get("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",headers=headers,timeout=30).text)[0]
        for _,r in sp.iterrows():
            s=str(r["Symbol"]).replace(".","-")
            tickers[s]=str(r["Security"])
    except Exception as e:
        print("S&P 500 universe warning:",e)
    try:
        nd=pd.read_html(requests.get("https://en.wikipedia.org/wiki/Nasdaq-100",headers=headers,timeout=30).text)
        table=next(x for x in nd if "Ticker" in x.columns)
        namecol="Company" if "Company" in table.columns else None
        for _,r in table.iterrows():
            s=str(r["Ticker"]).replace(".","-")
            tickers[s]=str(r[namecol]) if namecol else s
    except Exception as e:
        print("Nasdaq-100 universe warning:",e)
    if not tickers:
        # Fallback so a temporary Wikipedia format change does not produce an empty file.
        fallback=["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","AMD","NFLX","PLTR","MU","ORCL","COST","INTC"]
        tickers={x:x for x in fallback}
    return [{"symbol":s,"name":n,"yf":s} for s,n in tickers.items()]

def local_turns(close):
    vals=np.asarray(close,float)
    p=[]
    for i in range(3,len(vals)-3):
        w=vals[i-3:i+4]
        if vals[i] == np.nanmax(w): p.append((i,"H",vals[i]))
        if vals[i] == np.nanmin(w): p.append((i,"L",vals[i]))
    # collapse consecutive same-type turns to the more extreme one
    q=[]
    for item in p:
        if not q or q[-1][1]!=item[1]:
            q.append(item)
        else:
            if (item[1]=="H" and item[2]>q[-1][2]) or (item[1]=="L" and item[2]<q[-1][2]):
                q[-1]=item
    return q

def analyze(df, item, market):
    df=df.dropna(subset=["Close"]).copy()
    if len(df)<170: return None
    close=df["Close"].astype(float)
    vol=df["Volume"].fillna(0).astype(float)
    n=len(close)
    ma50=close.rolling(50).mean().iloc[-1]
    ma150=close.rolling(150).mean().iloc[-1]
    trend=bool(close.iloc[-1]>ma50>ma150)

    piv=local_turns(close.values)
    drops=[]
    for a,b in zip(piv,piv[1:]):
        if a[1]=="H" and b[1]=="L" and a[2]>0:
            drops.append((a[0],b[0],(a[2]-b[2])/a[2]*100))
    drops=drops[-4:]
    seq=[x[2] for x in drops]
    contracting=len(seq)>=2 and all(seq[i] < seq[i-1]*1.12 for i in range(1,len(seq)))

    recent=close.iloc[-35:]
    pivot=float(recent.iloc[:-3].max())
    last=float(close.iloc[-1])
    distance=(last/pivot-1)*100

    v20=float(vol.iloc[-20:].mean())
    vprev=float(vol.iloc[-60:-20].mean()) if len(vol)>=60 else float(vol.iloc[:-20].mean())
    dry=bool(vprev>0 and v20<vprev*0.85)
    breakout=last>pivot
    breakout_vol=bool(v20>0 and vol.iloc[-1]>v20*1.35)
    prev=float(close.iloc[-2])
    today_breakout=bool(prev<=pivot and breakout and breakout_vol)

    score=sum([
        trend,
        len(seq)>=2,
        contracting,
        dry,
        today_breakout or ((not breakout) and distance>-8),
    ])

    # PowerSqueeze-style volatility compression.
    # BB(20, 2σ) compared with Keltner Channels based on EMA20 + ATR20.
    # This remains separate from the 5-point VCP score.
    high=pd.to_numeric(df["High"],errors="coerce")
    low=pd.to_numeric(df["Low"],errors="coerce")
    bb_mid=close.rolling(20).mean()
    bb_std=close.rolling(20).std(ddof=0)
    bb_upper=bb_mid+2*bb_std
    bb_lower=bb_mid-2*bb_std
    ema20=close.ewm(span=20,adjust=False).mean()
    prev_close=close.shift(1)
    tr=pd.concat([(high-low).abs(),(high-prev_close).abs(),(low-prev_close).abs()],axis=1).max(axis=1)
    atr20=tr.rolling(20).mean()

    def inside_kc(mult):
        return bool(
            bb_upper.iloc[-1] < (ema20.iloc[-1]+atr20.iloc[-1]*mult)
            and bb_lower.iloc[-1] > (ema20.iloc[-1]-atr20.iloc[-1]*mult)
        )

    if inside_kc(1.0):
        squeeze_level,squeeze_state="strong","🔴 強力壓縮"
    elif inside_kc(1.5):
        squeeze_level,squeeze_state="medium","🟠 中度壓縮"
    elif inside_kc(2.0):
        squeeze_level,squeeze_state="weak","🩷 一般壓縮"
    else:
        squeeze_level,squeeze_state="none","⚪ 無壓縮"

    mom=close-close.rolling(20).mean()
    m_now,m_prev=float(mom.iloc[-1]),float(mom.iloc[-2])
    if m_now>=0 and m_now>=m_prev:
        momentum,momentum_dir="↑ 多方增強","bull_up"
    elif m_now>=0:
        momentum,momentum_dir="↘ 多方減弱","bull_down"
    elif m_now<0 and m_now<=m_prev:
        momentum,momentum_dir="↓ 空方增強","bear_down"
    else:
        momentum,momentum_dir="↗ 空方減弱","bear_up"
    combo=bool(squeeze_level!="none" and score>=4)

    # Liquidity filter to reduce unusable/very thin names.
    avg_value=float((close.iloc[-20:]*vol.iloc[-20:]).mean())
    min_liq=20_000_000 if market=="TW" else 10_000_000
    if avg_value < min_liq or score < 4:
        return None

    if today_breakout:
        typ,state="breakout","🟢 今日帶量突破"
    elif not breakout and distance>-5:
        typ,state="near","🟡 接近 Pivot"
    elif not breakout:
        typ,state="forming","⚪ VCP 成形中"
    else:
        return None

    if distance>12:
        return None

    return {
        "market":market,
        "symbol":item["symbol"],
        "name":item["name"],
        "score":int(score),
        "contracts":" → ".join(f"-{x:.0f}%" for x in seq) if seq else "—",
        "pivot":round(pivot,2),
        "last":round(last,2),
        "distance":round(distance,2),
        "volume_dry":dry,
        "type":typ,
        "state":state,
        "squeeze_level":squeeze_level,
        "squeeze_state":squeeze_state,
        "momentum":momentum,
        "momentum_dir":momentum_dir,
        "combo":combo,
        "data_date":df.index[-1].strftime("%Y-%m-%d"),
        "avg_value_20d":round(avg_value,0),
    }

def download_batch(items, market):
    tickers=[x["yf"] for x in items]
    try:
        raw=yf.download(
            tickers=tickers, period="1y", interval="1d", group_by="ticker",
            auto_adjust=False, progress=False, threads=True, timeout=30
        )
    except Exception as e:
        print("batch download failed", e)
        return []
    results=[]
    for item in items:
        try:
            if len(tickers)==1:
                d=raw
            else:
                if item["yf"] not in raw.columns.get_level_values(0): continue
                d=raw[item["yf"]]
            if d is None or d.empty: continue
            r=analyze(d,item,market)
            if r: results.append(r)
        except Exception as e:
            print("analyze warning",item["symbol"],e)
    return results

def scan(market):
    universe=fetch_tw_universe() if market=="TW" else fetch_us_universe()
    print(f"{market}: universe {len(universe)}")
    batch_size=120 if market=="TW" else 100
    batches=[universe[i:i+batch_size] for i in range(0,len(universe),batch_size)]
    results=[]
    # Keep concurrency modest; yfinance already uses threads internally.
    for i,b in enumerate(batches,1):
        print(f"{market}: batch {i}/{len(batches)}")
        results.extend(download_batch(b,market))
        time.sleep(1)
    results.sort(key=lambda r:(-r["score"], 0 if r["type"]=="breakout" else 1 if r["type"]=="near" else 2, abs(r["distance"])))
    # Keep website light.
    return results[:150]

def load_existing():
    if OUT.exists():
        try: return json.loads(OUT.read_text(encoding="utf-8"))
        except Exception: pass
    return {"results":[],"markets":{}}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--market", choices=["TW","US","both"], default="both")
    args=ap.parse_args()

    old=load_existing()
    by_market={"TW":[r for r in old.get("results",[]) if r.get("market")=="TW"],
               "US":[r for r in old.get("results",[]) if r.get("market")=="US"]}
    targets=["TW","US"] if args.market=="both" else [args.market]
    market_meta=old.get("markets",{})

    for m in targets:
        rows=scan(m)
        if rows:
            by_market[m]=rows
            dates=[r["data_date"] for r in rows if r.get("data_date")]
            market_meta[m]={
                "data_date":max(dates) if dates else None,
                "count":len(rows),
                "scanned_at":datetime.now(TAIPEI).strftime("%Y-%m-%d %H:%M")
            }
        else:
            # Do not erase prior good data on a transient provider failure.
            market_meta.setdefault(m,{})
            market_meta[m]["last_error"]="本次掃描沒有產生結果，已保留前次名單"
            market_meta[m]["scanned_at"]=datetime.now(TAIPEI).strftime("%Y-%m-%d %H:%M")

    all_rows=by_market["TW"]+by_market["US"]
    payload={
        "generated_at":datetime.now(TAIPEI).strftime("%Y-%m-%d %H:%M"),
        "timezone":"Asia/Taipei",
        "markets":market_meta,
        "results":all_rows
    }
    OUT.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"wrote {OUT}, {len(all_rows)} rows")

if __name__=="__main__":
    main()
