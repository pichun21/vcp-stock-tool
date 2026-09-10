"""
VCPulse Long Out-of-Sample Validation v0.8

Frozen model validation:
- Rebuilds historical v0.5 Heat/Setup scores over a long period.
- Uses the unchanged v0.7 event rule and event-based forward windows.
- No production writes and no score-weight tuning.

Important:
The historical runner needs ~420 calendar days of warm-up before the validation
start because the VCP scanner requires at least 170 sessions.
"""

from __future__ import annotations
import argparse, json, os, subprocess, sys
from pathlib import Path

def run(cmd):
    print("+", " ".join(map(str, cmd)), flush=True)
    subprocess.run(cmd, check=True)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--theme-db", required=True)
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--cache-dir", default="backtest_cache")
    ap.add_argument("--out-dir", default="long_validation_output")
    ap.add_argument("--setup-threshold", type=float, default=70)
    ap.add_argument("--heat-max", type=float, default=45)
    ap.add_argument("--cooldown", type=int, default=5)
    args=ap.parse_args()

    out=Path(args.out_dir)
    history_out=out/"history"
    event_out=out/"events"
    history_out.mkdir(parents=True, exist_ok=True)
    event_out.mkdir(parents=True, exist_ok=True)

    # v0.5 must support --max-days 0 in the long-validation copy/workflow.
    run([
        sys.executable, "tools/vcpulse_theme_historical_runner_v0_8_long.py",
        "--theme-db", args.theme_db,
        "--start", args.start,
        "--end", args.end,
        "--cache-dir", args.cache_dir,
        "--out-dir", str(history_out),
        "--max-days", "0",
    ])

    run([
        sys.executable, "tools/vcpulse_event_forward_validation_v0_7.py",
        "--daily", str(history_out/"backtest_daily.json"),
        "--out-dir", str(event_out),
        "--setup-threshold", str(args.setup_threshold),
        "--heat-max", str(args.heat_max),
        "--cooldown", str(args.cooldown),
    ])

    summary=json.loads((event_out/"event_forward_summary.json").read_text(encoding="utf-8"))
    meta={
        "version":"v0.8-long-out-of-sample",
        "modelFrozen":True,
        "modelBasis":"v0.5 scoring + v0.7 event validation",
        "validationStart":args.start,
        "validationEnd":args.end,
        "sourceDays":summary.get("sourceDays"),
        "eventCount":summary.get("eventCount"),
        "note":"Long-window validation only. No production model weights were changed."
    }
    (out/"v0_8_meta.json").write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(meta,ensure_ascii=False,indent=2))

if __name__=="__main__":
    main()
