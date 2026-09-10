"""
VCPulse Event-Based Forward Validation v0.7

Purpose
-------
Validate whether an early Setup signal is followed by ANY theme Heat expansion
inside the next 5 / 10 / 20 trading days.

This version does NOT change Heat, Setup, lifecycle, V2.6, or production V2.39.
It only changes the validation method.

Primary event rule:
    guarded Setup >= 70 AND Heat < 45

Event de-duplication:
    For the same theme, once an event is created, do not create another event
    for the next 5 trading sessions (cooldown=5).

Forward-window metrics:
    - maximum Heat reached within +1..+H
    - maximum Heat increase versus event-day Heat
    - whether Heat ever crosses 45 / 65 / 75
    - first trading day to cross each threshold
    - whether lifecycle ever improves
"""

from __future__ import annotations
import argparse
import json
from pathlib import Path
from collections import defaultdict

LIFE_RANK = {
    "dormant": 0,
    "cooling": 0,
    "latent": 1,
    "emerging": 2,
    "launching": 3,
    "maintrend_setups": 4,
    "maintrend": 5,
    "extended": 6,
}

def theme_map(day):
    return {x["theme"]: x for x in day.get("themes", [])}

def first_cross(path, threshold):
    for offset, item in enumerate(path, start=1):
        if item["heat"] >= threshold:
            return offset
    return None

def pct(n, d):
    return round(n / d * 100, 1) if d else None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--daily", required=True)
    ap.add_argument("--out-dir", default="event_validation_output")
    ap.add_argument("--setup-threshold", type=float, default=70)
    ap.add_argument("--heat-max", type=float, default=45)
    ap.add_argument("--cooldown", type=int, default=5)
    args = ap.parse_args()

    daily = json.loads(Path(args.daily).read_text(encoding="utf-8"))
    maps = [theme_map(d) for d in daily]
    horizons = (5, 10, 20)

    events = []
    last_event_index = {}

    for i, day in enumerate(daily):
        for theme, x in maps[i].items():
            setup = x.get("setup", 0)
            heat0 = x.get("heat", 0)

            if setup < args.setup_threshold or heat0 >= args.heat_max:
                continue

            prev_i = last_event_index.get(theme)
            if prev_i is not None and i - prev_i <= args.cooldown:
                continue

            last_event_index[theme] = i
            ev = {
                "date": day["date"],
                "theme": theme,
                "setup": setup,
                "setupRaw": x.get("setupRaw"),
                "setupEffectiveN": x.get("setupEffectiveN"),
                "setupSampleFactor": x.get("setupSampleFactor"),
                "radarN": x.get("setupRadarConstituents"),
                "heat0": heat0,
                "lifecycle0": x.get("lifecycle"),
                "nearPivotPct": x.get("nearPivotPct"),
                "forward": {},
            }

            for h in horizons:
                end = min(len(daily), i + h + 1)
                available_sessions = max(0, end - (i + 1))
                path = []
                for j in range(i + 1, end):
                    y = maps[j].get(theme)
                    if y is None:
                        continue
                    path.append({
                        "offset": j - i,
                        "date": daily[j]["date"],
                        "heat": y.get("heat", 0),
                        "setup": y.get("setup"),
                        "lifecycle": y.get("lifecycle"),
                    })

                complete = (i + h < len(daily))
                if not path:
                    ev["forward"][str(h)] = {
                        "available": False,
                        "completeWindow": complete,
                        "availableSessions": available_sessions,
                    }
                    continue

                max_item = max(path, key=lambda z: z["heat"])
                first45 = first_cross(path, 45)
                first65 = first_cross(path, 65)
                first75 = first_cross(path, 75)
                life0_rank = LIFE_RANK.get(x.get("lifecycle"), 0)
                improved = [
                    p for p in path
                    if LIFE_RANK.get(p.get("lifecycle"), 0) > life0_rank
                ]

                ev["forward"][str(h)] = {
                    "available": True,
                    "completeWindow": complete,
                    "availableSessions": available_sessions,
                    "maxHeat": max_item["heat"],
                    "maxHeatDate": max_item["date"],
                    "maxHeatOffset": max_item["offset"],
                    "maxHeatChange": max_item["heat"] - heat0,
                    "everHeatUp10": max_item["heat"] - heat0 >= 10,
                    "everHeatUp20": max_item["heat"] - heat0 >= 20,
                    "everCross45": first45 is not None,
                    "everCross65": first65 is not None,
                    "everCross75": first75 is not None,
                    "firstCross45Days": first45,
                    "firstCross65Days": first65,
                    "firstCross75Days": first75,
                    "lifecycleEverImproved": bool(improved),
                    "bestLifecycle": max(
                        [p.get("lifecycle") for p in path],
                        key=lambda s: LIFE_RANK.get(s, 0)
                    ),
                }

            events.append(ev)

    summary = {
        "version": "v0.7-event-based-forward-validation",
        "modelChanged": False,
        "sourceDays": len(daily),
        "eventRule": f"guarded Setup >= {args.setup_threshold:g} and Heat < {args.heat_max:g}",
        "cooldownTradingDays": args.cooldown,
        "eventCount": len(events),
        "eventsByTheme": {},
        "horizons": {},
    }

    by_theme = defaultdict(int)
    for e in events:
        by_theme[e["theme"]] += 1
    summary["eventsByTheme"] = dict(
        sorted(by_theme.items(), key=lambda kv: (-kv[1], kv[0]))
    )

    for h in horizons:
        # For headline rates, require a complete H-day window.
        vals = [
            e["forward"][str(h)]
            for e in events
            if e["forward"][str(h)].get("available")
            and e["forward"][str(h)].get("completeWindow")
        ]
        n = len(vals)

        def rate(key):
            return pct(sum(1 for v in vals if v.get(key)), n)

        max_changes = [v["maxHeatChange"] for v in vals]
        cross45_days = [v["firstCross45Days"] for v in vals if v.get("firstCross45Days") is not None]

        summary["horizons"][str(h)] = {
            "completeEvents": n,
            "avgMaxHeatChange": round(sum(max_changes) / n, 2) if n else None,
            "medianMaxHeatChange": (
                sorted(max_changes)[n // 2] if n else None
            ),
            "everHeatUp10Pct": rate("everHeatUp10"),
            "everHeatUp20Pct": rate("everHeatUp20"),
            "everCross45Pct": rate("everCross45"),
            "everCross65Pct": rate("everCross65"),
            "everCross75Pct": rate("everCross75"),
            "lifecycleEverImprovedPct": rate("lifecycleEverImproved"),
            "avgDaysToCross45": (
                round(sum(cross45_days) / len(cross45_days), 2)
                if cross45_days else None
            ),
        }

    summary["limitations"] = [
        "This tests future theme Heat/lifecycle behavior, not investment returns.",
        "Cooldown reduces repeated daily signals but events can still overlap across different themes.",
        "Only complete forward windows are used for headline horizon rates.",
        "Forty trading days is still a small descriptive sample; do not tune production weights from this alone.",
        "If v0.7 shows promise, the next validation should use a materially longer out-of-sample period.",
    ]

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "event_forward_events.json").write_text(
        json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (out / "event_forward_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
