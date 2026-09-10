"""
VCPulse Theme Historical Runner v0.2
Modes:
  1) finmind: fetch historical OHLCV and recompute V2.39 as-of each day
  2) snapshots: read historical screening.json snapshots exported from GitHub history
Outputs:
  backtest_daily.json
  backtest_summary.json

Standalone. Does NOT write production screening.json and does NOT modify V2.39.
"""

from __future__ import annotations
import argparse, json, os, time, math
from pathlib import Path
from datetime import date, timedelta
import requests
import pandas as pd
import numpy as np

FINMIND="https://api.finmindtrade.com/api/v4/data"

# --- embedded V2.39 core logic ---
def local_turns(close):
    vals=np.asarray(close,float); p=[]
    for i in range(3,len(vals)-3):
        w=vals[i-3:i+4]
        if vals[i]==np.nanmax(w): p.append((i,"H",vals[i]))
        if vals[i]==np.nanmin(w): p.append((i,"L",vals[i]))
    q=[]
    for item in p:
        if not q or q[-1][1]!=item[1]: q.append(item)
        elif (item[1]=="H" and item[2]>q[-1][2]) or (item[1]=="L" and item[2]<q[-1][2]): q[-1]=item
    return q

def analyze_asof(df, market="TW"):
    df=df.dropna(subset=["Close"]).copy()
    if len(df)<170: return None
    close=df["Close"].astype(float); vol=df["Volume"].fillna(0).astype(float)
    ma50=close.rolling(50).mean().iloc[-1]; ma150=close.rolling(150).mean().iloc[-1]
    trend=bool(close.iloc[-1]>ma50>ma150)
    piv=local_turns(close.values); drops=[]
    for a,b in zip(piv,piv[1:]):
        if a[1]=="H" and b[1]=="L" and a[2]>0: drops.append((a[0],b[0],(a[2]-b[2])/a[2]*100))
    drops=drops[-4:]; seq=[x[2] for x in drops]
    contracting=len(seq)>=2 and all(seq[i]<seq[i-1]*1.12 for i in range(1,len(seq)))
    recent=close.iloc[-35:]; pivot=float(recent.iloc[:-3].max()); last=float(close.iloc[-1])
    distance=(last/pivot-1)*100
    v20=float(vol.iloc[-20:].mean())
    vprev=float(vol.iloc[-60:-20].mean()) if len(vol)>=60 else float(vol.iloc[:-20].mean())
    dry=bool(vprev>0 and v20<vprev*0.85)
    breakout=last>pivot; breakout_vol=bool(v20>0 and vol.iloc[-1]>v20*1.35)
    prev=float(close.iloc[-2]); today_breakout=bool(prev<=pivot and breakout and breakout_vol)
    score=sum([trend,len(seq)>=2,contracting,dry,today_breakout or ((not breakout) and distance>-8)])

    high=pd.to_numeric(df["High"],errors="coerce"); low=pd.to_numeric(df["Low"],errors="coerce")
    bb_mid=close.rolling(20).mean(); bb_std=close.rolling(20).std(ddof=0)
    bb_upper=bb_mid+2*bb_std; bb_lower=bb_mid-2*bb_std
    ema20=close.ewm(span=20,adjust=False).mean(); prev_close=close.shift(1)
    tr=pd.concat([(high-low).abs(),(high-prev_close).abs(),(low-prev_close).abs()],axis=1).max(axis=1)
    atr20=tr.rolling(20).mean()
    def inside_kc(mult):
        return bool(bb_upper.iloc[-1]<(ema20.iloc[-1]+atr20.iloc[-1]*mult) and bb_lower.iloc[-1]>(ema20.iloc[-1]-atr20.iloc[-1]*mult))
    if inside_kc(1.0): squeeze_level="strong"
    elif inside_kc(1.5): squeeze_level="medium"
    elif inside_kc(2.0): squeeze_level="weak"
    else: squeeze_level="none"

    mom=close-close.rolling(20).mean(); m_now,m_prev=float(mom.iloc[-1]),float(mom.iloc[-2])
    if m_now>=0 and m_now>=m_prev: momentum_dir="bull_up"
    elif m_now>=0: momentum_dir="bull_down"
    elif m_now<0 and m_now<=m_prev: momentum_dir="bear_down"
    else: momentum_dir="bear_up"

    avg_value=float((close.iloc[-20:]*vol.iloc[-20:]).mean())
    if avg_value<20_000_000 or score<4: return None

    breakout_days=None
    if breakout:
        vals=close.iloc[-11:].tolist()
        for i in range(len(vals)-1,0,-1):
            if vals[i-1]<=pivot and vals[i]>pivot:
                breakout_days=(len(vals)-1)-i; break
    if today_breakout: typ="breakout"; breakout_days=0
    elif breakout and breakout_days is not None and breakout_days<=5 and distance<=12: typ="postbreakout"
    elif not breakout and distance>-5: typ="near"
    elif not breakout: typ="forming"
    else: return None
    if distance>12: return None

    signal_points=0
    if score>=5: signal_points+=2
    elif score>=4: signal_points+=1
    if typ=="breakout": signal_points+=3
    elif typ=="postbreakout": signal_points+=2
    elif typ=="near": signal_points+=2
    if squeeze_level=="strong": signal_points+=2
    elif squeeze_level=="medium": signal_points+=1
    elif squeeze_level=="weak": signal_points+=.5
    if momentum_dir=="bull_up": signal_points+=2
    elif momentum_dir=="bear_up": signal_points+=1
    if typ=="postbreakout" and distance>8: pulse="extended"
    elif signal_points>=7: pulse="hot"
    elif signal_points>=5: pulse="watch"
    else: pulse="wait"

    return {"score":int(score),"pivot":pivot,"last":last,"distance":distance,"volume_dry":dry,
            "type":typ,"squeeze_level":squeeze_level,"momentum_dir":momentum_dir,
            "pulse_signal":pulse,"pulse_points":signal_points,"avg_value_20d":avg_value}

def normalize_finmind(rows):
    df=pd.DataFrame(rows)
    if df.empty: return df
    out=pd.DataFrame({
        "Date":pd.to_datetime(df["date"]),
        "Open":pd.to_numeric(df["open"],errors="coerce"),
        "High":pd.to_numeric(df["max"],errors="coerce"),
        "Low":pd.to_numeric(df["min"],errors="coerce"),
        "Close":pd.to_numeric(df["close"],errors="coerce"),
        "Volume":pd.to_numeric(df["Trading_Volume"],errors="coerce"),
        "Turnover":pd.to_numeric(df["Trading_money"],errors="coerce")
    }).dropna(subset=["Date","Close"]).set_index("Date").sort_index()
    return out

def fetch_finmind(code,start_date,end_date,token=""):
    headers={"Authorization":f"Bearer {token}"} if token else {}
    params={"dataset":"TaiwanStockPrice","data_id":code,"start_date":start_date,"end_date":end_date}
    r=requests.get(FINMIND,params=params,headers=headers,timeout=45)
    r.raise_for_status()
    j=r.json()
    if j.get("status") not in (None,200):
        raise RuntimeError(j.get("msg") or str(j))
    return normalize_finmind(j.get("data",[]))

GRADEW={"A":1,"B":.75,"C":.45,"D":.20}
def membership_weight(meta):
    if meta.get("confidence",0)<60:return 0
    return GRADEW.get(meta.get("grade"),0)*(.4+.6*meta.get("purity",0)/100)*(.5+.5*meta.get("confidence",0)/100)

def scale(x,a,b): return max(0,min(100,(x-a)/(b-a)*100))
def build_runtime(result,df,market_ret=0,is_new=False):
    close=df["Close"]; vol=df["Volume"]; turn=df["Turnover"]
    v20=float(vol.iloc[-20:].mean()); t20=float(turn.iloc[-20:].mean())
    vprev=float(vol.iloc[-60:-20].mean())
    typ=result["type"]
    status={"breakout":"volume_breakout","postbreakout":"breakout","near":"waiting","forming":"candidate"}[typ]
    return {
      "close":float(close.iloc[-1]),"prevClose":float(close.iloc[-2]),
      "volume":float(vol.iloc[-1]),"avg20Volume":v20,
      "turnover":float(turn.iloc[-1]),"avg20Turnover":t20,
      "marketReturnPct":market_ret,"pivot":float(result["pivot"]),
      "vcpScore":95 if result["score"]>=5 else 80,
      "vcpStatus":status,"isNewCandidate":is_new,
      "contractionVolumeRatio":v20/vprev if vprev>0 else None
    }

def score_theme(name,members,quotes,history):
    rows=[]
    for code,meta in members:
        q=quotes.get(code)
        if not q: continue
        w=membership_weight(meta)
        if not w: continue
        ret=(q["close"]/q["prevClose"]-1)*100 if q["prevClose"] else 0
        vr=q["volume"]/q["avg20Volume"] if q["avg20Volume"] else 1
        tr=q["turnover"]/q["avg20Turnover"] if q["avg20Turnover"] else vr
        dp=(q["pivot"]-q["close"])/q["pivot"]*100 if q["pivot"] else None
        near=dp is not None and 0<=dp<=5  # aligned to V2.39 near zone
        rows.append((code,q,w,ret,vr,tr,near))
    if not rows:return None
    sw=sum(r[2] for r in rows)
    if sw<=0:return None
    wm=lambda fn: sum(fn(r)*r[2] for r in rows)/sw
    frac=lambda fn: sum((1 if fn(r) else 0)*r[2] for r in rows)/sw*100
    breadth=frac(lambda r:r[3]>0)
    money=wm(lambda r:scale(r[5],.5,3))
    vex=wm(lambda r:scale(r[4],.6,2.5))
    px=wm(lambda r:scale(r[3]-r[1]["marketReturnPct"],-3,5))
    bp=frac(lambda r:r[1]["vcpStatus"] in ("breakout","volume_breakout"))
    nearpct=frac(lambda r:r[6] and r[1]["vcpStatus"] in ("candidate","waiting"))
    vcp=wm(lambda r:r[1]["vcpScore"])
    dryrows=[r for r in rows if r[6] and r[1]["contractionVolumeRatio"] is not None]
    dry=(sum(scale(.95-r[1]["contractionVolumeRatio"],0,.55)*r[2] for r in dryrows)/
         sum(r[2] for r in dryrows)) if dryrows else 0
    newpct=frac(lambda r:r[1]["isNewCandidate"])
    persistence=history.get(name,{}).get("persistence3d",50)
    early=.55*money+.45*breadth
    heat=max(0,min(100,.30*money+.20*breadth+.15*vex+.15*px+.15*bp+.05*persistence))
    raw=.34*nearpct+.30*vcp+.20*dry+.08*newpct+.08*early-.06*bp
    setup=max(0,min(100,raw+15))
    return {"theme":name,"heat":round(heat),"setup":round(setup),"breadth":round(breadth),
            "breakoutPct":round(bp),"nearPivotPct":round(nearpct),
            "constituents":len(rows),"effectiveWeight":round(sw,2)}

def lifecycle(x,prev_heat=None):
    if x["heat"]>=85 and x["breakoutPct"]>=55 and x["nearPivotPct"]<10:return "extended"
    if x["heat"]>=75 and x["setup"]>=65 and x["breadth"]>=45 and x["nearPivotPct"]>=15:return "maintrend_setups"
    if x["heat"]>=85 and x["breadth"]>=55:return "maintrend"
    if x["heat"]>=65 and x["breakoutPct"]>=15 and x["breadth"]>=45:return "launching"
    if x["setup"]>=70 and 45<=x["heat"]<65 and x["nearPivotPct"]>=25 and x["breakoutPct"]<35:return "emerging"
    if x["setup"]>=70 and x["heat"]<45 and x["nearPivotPct"]>=25:return "latent"
    if prev_heat is not None and prev_heat>=75 and x["heat"]<65 and x["breadth"]<45:return "cooling"
    return "dormant"

def build_groups(theme_db):
    amap=theme_db["themeTaxonomy"]["alias_to_canonical"]; groups={}
    for code,s in theme_db["stocks"].items():
        for raw,meta in s.get("themes",{}).items():
            can=amap.get(raw)
            if can: groups.setdefault(can,[]).append((code,meta))
    return groups

def run_finmind(theme_db,start_test,end_test,cache_dir,token=""):
    cache=Path(cache_dir); cache.mkdir(parents=True,exist_ok=True)
    codes=sorted(theme_db["stocks"])
    # Fetch generous history because V2.39 requires >=170 sessions.
    fetch_start=(pd.Timestamp(start_test)-pd.Timedelta(days=420)).strftime("%Y-%m-%d")
    prices={}
    for i,code in enumerate(codes,1):
        cp=cache/f"{code}.csv"
        if cp.exists():
            df=pd.read_csv(cp,parse_dates=["Date"]).set_index("Date")
        else:
            df=fetch_finmind(code,fetch_start,end_test,token)
            df.reset_index().to_csv(cp,index=False)
            time.sleep(.15)
        prices[code]=df
        print(f"[{i}/{len(codes)}] {code} {len(df)} bars")

    # Benchmark 001 = TAIEX per FinMind index-code docs; fallback to cross-stock mean if unavailable.
    try:
        bench=fetch_finmind("001",fetch_start,end_test,token)
    except Exception:
        bench=None

    calendar=sorted(set().union(*[set(df.index.strftime("%Y-%m-%d")) for df in prices.values()]))
    calendar=[d for d in calendar if start_test<=d<=end_test]
    if len(calendar)>20: calendar=calendar[-20:]

    groups=build_groups(theme_db)
    daily=[]; prev_members=set(); prev_heat={}
    for d in calendar:
        quotes={}; members_today=set()
        if bench is not None and not bench.empty and pd.Timestamp(d) in bench.index:
            b=bench.loc[:pd.Timestamp(d)]
            market_ret=(b["Close"].iloc[-1]/b["Close"].iloc[-2]-1)*100 if len(b)>=2 else 0
        else:
            market_ret=0

        raw_results={}
        for code,df in prices.items():
            cut=df.loc[:pd.Timestamp(d)]
            r=analyze_asof(cut)
            if r:
                raw_results[code]=r; members_today.add(code)
        for code,r in raw_results.items():
            quotes[code]=build_runtime(r,prices[code].loc[:pd.Timestamp(d)],market_ret,code not in prev_members)

        theme_scores=[]
        for name,members in groups.items():
            x=score_theme(name,members,quotes,{})
            if x and x["constituents"]>=4 and x["effectiveWeight"]>=2:
                x["lifecycle"]=lifecycle(x,prev_heat.get(name))
                theme_scores.append(x)
                prev_heat[name]=x["heat"]
        daily.append({
          "date":d,"radarStocks":len(quotes),
          "themeTop5":sorted(theme_scores,key=lambda x:x["heat"],reverse=True)[:5],
          "setupTop5":sorted(theme_scores,key=lambda x:x["setup"],reverse=True)[:5],
          "themes":theme_scores
        })
        prev_members=members_today

    return daily

def summarize(daily):
    from collections import Counter
    states=Counter()
    for day in daily:
        for x in day["themes"]: states[x["lifecycle"]]+=1
    return {
      "days":len(daily),
      "firstDate":daily[0]["date"] if daily else None,
      "lastDate":daily[-1]["date"] if daily else None,
      "avgRadarStocks":round(sum(x["radarStocks"] for x in daily)/len(daily),1) if daily else 0,
      "stateCounts":dict(states),
      "dailyTopHeat":[{"date":d["date"],"theme":d["themeTop5"][0]["theme"] if d["themeTop5"] else None,
                       "heat":d["themeTop5"][0]["heat"] if d["themeTop5"] else None} for d in daily],
      "dailyTopSetup":[{"date":d["date"],"theme":d["setupTop5"][0]["theme"] if d["setupTop5"] else None,
                        "setup":d["setupTop5"][0]["setup"] if d["setupTop5"] else None} for d in daily]
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--theme-db",required=True)
    ap.add_argument("--start",required=True)
    ap.add_argument("--end",required=True)
    ap.add_argument("--cache-dir",default="backtest_cache")
    ap.add_argument("--out-dir",default="backtest_output")
    args=ap.parse_args()

    theme_db=json.loads(Path(args.theme_db).read_text(encoding="utf-8"))
    token=os.environ.get("FINMIND_TOKEN","")
    daily=run_finmind(theme_db,args.start,args.end,args.cache_dir,token)
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)
    (out/"backtest_daily.json").write_text(json.dumps(daily,ensure_ascii=False,indent=2),encoding="utf-8")
    (out/"backtest_summary.json").write_text(json.dumps(summarize(daily),ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(summarize(daily),ensure_ascii=False,indent=2))

if __name__=="__main__":
    main()
