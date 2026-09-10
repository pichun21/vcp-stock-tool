"""
VCPulse Matched-Control Validation v1.0

Goal
----
Test whether the return advantage of "high-Setup theme + VCP stock" remains
after matching each signal observation to a same-day ordinary VCP observation
with similar observable VCP characteristics.

Matching variables available in the frozen historical output:
- VCP score (vcpScore5)
- VCP type (breakout/postbreakout/near/forming)
- absolute distance to pivot
- volume-dry flag
- squeeze level

Important limitation:
Historical market cap is not available in the current frozen dataset, so this
version does NOT claim market-cap matching. It is a stricter matched-control
test using fields actually present in the source data.

No model weights are changed.
"""

from __future__ import annotations
import argparse, json, math
from pathlib import Path
from collections import defaultdict
import pandas as pd

TYPE_PENALTY = {
    ("breakout","postbreakout"): 1.0,
    ("postbreakout","breakout"): 1.0,
    ("near","forming"): 1.0,
    ("forming","near"): 1.0,
}
SQ_RANK={"none":0,"weak":1,"medium":2,"strong":3}

def theme_map(day):
    return {x["theme"]:x for x in day.get("themes",[])}

def stock_theme_set(detail):
    return {
        m.get("canonicalTheme")
        for m in detail.get("canonicalMemberships",[])
        if m.get("effectiveWeight",0)>0 and m.get("canonicalTheme")
    }

def median(vals):
    if not vals:return None
    s=sorted(vals); n=len(s)
    return s[n//2] if n%2 else (s[n//2-1]+s[n//2])/2

def summarize(rows,horizons):
    out={"n":len(rows)}
    for h in horizons:
        vals=[r[f"ret{h}"] for r in rows if r.get(f"ret{h}") is not None]
        out[str(h)]={
            "n":len(vals),
            "avgReturnPct":round(sum(vals)/len(vals),2) if vals else None,
            "medianReturnPct":round(median(vals),2) if vals else None,
            "positivePct":round(sum(v>0 for v in vals)/len(vals)*100,1) if vals else None,
        }
    return out

def match_distance(a,b):
    # Prefer identical VCP type. Near/forming and breakout/postbreakout are
    # allowed but penalized; unrelated types are strongly penalized.
    if a["type"]==b["type"]:
        type_cost=0
    else:
        type_cost=TYPE_PENALTY.get((a["type"],b["type"]),4.0)

    score_cost=abs(a["vcpScore5"]-b["vcpScore5"])*1.5
    pivot_cost=abs(abs(a["distancePct"])-abs(b["distancePct"]))*0.35
    dry_cost=0 if a["volumeDry"]==b["volumeDry"] else 1.5
    sq_cost=abs(SQ_RANK.get(a["squeezeLevel"],0)-SQ_RANK.get(b["squeezeLevel"],0))*0.75
    return type_cost+score_cost+pivot_cost+dry_cost+sq_cost

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--daily",required=True)
    ap.add_argument("--cache-dir",required=True)
    ap.add_argument("--out-dir",default="matched_control_output")
    ap.add_argument("--setup-threshold",type=float,default=70)
    ap.add_argument("--heat-max",type=float,default=45)
    ap.add_argument("--cooldown",type=int,default=5)
    ap.add_argument("--max-match-distance",type=float,default=5.0)
    args=ap.parse_args()

    daily=json.loads(Path(args.daily).read_text(encoding="utf-8"))
    maps=[theme_map(d) for d in daily]
    horizons=(5,10,20)

    # Frozen independent event definition.
    events=[]; last={}
    for i,d in enumerate(daily):
        for theme,x in maps[i].items():
            if x.get("setup",0)<args.setup_threshold or x.get("heat",0)>=args.heat_max:
                continue
            if theme in last and i-last[theme] <= args.cooldown:
                continue
            last[theme]=i
            events.append((i,d["date"],theme,x))

    prices={}
    for p in Path(args.cache_dir).glob("*.csv"):
        try:
            prices[p.stem]=pd.read_csv(p,parse_dates=["Date"]).set_index("Date").sort_index()
        except Exception:
            pass

    def returns(code,date0):
        df=prices.get(code)
        if df is None:return {}
        ts=pd.Timestamp(date0)
        if ts not in df.index:return {}
        loc=df.index.get_loc(ts)
        if not isinstance(loc,int):return {}
        p0=float(df.iloc[loc]["Close"])
        out={}
        for h in horizons:
            out[f"ret{h}"]=None if loc+h>=len(df) else (float(df.iloc[loc+h]["Close"])/p0-1)*100
        return out

    pairs=[]
    unmatched=[]
    used_control_by_day=defaultdict(set)

    for i,date0,theme,x in events:
        details=daily[i].get("radarDetails",[])
        active={
            t for t,y in maps[i].items()
            if y.get("setup",0)>=args.setup_threshold and y.get("heat",0)<args.heat_max
        }
        signals=[s for s in details if theme in stock_theme_set(s)]
        controls=[s for s in details if stock_theme_set(s).isdisjoint(active)]

        for s in signals:
            candidates=[]
            for c in controls:
                if c["code"] in used_control_by_day[date0]:
                    continue
                dist=match_distance(s,c)
                candidates.append((dist,c))
            candidates.sort(key=lambda z:z[0])
            if not candidates or candidates[0][0]>args.max_match_distance:
                unmatched.append({
                    "date":date0,"theme":theme,"signalCode":s["code"],
                    "bestDistance":round(candidates[0][0],3) if candidates else None
                })
                continue

            dist,c=candidates[0]
            used_control_by_day[date0].add(c["code"])
            row={
                "date":date0,"theme":theme,
                "signalCode":s["code"],"controlCode":c["code"],
                "matchDistance":round(dist,3),
                "signalFeatures":{
                    "type":s["type"],"vcpScore5":s["vcpScore5"],
                    "distancePct":s["distancePct"],"volumeDry":s["volumeDry"],
                    "squeezeLevel":s["squeezeLevel"]
                },
                "controlFeatures":{
                    "type":c["type"],"vcpScore5":c["vcpScore5"],
                    "distancePct":c["distancePct"],"volumeDry":c["volumeDry"],
                    "squeezeLevel":c["squeezeLevel"]
                }
            }
            sr=returns(s["code"],date0); cr=returns(c["code"],date0)
            for h in horizons:
                row[f"signalRet{h}"]=sr.get(f"ret{h}")
                row[f"controlRet{h}"]=cr.get(f"ret{h}")
                if row[f"signalRet{h}"] is not None and row[f"controlRet{h}"] is not None:
                    row[f"diff{h}"]=row[f"signalRet{h}"]-row[f"controlRet{h}"]
                else:
                    row[f"diff{h}"]=None
            pairs.append(row)

    summary={
        "version":"v1.0-matched-control",
        "modelChanged":False,
        "eventCount":len(events),
        "matchedPairs":len(pairs),
        "unmatchedSignals":len(unmatched),
        "matchRatePct":round(len(pairs)/(len(pairs)+len(unmatched))*100,1) if pairs or unmatched else None,
        "matchingFields":["same trading day","VCP type","VCP score","distance to pivot","volume dry","squeeze level"],
        "notMatched":["historical market cap","sector-neutral exposure","liquidity beyond the scanner's existing minimum"],
        "horizons":{},
        "limitations":[
            "Matching reduces observable VCP-state differences but cannot prove causality.",
            "Historical market cap is not present in the frozen dataset and is not matched.",
            "Current theme membership is projected backward historically, creating possible classification/survivorship bias.",
            "Repeated observations of a stock across separate events are possible.",
            "Returns exclude fees, taxes, slippage, dividends, and execution constraints."
        ]
    }

    for h in horizons:
        vals=[p for p in pairs if p.get(f"diff{h}") is not None]
        diffs=[p[f"diff{h}"] for p in vals]
        sig=[p[f"signalRet{h}"] for p in vals]
        ctl=[p[f"controlRet{h}"] for p in vals]
        summary["horizons"][str(h)]={
            "pairs":len(vals),
            "signalAvgReturnPct":round(sum(sig)/len(sig),2) if sig else None,
            "controlAvgReturnPct":round(sum(ctl)/len(ctl),2) if ctl else None,
            "avgPairedDifferencePctPoints":round(sum(diffs)/len(diffs),2) if diffs else None,
            "medianPairedDifferencePctPoints":round(median(diffs),2) if diffs else None,
            "signalBeatControlPct":round(sum(d>0 for d in diffs)/len(diffs)*100,1) if diffs else None
        }

    out=Path(args.out_dir);out.mkdir(parents=True,exist_ok=True)
    (out/"matched_pairs.json").write_text(json.dumps(pairs,ensure_ascii=False,indent=2),encoding="utf-8")
    (out/"unmatched_signals.json").write_text(json.dumps(unmatched,ensure_ascii=False,indent=2),encoding="utf-8")
    (out/"matched_control_summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(summary,ensure_ascii=False,indent=2))

if __name__=="__main__":
    main()
