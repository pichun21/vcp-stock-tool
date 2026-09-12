#!/usr/bin/env python3
from __future__ import annotations
import argparse,json,statistics
from pathlib import Path
import pandas as pd

WINDOWS=(-10,-5,-3,0,1,3,5,10)

def avg(xs):
    xs=[x for x in xs if x is not None]
    return statistics.mean(xs) if xs else None

def median(xs):
    xs=[x for x in xs if x is not None]
    return statistics.median(xs) if xs else None

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--daily",required=True)
    ap.add_argument("--cache-dir",required=True)
    ap.add_argument("--out-dir",default="alpha23_output")
    args=ap.parse_args()

    daily=json.loads(Path(args.daily).read_text(encoding="utf-8"))
    prices={}
    for p in Path(args.cache_dir).glob("*.csv"):
        try:
            df=pd.read_csv(p,parse_dates=["Date"]).set_index("Date").sort_index()
            prices[p.stem]=df
        except Exception:
            pass

    def stock_rel(code,date,offset):
        df=prices.get(str(code)); t=pd.Timestamp(date)
        if df is None or t not in df.index: return None
        loc=df.index.get_loc(t)
        if not isinstance(loc,int): return None
        j=loc+offset
        if j<0 or j>=len(df): return None
        p0=float(df.iloc[loc]["Close"]); pj=float(df.iloc[j]["Close"])
        return (pj/p0-1)*100 if p0 else None

    def theme_rel(codes,date,offset):
        return avg([stock_rel(c,date,offset) for c in set(codes)])

    events=[]
    prev_top=None
    for i,day in enumerate(daily):
        cur=[x["theme"] for x in day.get("themeTop5",[])]
        gates={x["theme"]:x for x in day.get("themeGateDiagnostics",[]) if x.get("eligible")}
        tmap={x["theme"]:x for x in day.get("themes",[])}
        if i==0:
            prev_top=set(cur)  # left-censored: first-day incumbents are not fresh entries
            continue
        for rank,theme in enumerate(cur,1):
            if theme in prev_top or theme not in gates: continue
            codes=gates[theme].get("activeMarketCodes",[])
            meta=tmap.get(theme,{})
            e={"date":day["date"],"theme":theme,"entryRank":rank,
               "heat":meta.get("heat"),"setup":meta.get("setup"),
               "lifecycle":meta.get("lifecycle"),
               "constituents":len(set(codes))}
            for w in WINDOWS:
                e[f"r{w:+d}"]=0.0 if w==0 else theme_rel(codes,day["date"],w)
            pre=e.get("r-3"); p5=e.get("r+5"); p10=e.get("r+10")
            if pre is not None:
                if pre <= -1 and ((p5 or 0)>0 or (p10 or 0)>0): cls="leading"
                elif pre >= 2 and ((p5 is not None and p5<=0) or (p10 is not None and p10<=0)): cls="lagging"
                else: cls="synchronous/mixed"
            else: cls="insufficient"
            e["timingClass"]=cls
            events.append(e)
        prev_top=set(cur)

    summary={}
    for w in WINDOWS:
        vals=[e[f"r{w:+d}"] for e in events if e.get(f"r{w:+d}") is not None]
        summary[str(w)]={"n":len(vals),"avgPct":round(avg(vals),2) if vals else None,
                         "medianPct":round(median(vals),2) if vals else None,
                         "positivePct":round(sum(v>0 for v in vals)/len(vals)*100,1) if vals else None}

    classes={}
    for c in ("leading","synchronous/mixed","lagging","insufficient"):
        ee=[e for e in events if e["timingClass"]==c]
        classes[c]={"events":len(ee)}
        for w in (1,3,5,10):
            vals=[e[f"r+{w}"] for e in ee if e.get(f"r+{w}") is not None]
            classes[c][f"avgPlus{w}Pct"]=round(avg(vals),2) if vals else None

    by_theme={}
    for theme in sorted({e["theme"] for e in events}):
        ee=[e for e in events if e["theme"]==theme]
        by_theme[theme]={"events":len(ee)}
        for w in (-3,1,3,5,10):
            key=f"r{w:+d}"
            vals=[e[key] for e in ee if e.get(key) is not None]
            by_theme[theme][f"avg{w:+d}Pct"]=round(avg(vals),2) if vals else None

    result={"version":"Alpha23-v0.1","historicalDays":len(daily),"eventCount":len(events),
            "windows":WINDOWS,"summary":summary,"timingClasses":classes,
            "byTheme":by_theme,"events":events,
            "notes":[
                "Fresh entry = in Theme Top5 today and not in Theme Top5 on previous valid historical day.",
                "First historical day is left-censored and excluded from fresh-entry events.",
                "Returns use the event-day active constituents and are rebased to event-day close.",
                "Recent events without enough future bars are excluded only from unavailable horizons.",
                "No Heat/Setup/Purity/Confidence changes."
            ]}
    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)
    (out/"alpha23_event_study.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")

    lines=["# Alpha23 Theme Top5 Entry Event Study","",
           f"- Historical days: {len(daily)}",f"- Fresh Top5 entry events: {len(events)}","",
           "| Window | N | Avg return vs entry | Median | Positive |",
           "|---|---:|---:|---:|---:|"]
    for w in WINDOWS:
        s=summary[str(w)]
        f=lambda x:"-" if x is None else f"{x:.2f}%"
        lines.append(f"| {w:+d} | {s['n']} | {f(s['avgPct'])} | {f(s['medianPct'])} | {f(s['positivePct'])} |")
    lines += ["","## Timing classification"]
    for c,x in classes.items():
        lines.append(f"- {c}: {x['events']} events; +1 {x.get('avgPlus1Pct')}%, +3 {x.get('avgPlus3Pct')}%, +5 {x.get('avgPlus5Pct')}%, +10 {x.get('avgPlus10Pct')}%")
    lines += ["","## Guardrails",
              "- This is a timing diagnostic, not a scoring change.",
              "- Do not tune Theme Heat or membership scales from Alpha23 alone.",
              "- First-day Top5 incumbents are excluded to avoid false fresh-entry signals."]
    (out/"alpha23_event_study.md").write_text("\n".join(lines),encoding="utf-8")
    print(json.dumps({"eventCount":len(events),"summary":summary,"timingClasses":classes},ensure_ascii=False,indent=2))

if __name__=="__main__":
    main()
