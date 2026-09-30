#!/usr/bin/env python3
"""VCPulse Market Breadth Beta v0.1

Read-only research module. It does not modify scanner.py or VCP rules.
It converts one VCPulse screening snapshot into a 0-100 Taiwan market breadth score
and can append the observation to a CSV history for later T+1/T+3/T+5 validation.
"""
from __future__ import annotations
import argparse, csv, json, math
from collections import Counter
from datetime import datetime
from pathlib import Path

WEIGHTS = {
    "breakout_breadth": 0.25,
    "volume_breakout": 0.20,
    "setup_pressure": 0.15,
    "vcp_quality": 0.15,
    "industry_breadth": 0.15,
    "risk_control": 0.10,
}

def clamp(x, lo=0.0, hi=100.0): return max(lo, min(hi, x))
def sat(x, target): return clamp((x / target) * 100.0) if target else 0.0

def compute(snapshot: dict) -> dict:
    rows = [r for r in snapshot.get("official_results", snapshot.get("results", []))
            if r.get("market") == "TW"]
    n = len(rows)
    types = Counter(str(r.get("type", "")) for r in rows)
    pulses = Counter(str(r.get("pulse_signal", "")) for r in rows)
    breakout = types["breakout"]
    post = types["postbreakout"]
    near = types["near"]
    forming = types["forming"]

    # v0.1 deliberately uses saturating thresholds, not fitted parameters.
    # These MUST be validated before being interpreted as predictive probabilities.
    breakout_rate = breakout / n if n else 0
    breakout_breadth = sat(breakout_rate, 0.10)  # 10% of VCP candidates = full score

    # Current scanner's breakout state is already "今日帶量突破"; keep a separate
    # confirmation component so future scanner versions can distinguish variants.
    vol_breakouts = sum(1 for r in rows if r.get("type") == "breakout" and "帶量" in str(r.get("state", "")))
    volume_breakout = sat((vol_breakouts / breakout) if breakout else 0, 1.0)

    # Near-pivot candidates represent latent setup pressure; cap at 50% of candidates.
    setup_pressure = sat((near / n) if n else 0, 0.50)

    scores = [float(r.get("score") or 0) for r in rows]
    avg_score = sum(scores) / len(scores) if scores else 0
    high_quality_rate = sum(s >= 4 for s in scores) / len(scores) if scores else 0
    vcp_quality = clamp(0.55 * sat(avg_score, 5.0) + 0.45 * high_quality_rate * 100)

    industries = {str(r.get("industry") or "").strip() for r in rows if str(r.get("industry") or "").strip()}
    active_industries = {str(r.get("industry") or "").strip() for r in rows
                         if str(r.get("industry") or "").strip() and r.get("type") in {"breakout", "postbreakout"}}
    ind_spread = len(active_industries) / len(industries) if industries else 0
    hotspot = snapshot.get("official_capital_hotspots", {}).get("TW", []) or []
    warm_hotspots = sum(1 for h in hotspot if float(h.get("heat_score") or 0) >= 70)
    industry_breadth = clamp(0.65 * sat(ind_spread, 0.25) + 0.35 * sat(warm_hotspots, 5))

    extended = pulses["extended"]
    failed = sum(1 for r in rows if any(k in str(r.get("state", "")) for k in ("失敗", "跌破", "失效")))
    risk_rate = (extended + failed) / n if n else 0
    risk_control = 100 - sat(risk_rate, 0.15)

    components = {
        "breakout_breadth": breakout_breadth,
        "volume_breakout": volume_breakout,
        "setup_pressure": setup_pressure,
        "vcp_quality": vcp_quality,
        "industry_breadth": industry_breadth,
        "risk_control": risk_control,
    }
    total = round(sum(components[k] * WEIGHTS[k] for k in WEIGHTS), 1)
    if total >= 70: regime = "偏多"
    elif total >= 55: regime = "中性偏多"
    elif total >= 45: regime = "中性"
    elif total >= 30: regime = "中性偏空"
    else: regime = "偏空"

    bench = snapshot.get("official_benchmarks", {}).get("TW", {}).get("TWSE", {})
    return {
        "version": "market_breadth_v0.1",
        "generated_at": snapshot.get("generated_at"),
        "data_date": (rows[0].get("data_date") if rows else None),
        "market": "TW",
        "score": total,
        "regime": regime,
        "candidate_count": n,
        "breakout_count": breakout,
        "postbreakout_count": post,
        "near_pivot_count": near,
        "forming_count": forming,
        "volume_breakout_count": vol_breakouts,
        "active_industry_count": len(active_industries),
        "industry_count": len(industries),
        "warm_hotspot_count": warm_hotspots,
        "extended_count": extended,
        "failed_count": failed,
        "avg_vcp_score": round(avg_score, 3),
        "components": {k: round(v, 1) for k, v in components.items()},
        "weights": WEIGHTS,
        "twse_close": bench.get("close"),
        "twse_change_pct": bench.get("change_pct"),
        "note": "Beta research score; thresholds are heuristic and not yet predictive probabilities. Validate T+1/T+3/T+5 before product use.",
    }

def append_csv(result: dict, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    flat = {k:v for k,v in result.items() if k not in {"components","weights","note"}}
    flat.update({f"component_{k}":v for k,v in result["components"].items()})
    exists = path.exists()
    with path.open("a", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(flat.keys()))
        if not exists: w.writeheader()
        w.writerow(flat)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input", default="data/screening.json")
    ap.add_argument("--output", default="data/market_breadth_latest.json")
    ap.add_argument("--history", default="data/market_breadth_history.csv")
    ap.add_argument("--no-history", action="store_true")
    a=ap.parse_args()
    snap=json.loads(Path(a.input).read_text(encoding="utf-8"))
    result=compute(snap)
    Path(a.output).parent.mkdir(parents=True, exist_ok=True)
    Path(a.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if not a.no_history: append_csv(result, Path(a.history))
    print(json.dumps(result, ensure_ascii=False, indent=2))
if __name__ == "__main__": main()
