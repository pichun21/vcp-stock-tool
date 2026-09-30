#!/usr/bin/env python3
"""VCPulse Market Breadth Beta v0.3 Recorder.

Research-only recorder. Reads the current TW official snapshot, computes frozen v0.1
and experimental v0.2 scores, and UPSERTS one row per official data_date.
Safe to run repeatedly: the same trading date is replaced, never duplicated.
"""
from __future__ import annotations
import argparse, csv, importlib.util, json
from pathlib import Path


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


def flat_row(v1: dict, v2: dict) -> dict:
    if not v1.get("data_date") or v1.get("data_date") != v2.get("data_date"):
        raise RuntimeError("Missing or mismatched TW official data_date; recorder aborted.")
    row = {
        "data_date": v2["data_date"],
        "twse_close": v2.get("twse_close"),
        "twse_change_pct": v2.get("twse_change_pct"),
        "candidate_count": v2.get("candidate_count"),
        "breakout_count": v2.get("breakout_count"),
        "postbreakout_count": v2.get("postbreakout_count"),
        "near_pivot_count": v2.get("near_pivot_count"),
        "forming_count": v2.get("forming_count"),
        "volume_breakout_count": v2.get("volume_breakout_count"),
        "active_industry_count": v2.get("active_industry_count"),
        "industry_count": v2.get("industry_count"),
        "extended_count": v2.get("extended_count"),
        "failed_count": v2.get("failed_count"),
        "v01_score": v1.get("score"), "v01_regime": v1.get("regime"),
        "v02_score": v2.get("score"), "v02_regime": v2.get("regime"),
    }
    for k, val in (v1.get("components") or {}).items(): row[f"v01_{k}"] = val
    for k, val in (v2.get("components") or {}).items(): row[f"v02_{k}"] = val
    return row


def upsert_csv(path: Path, row: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    old = []
    if path.exists():
        with path.open("r", newline="", encoding="utf-8-sig") as f:
            old = list(csv.DictReader(f))
    by_date = {r.get("data_date"): r for r in old if r.get("data_date")}
    by_date[row["data_date"]] = {k: str(v) if v is not None else "" for k, v in row.items()}
    rows = [by_date[d] for d in sorted(by_date)]
    fields = list(row.keys())
    # Preserve any legacy columns if a future/older recorder added them.
    for r in rows:
        for k in r:
            if k not in fields: fields.append(k)
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader(); w.writerows(rows)



def _num(v):
    try: return float(v)
    except (TypeError, ValueError): return None


def build_market_structure(history_path: Path, output_path: Path):
    """Frozen v1.0 research display built from Breadth v0.2 + Cycle v0.6 rules."""
    rows=[]
    if history_path.exists():
        with history_path.open("r", newline="", encoding="utf-8-sig") as f:
            rows=list(csv.DictReader(f))
    rows=[r for r in rows if r.get("data_date") and _num(r.get("v02_score")) is not None]
    rows.sort(key=lambda r:r["data_date"])
    if not rows:
        payload={"status":"waiting","state":"INSUFFICIENT_HISTORY","label":"資料累積中","note":"Market Structure Beta needs official Breadth history."}
    else:
        cur=rows[-1]; score=_num(cur.get("v02_score")); cand=_num(cur.get("candidate_count")) or 0
        ext=_num(cur.get("extended_count")) or 0
        ext_ratio=(ext/cand) if cand>0 else 0.0
        d1=(score-_num(rows[-2].get("v02_score"))) if len(rows)>=2 else None
        d5=(score-_num(rows[-6].get("v02_score"))) if len(rows)>=6 else None
        if d1 is None and d5 is None:
            state="INSUFFICIENT_HISTORY"
        elif score < 55 and ((d1 is not None and d1 < 0) or (d5 is not None and d5 < 0)):
            state="CONTRACTION"
        elif score >= 65 and ((d1 is not None and d1 < -2) or (d5 is not None and d5 < -2)):
            state="DETERIORATION"
        elif score >= 70 and ext_ratio >= 0.25:
            state="OVERHEATED"
        elif score >= 65 and ext_ratio < 0.25:
            state="MATURE_BULL"
        elif score >= 55 and ((d1 is not None and d1 > 0) or (d5 is not None and d5 > 0)) and ext_ratio < 0.25:
            state="EXPANSION"
        else:
            state="NEUTRAL_TRANSITION"
        labels={
            "EXPANSION":"擴張","MATURE_BULL":"成熟","DETERIORATION":"惡化",
            "CONTRACTION":"收縮","NEUTRAL_TRANSITION":"過渡","OVERHEATED":"過熱",
            "INSUFFICIENT_HISTORY":"資料累積中"
        }
        payload={
            "status":"ok" if state!="INSUFFICIENT_HISTORY" else "waiting",
            "version":"market-structure-beta-v1.0-frozen",
            "data_date":cur["data_date"], "state":state, "label":labels[state],
            "breadth_score":round(score,1),
            "delta_1d":round(d1,1) if d1 is not None else None,
            "delta_5d":round(d5,1) if d5 is not None else None,
            "extension_ratio":round(ext_ratio,4),
            "history_sessions":len(rows),
            "note":"Descriptive research state only; not a bullish/bearish forecast or futures trading signal. Breadth v0.2 and Cycle v0.6 rules frozen on 2026-09-17."
        }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
    return payload

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="screening.json")
    ap.add_argument("--latest", default="data/market_breadth_latest.json")
    ap.add_argument("--history", default="data/market_breadth_history.csv")
    ap.add_argument("--structure", default="data/market_structure_latest.json")
    args = ap.parse_args()
    here = Path(__file__).resolve().parent
    v1m = load_module(here / "vcpulse_market_breadth_v0_1.py", "mb_v01")
    v2m = load_module(here / "vcpulse_market_breadth_v0_2.py", "mb_v02")
    snap = json.loads(Path(args.input).read_text(encoding="utf-8"))
    # Frozen research universe: Market Breadth v0.2 / Cycle v0.6 were validated
    # on the first 150 TW official candidates. Production radar may expose 200,
    # but Market Structure must keep the same 150-candidate universe.
    official_rows = snap.get("official_results")
    if isinstance(official_rows, list):
        snap = dict(snap)
        snap["official_results"] = [r for r in official_rows if str(r.get("market", "")).upper() == "TW"][:150]
    v1, v2 = v1m.compute(snap), v2m.compute(snap)
    row = flat_row(v1, v2)
    latest = {"data_date": row["data_date"], "v0.1": v1, "v0.2": v2,
              "note": "Research-only. Scores are not predictive probabilities or trading signals."}
    Path(args.latest).parent.mkdir(parents=True, exist_ok=True)
    Path(args.latest).write_text(json.dumps(latest, ensure_ascii=False, indent=2), encoding="utf-8")
    upsert_csv(Path(args.history), row)
    structure=build_market_structure(Path(args.history), Path(args.structure))
    print(json.dumps({"status":"ok", "data_date":row["data_date"], "v0.1":v1["score"], "v0.2":v2["score"], "market_structure":structure.get("state")}, ensure_ascii=False))

if __name__ == "__main__": main()
