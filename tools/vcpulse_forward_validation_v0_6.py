"""
VCPulse Forward Validation v0.6
Reads v0.5 backtest_daily.json and measures whether high Setup precedes later Heat/lifecycle improvement.
No score formula changes. No production writes.
"""

from __future__ import annotations
import argparse, json
from pathlib import Path
from collections import Counter, defaultdict

LIFE_RANK = {
    "dormant":0, "cooling":0, "latent":1, "emerging":2,
    "launching":3, "maintrend_setups":4, "maintrend":5, "extended":6
}

def theme_map(day):
    return {x["theme"]: x for x in day.get("themes", [])}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--daily", required=True)
    ap.add_argument("--out-dir", default="forward_validation_output")
    ap.add_argument("--setup-threshold", type=float, default=70)
    ap.add_argument("--heat-max", type=float, default=45)
    args=ap.parse_args()

    daily=json.loads(Path(args.daily).read_text(encoding="utf-8"))
    maps=[theme_map(d) for d in daily]
    horizons=(5,10,20)
    events=[]

    for i,day in enumerate(daily):
        for theme,x in maps[i].items():
            setup=x.get("setup",0)
            heat=x.get("heat",0)
            # Primary early-setup cohort: guarded Setup >= threshold while Heat is still below heat-max.
            if setup < args.setup_threshold or heat >= args.heat_max:
                continue
            ev={
                "date":day["date"], "theme":theme,
                "setup":setup, "setupRaw":x.get("setupRaw"),
                "setupEffectiveN":x.get("setupEffectiveN"),
                "heat0":heat, "lifecycle0":x.get("lifecycle"),
                "nearPivotPct":x.get("nearPivotPct"),
                "radarN":x.get("setupRadarConstituents"),
                "forward":{}
            }
            for h in horizons:
                j=i+h
                if j >= len(daily):
                    ev["forward"][str(h)]={"available":False}
                    continue
                y=maps[j].get(theme)
                if not y:
                    ev["forward"][str(h)]={"available":False}
                    continue
                heat_h=y.get("heat",0)
                ev["forward"][str(h)]={
                    "available":True,
                    "date":daily[j]["date"],
                    "heat":heat_h,
                    "heatChange":heat_h-heat,
                    "setup":y.get("setup"),
                    "lifecycle":y.get("lifecycle"),
                    "cross45":heat_h>=45,
                    "cross65":heat_h>=65,
                    "cross75":heat_h>=75,
                    "heatUp10":heat_h-heat>=10,
                    "heatUp20":heat_h-heat>=20,
                    "lifecycleImproved":LIFE_RANK.get(y.get("lifecycle"),0) > LIFE_RANK.get(x.get("lifecycle"),0)
                }
            events.append(ev)

    summary={
        "version":"v0.6-forward-validation",
        "modelChanged":False,
        "sourceDays":len(daily),
        "cohortRule":f"guarded Setup >= {args.setup_threshold:g} and Heat < {args.heat_max:g}",
        "eventCount":len(events),
        "horizons":{}
    }

    for h in horizons:
        vals=[e["forward"][str(h)] for e in events if e["forward"][str(h)].get("available")]
        n=len(vals)
        def pct(pred):
            return round(sum(1 for v in vals if pred(v))/n*100,1) if n else None
        summary["horizons"][str(h)]={
            "availableEvents":n,
            "avgHeatChange":round(sum(v["heatChange"] for v in vals)/n,2) if n else None,
            "medianHeatChange":sorted(v["heatChange"] for v in vals)[n//2] if n else None,
            "heatUp10Pct":pct(lambda v:v["heatUp10"]),
            "heatUp20Pct":pct(lambda v:v["heatUp20"]),
            "cross45Pct":pct(lambda v:v["cross45"]),
            "cross65Pct":pct(lambda v:v["cross65"]),
            "cross75Pct":pct(lambda v:v["cross75"]),
            "lifecycleImprovedPct":pct(lambda v:v["lifecycleImproved"])
        }

    # Theme-level aggregation to expose concentration/overfitting risk.
    by_theme=defaultdict(list)
    for e in events: by_theme[e["theme"]].append(e)
    summary["eventsByTheme"]={k:len(v) for k,v in sorted(by_theme.items(), key=lambda kv:(-len(kv[1]),kv[0]))}
    summary["limitations"]=[
        "This validates future Heat/lifecycle behavior, not stock investment returns.",
        "Overlapping daily events are not statistically independent.",
        "A 40-trading-day sample is descriptive and too short for production claims.",
        "Use a longer out-of-sample period before changing model weights."
    ]

    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)
    (out/"forward_events.json").write_text(json.dumps(events,ensure_ascii=False,indent=2),encoding="utf-8")
    (out/"forward_summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(summary,ensure_ascii=False,indent=2))

if __name__=="__main__":
    main()
