"""
VCPulse Theme Historical Runner v0.5 Setup Sample Guard
Modes:
  1) finmind: fetch historical OHLCV and recompute V2.39 as-of each day
  2) snapshots: read historical screening.json snapshots exported from GitHub history
Outputs:
  backtest_daily.json
  backtest_summary.json
  coverage_audit.json
  universe_diagnostics.json

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


def build_market_runtime(df, market_ret=0):
    """Runtime quote for Theme Heat. Does not require the stock to pass VCP radar."""
    cut=df.dropna(subset=["Close"]).copy()
    if len(cut)<60:
        return None
    close=cut["Close"].astype(float)
    vol=cut["Volume"].fillna(0).astype(float)
    turn=cut["Turnover"].fillna(0).astype(float)
    if len(close)<2:
        return None
    v20=float(vol.iloc[-20:].mean())
    t20=float(turn.iloc[-20:].mean())
    return {
      "close":float(close.iloc[-1]),
      "prevClose":float(close.iloc[-2]),
      "volume":float(vol.iloc[-1]),
      "avg20Volume":v20,
      "turnover":float(turn.iloc[-1]),
      "avg20Turnover":t20,
      "marketReturnPct":market_ret
    }

def score_theme_split(name,members,market_quotes,radar_quotes,history):
    """
    v0.4:
      Heat universe = all valid effective members with market quotes.
      Setup universe = V2.39 radar members only.
    Keeps V2.6 score weights unchanged.
    """
    heat_rows=[]
    setup_rows=[]

    for code,meta in members:
        w=membership_weight(meta)
        if not w:
            continue

        mq=market_quotes.get(code)
        if mq:
            ret=(mq["close"]/mq["prevClose"]-1)*100 if mq["prevClose"] else 0
            vr=mq["volume"]/mq["avg20Volume"] if mq["avg20Volume"] else 1
            tr=mq["turnover"]/mq["avg20Turnover"] if mq["avg20Turnover"] else vr
            rq=radar_quotes.get(code)
            is_breakout=bool(rq and rq["vcpStatus"] in ("breakout","volume_breakout"))
            heat_rows.append((code,mq,w,ret,vr,tr,is_breakout))

        rq=radar_quotes.get(code)
        if rq:
            dp=(rq["pivot"]-rq["close"])/rq["pivot"]*100 if rq["pivot"] else None
            near=dp is not None and 0<=dp<=5
            setup_rows.append((code,rq,w,near))

    if not heat_rows:
        return None

    hsw=sum(r[2] for r in heat_rows)
    if hsw<=0:
        return None
    hwm=lambda fn: sum(fn(r)*r[2] for r in heat_rows)/hsw
    hfrac=lambda fn: sum((1 if fn(r) else 0)*r[2] for r in heat_rows)/hsw*100

    breadth=hfrac(lambda r:r[3]>0)
    money=hwm(lambda r:scale(r[5],.5,3))
    vex=hwm(lambda r:scale(r[4],.6,2.5))
    px=hwm(lambda r:scale(r[3]-r[1]["marketReturnPct"],-3,5))
    bp=hfrac(lambda r:r[6])
    persistence=history.get(name,{}).get("persistence3d",50)
    heat=max(0,min(100,.30*money+.20*breadth+.15*vex+.15*px+.15*bp+.05*persistence))

    # Setup remains VCP-radar based.
    if setup_rows:
        ssw=sum(r[2] for r in setup_rows)
        swm=lambda fn: sum(fn(r)*r[2] for r in setup_rows)/ssw
        sfrac=lambda fn: sum((1 if fn(r) else 0)*r[2] for r in setup_rows)/ssw*100
        nearpct=sfrac(lambda r:r[3] and r[1]["vcpStatus"] in ("candidate","waiting"))
        vcp=swm(lambda r:r[1]["vcpScore"])
        dryrows=[r for r in setup_rows if r[3] and r[1]["contractionVolumeRatio"] is not None]
        dry=(sum(scale(.95-r[1]["contractionVolumeRatio"],0,.55)*r[2] for r in dryrows)/
             sum(r[2] for r in dryrows)) if dryrows else 0
        newpct=sfrac(lambda r:r[1]["isNewCandidate"])
        setup_bp=sfrac(lambda r:r[1]["vcpStatus"] in ("breakout","volume_breakout"))
        early=.55*money+.45*breadth
        raw=.34*nearpct+.30*vcp+.20*dry+.08*newpct+.08*early-.06*setup_bp
        setup_raw=max(0,min(100,raw+15))

        # v0.5 Sample Guard:
        # Use Kish effective sample size so one highly weighted stock cannot
        # represent a whole theme. Shrink sparse-sample Setup toward neutral 50
        # instead of hard-blocking early signals.
        weights=[r[2] for r in setup_rows]
        denom=sum(w*w for w in weights)
        setup_neff=(sum(weights)**2/denom) if denom>0 else 0
        sample_factor=math.sqrt(min(1.0, setup_neff/4.0))
        setup=50+(setup_raw-50)*sample_factor
        setup=max(0,min(100,setup))
    else:
        nearpct=vcp=dry=newpct=setup_bp=0
        setup_raw=0
        setup_neff=0
        sample_factor=0
        setup=0

    return {
        "theme":name,
        "heat":round(heat),
        "setup":round(setup),
        "setupRaw":round(setup_raw),
        "setupEffectiveN":round(setup_neff,2),
        "setupSampleFactor":round(sample_factor,3),
        "breadth":round(breadth),
        "breakoutPct":round(bp),
        "nearPivotPct":round(nearpct),
        "constituents":len(heat_rows),
        "effectiveWeight":round(hsw,2),
        "setupRadarConstituents":len(setup_rows),
        "setupEffectiveWeight":round(sum(r[2] for r in setup_rows),2) if setup_rows else 0
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


def stock_canonical_memberships(theme_db):
    amap=theme_db["themeTaxonomy"]["alias_to_canonical"]
    out={}
    for code,s in theme_db["stocks"].items():
        cans=[]
        for raw,meta in s.get("themes",{}).items():
            can=amap.get(raw)
            if not can:
                continue
            w=membership_weight(meta)
            cans.append({
                "canonicalTheme":can,
                "rawTheme":raw,
                "grade":meta.get("grade"),
                "purity":meta.get("purity"),
                "confidence":meta.get("confidence"),
                "effectiveWeight":round(w,4)
            })
        out[code]=cans
    return out

def theme_gate_diagnostic(name,members,quotes):
    """Explain why a canonical theme did or did not qualify for ranking on this date."""
    total_members=len(members)
    active=[]
    for code,meta in members:
        q=quotes.get(code)
        if not q:
            continue
        w=membership_weight(meta)
        if w<=0:
            continue
        active.append((code,w))
    active_count=len(active)
    effective_weight=sum(w for _,w in active)

    reasons=[]
    if active_count < 4:
        reasons.append("active_constituents_lt_4")
    if effective_weight < 2:
        reasons.append("effective_weight_lt_2")

    return {
        "theme":name,
        "totalDbMembers":total_members,
        "activeRadarMembers":active_count,
        "activeRadarCodes":[code for code,_ in active],
        "effectiveWeight":round(effective_weight,2),
        "eligible":not reasons,
        "blockedBy":reasons
    }

def build_coverage_audit(daily):
    from collections import Counter, defaultdict
    stock_days=Counter()
    stock_types=defaultdict(Counter)
    theme_block_reasons=Counter()
    theme_block_days=Counter()
    empty_days=[]
    for day in daily:
        if not day.get("themes"):
            empty_days.append(day["date"])
        for s in day.get("radarDetails",[]):
            stock_days[s["code"]]+=1
            stock_types[s["code"]][s["type"]]+=1
        for g in day.get("themeGateDiagnostics",[]):
            active_n=g.get("activeMarketMembers",g.get("activeRadarMembers",0))
            if not g["eligible"] and active_n>0:
                theme_block_days[g["theme"]]+=1
                for r in g["blockedBy"]:
                    theme_block_reasons[r]+=1

    recurring=[
        {"code":code,"radarDays":days,"typeCounts":dict(stock_types[code])}
        for code,days in stock_days.most_common()
    ]
    return {
        "days":len(daily),
        "emptyThemeDays":empty_days,
        "emptyThemeDayCount":len(empty_days),
        "recurringRadarStocks":recurring,
        "blockedThemeDayCounts":dict(theme_block_days.most_common()),
        "blockedReasonCounts":dict(theme_block_reasons),
        "scopeWarning":"This audit covers only stocks already present in the current 116-stock theme DB. It does not identify radar stocks outside the DB."
    }

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
    if len(calendar)>40:
        calendar=calendar[-40:]
    if len(calendar)<40:
        print(f"WARNING: requested validation produced only {len(calendar)} trading days; target is 40.")

    groups=build_groups(theme_db)
    stock_memberships=stock_canonical_memberships(theme_db)
    daily=[]; prev_members=set(); prev_heat={}
    for d in calendar:
        quotes={}; market_quotes={}; members_today=set()
        if bench is not None and not bench.empty and pd.Timestamp(d) in bench.index:
            b=bench.loc[:pd.Timestamp(d)]
            market_ret=(b["Close"].iloc[-1]/b["Close"].iloc[-2]-1)*100 if len(b)>=2 else 0
        else:
            market_ret=0

        # Heat universe: every DB stock with sufficient as-of-date market history.
        for code,df in prices.items():
            cut=df.loc[:pd.Timestamp(d)]
            mq=build_market_runtime(cut,market_ret)
            if mq:
                market_quotes[code]=mq

        # Setup universe: only stocks that pass the formal V2.39 radar.
        raw_results={}
        for code,df in prices.items():
            cut=df.loc[:pd.Timestamp(d)]
            r=analyze_asof(cut)
            if r:
                raw_results[code]=r; members_today.add(code)
        for code,r in raw_results.items():
            quotes[code]=build_runtime(r,prices[code].loc[:pd.Timestamp(d)],market_ret,code not in prev_members)

        theme_scores=[]
        gate_diags=[]
        for name,members in groups.items():
            # Ranking eligibility is based on the full effective theme membership,
            # not on how many members happened to enter VCP radar today.
            full_gate=theme_gate_diagnostic(name,members,market_quotes)
            full_gate["activeMarketMembers"]=full_gate.pop("activeRadarMembers")
            full_gate["activeMarketCodes"]=full_gate.pop("activeRadarCodes")
            full_gate["setupRadarMembers"]=sum(
                1 for code,meta in members
                if code in quotes and membership_weight(meta)>0
            )
            gate_diags.append(full_gate)

            x=score_theme_split(name,members,market_quotes,quotes,{})
            if x and x["constituents"]>=4 and x["effectiveWeight"]>=2:
                x["lifecycle"]=lifecycle(x,prev_heat.get(name))
                theme_scores.append(x)
                prev_heat[name]=x["heat"]

        radar_details=[]
        for code,r in raw_results.items():
            q=quotes[code]
            radar_details.append({
                "code":code,
                "name":theme_db["stocks"].get(code,{}).get("name",""),
                "type":r["type"],
                "vcpScore5":r["score"],
                "pivot":round(float(r["pivot"]),2),
                "last":round(float(r["last"]),2),
                "distancePct":round(float(r["distance"]),2),
                "volumeDry":bool(r["volume_dry"]),
                "squeezeLevel":r["squeeze_level"],
                "pulseSignal":r["pulse_signal"],
                "isNewCandidate":bool(q["isNewCandidate"]),
                "canonicalMemberships":stock_memberships.get(code,[])
            })
        radar_details.sort(key=lambda x:(x["type"],-x["vcpScore5"],abs(x["distancePct"])))

        daily.append({
          "date":d,
          "marketUniverseStocks":len(market_quotes),
          "radarStocks":len(quotes),
          "radarStockCodes":[x["code"] for x in radar_details],
          "radarDetails":radar_details,
          "themeGateDiagnostics":gate_diags,
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
      "targetDays":40,
      "targetDaysMet":len(daily)>=40,
      "firstDate":daily[0]["date"] if daily else None,
      "lastDate":daily[-1]["date"] if daily else None,
      "avgRadarStocks":round(sum(x["radarStocks"] for x in daily)/len(daily),1) if daily else 0,
      "stateCounts":dict(states),
      "dailyTopHeat":[{"date":d["date"],"theme":d["themeTop5"][0]["theme"] if d["themeTop5"] else None,
                       "heat":d["themeTop5"][0]["heat"] if d["themeTop5"] else None} for d in daily],
      "dailyTopSetup":[{"date":d["date"],"theme":d["setupTop5"][0]["theme"] if d["setupTop5"] else None,
                        "setup":d["setupTop5"][0]["setup"] if d["setupTop5"] else None,
                        "setupRaw":d["setupTop5"][0].get("setupRaw") if d["setupTop5"] else None,
                        "setupEffectiveN":d["setupTop5"][0].get("setupEffectiveN") if d["setupTop5"] else None} for d in daily],
      "setupGuardStats":{
          "rawGe70":sum(1 for d in daily for x in d["themes"] if x.get("setupRaw",x["setup"])>=70),
          "guardedGe70":sum(1 for d in daily for x in d["themes"] if x["setup"]>=70),
          "rawGe80":sum(1 for d in daily for x in d["themes"] if x.get("setupRaw",x["setup"])>=80),
          "guardedGe80":sum(1 for d in daily for x in d["themes"] if x["setup"]>=80),
          "oneRadarRawGe80":sum(1 for d in daily for x in d["themes"] if x.get("setupRadarConstituents")==1 and x.get("setupRaw",x["setup"])>=80),
          "oneRadarGuardedGe80":sum(1 for d in daily for x in d["themes"] if x.get("setupRadarConstituents")==1 and x["setup"]>=80)
      }
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
    summary=summarize(daily)
    audit=build_coverage_audit(daily)
    (out/"backtest_summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    (out/"coverage_audit.json").write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding="utf-8")
    diagnostics={
        "version":"v0.5",
        "heatUniverse":"all valid effective members in each canonical theme",
        "setupUniverse":"V2.39 radar members only",
        "setupSampleGuard":"Kish effective N; factor=sqrt(min(1,n_eff/4)); shrink Setup toward neutral 50",
        "targetTradingDays":40,
        "actualTradingDays":len(daily),
        "targetDaysMet":len(daily)>=40,
        "productionTouched":False
    }
    (out/"universe_diagnostics.json").write_text(json.dumps(diagnostics,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"summary":summary,"coverageAudit":audit,"diagnostics":diagnostics},ensure_ascii=False,indent=2))

if __name__=="__main__":
    main()
