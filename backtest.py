#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VCPulse 回測：比較「帶量突破 Pivot」與「💥 Squeeze 爆發」兩種進場訊號。

做法（盡量避免偷看未來）
- 逐日重播歷史：每個訊號日只用「當天以前」的資料，直接呼叫 scanner.analyze()，
  所以篩選條件（VCP 分數、流動性、距離 Pivot…）和網站雷達完全一致。
- 訊號在收盤後確認，隔天「開盤價」進場（不用訊號日收盤價）。
- 兩種出場方式都算：
    出場 A：停損 8% ＋ 收盤跌破 MA20 出場（最長持有 60 個交易日）
    出場 B：停損 8% ＋ 固定持有 20 個交易日
  另外附上不設停損的 5／10／20／40 日報酬分布，方便看原始訊號品質。
- 同一檔、同一類訊號 10 個交易日內只算一次，避免重複計算。
- 基準組：上升趨勢（收盤 > MA50 > MA150）的股票隨機進場，用來對照「訊號有沒有比亂買好」。

重要限制（看結果前請先讀）
- 股票池是「今天還在交易的股票」→ 有倖存者偏差，結果會偏樂觀。
- 使用還原股價（yfinance auto_adjust=True）避免股票分割造成假訊號。
- 手續費與稅另以 --cost-pct 一次扣掉（台股預設 0.5%，美股 0.1%），沒有算滑價。
- 不同股票的訊號常在同一段行情集中出現（彼此不獨立），樣本數看起來多，實際可信度沒那麼高。
- 回測好看不代表未來會賺，它只能幫你排除明顯沒效的規則。

用法
    python backtest.py --market both --years 3 --max-symbols 500
    python backtest.py --synthetic            # 不連網的冒煙測試（用亂數資料，結果沒有意義）
"""
import argparse
import json
import math
import os
import random
import sys
import time
import types
from pathlib import Path

if "--synthetic" in sys.argv and "yfinance" not in sys.modules:
    try:
        import yfinance  # noqa: F401
    except Exception:
        sys.modules["yfinance"] = types.ModuleType("yfinance")

import numpy as np
import pandas as pd

import scanner as sc

STOP_PCT = 0.08       # 初始停損：進場價下方 8%
MAX_HOLD = 60         # 出場 A 最長持有
FIXED_HOLD = 20       # 出場 B 固定持有天數
FWD = (5, 10, 20, 40)
COOLDOWN = 10         # 同檔同類訊號的冷卻（交易日）
WARMUP = 220          # 需要足夠歷史才開始判斷訊號

GROUPS = [
    ("A", "A｜帶量突破 Pivot"),
    ("B", "B｜Squeeze 爆發（D+0、偏多）"),
    ("AB", "A∩B｜突破與爆發同一天"),
    ("A_Q", "A 且結構品質佳"),
    ("B_S", "B 且爆發前為「強力壓縮」"),
    ("BASE", "基準｜上升趨勢股隨機進場"),
]
GROUP_NAME = dict(GROUPS)


# ----------------------------------------------------------------------------
# 資料
# ----------------------------------------------------------------------------
def clean_frame(d):
    d = d.dropna(subset=["Close"])
    cols = ["Open", "High", "Low", "Close", "Volume"]
    if any(c not in d.columns for c in cols):
        return None
    d = d[cols].astype(float)
    d["Volume"] = d["Volume"].fillna(0)
    d = d.dropna(subset=["Open", "High", "Low"])
    d = d[(d["Close"] > 0) & (d["Open"] > 0)]
    return d


def download(items, years):
    out = {}
    period = f"{years + 1}y"
    size = 100
    for i in range(0, len(items), size):
        b = items[i:i + size]
        tickers = [x["yf"] for x in b]
        print(f"  下載 {i + 1}-{i + len(b)} / {len(items)}", flush=True)
        raw = None
        for attempt in range(3):
            try:
                raw = sc.yf.download(tickers=tickers, period=period, interval="1d", group_by="ticker",
                                     auto_adjust=True, progress=False, threads=True, timeout=60)
                break
            except Exception as e:
                print("   下載失敗，重試", e)
                time.sleep(5 * (attempt + 1))
        if raw is None or getattr(raw, "empty", True):
            continue
        for it in b:
            try:
                if len(tickers) == 1:
                    d = raw
                else:
                    if it["yf"] not in raw.columns.get_level_values(0):
                        continue
                    d = raw[it["yf"]]
                d = clean_frame(d)
                if d is not None and len(d) >= WARMUP + 30:
                    out[it["symbol"]] = (it, d)
            except Exception:
                pass
    return out


def synthetic_universe(n, years, seed):
    rng = np.random.default_rng(seed)
    days = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=int(252 * (years + 1)))
    out = {}
    for k in range(n):
        drift = rng.normal(0.0004, 0.0003)
        vol = rng.uniform(0.012, 0.03)
        r = rng.normal(drift, vol, len(days))
        # 偶爾插入「縮量整理後放量上攻」的片段，讓冒煙測試有機會產生訊號
        for s in range(300, len(days) - 60, 120):
            r[s:s + 40] *= 0.35
            r[s + 40] += 0.05
        close = 50 * np.exp(np.cumsum(r))
        openp = close * (1 + rng.normal(0, 0.003, len(days)))
        high = np.maximum(openp, close) * (1 + np.abs(rng.normal(0, 0.006, len(days))))
        low = np.minimum(openp, close) * (1 - np.abs(rng.normal(0, 0.006, len(days))))
        volu = rng.uniform(0.8, 1.2, len(days)) * 4_000_000
        for s in range(300, len(days) - 60, 120):
            volu[s:s + 40] *= 0.4
            volu[s + 40] *= 3.0
        d = pd.DataFrame({"Open": openp, "High": high, "Low": low, "Close": close, "Volume": volu}, index=days)
        sym = f"{1000 + k}"
        out[sym] = ({"symbol": sym, "name": f"合成{sym}", "yf": sym + ".TW", "exchange": "TWSE", "industry": "合成"}, d)
    return out


# ----------------------------------------------------------------------------
# 訊號：先用向量化條件找出候選日，再呼叫 scanner.analyze 套用完整閘門
# ----------------------------------------------------------------------------
def candidate_days(df):
    c, v = df["Close"], df["Volume"]
    pivot = c.shift(3).rolling(32).max()        # 與 analyze 相同：近 35 日（不含最後 3 日）的最高收盤
    v20 = v.rolling(20).mean()
    brk = ((c > pivot) & (c.shift(1) <= pivot) & (v > 1.35 * v20)).fillna(False)
    lv = sc.squeeze_levels(df["High"], df["Low"], c)
    colored = lv > 0
    grp = (colored != colored.shift()).cumsum()
    runlen = colored.astype(int).groupby(grp).cumsum().where(colored, 0)
    mom = c - c.rolling(20).mean()
    fire0 = (lv == 0) & colored.shift(1, fill_value=False) & (runlen.shift(1) >= sc.SQZ_MIN_RUN) & (mom >= 0)
    return (brk | fire0).fillna(False).values


def baseline_days(df, market, offset):
    c, v = df["Close"], df["Volume"]
    trend = (c > c.rolling(50).mean()) & (c.rolling(50).mean() > c.rolling(150).mean())
    min_liq = 20_000_000 if market == "TW" else 10_000_000
    liq = (c * v).rolling(20).mean() >= min_liq
    ok = (trend & liq).fillna(False).values
    idx = np.arange(len(df))
    return ok & (idx % 15 == offset)


# ----------------------------------------------------------------------------
# 模擬交易
# ----------------------------------------------------------------------------
def simulate(O, H, L, C, MA20, e, cost_pct):
    n = len(C)
    if e >= n:
        return None
    entry = O[e]
    if not np.isfinite(entry) or entry <= 0:
        return None
    stop = entry * (1 - STOP_PCT)
    risk_pct = STOP_PCT * 100.0

    def finish(px, j, why):
        ret = (px / entry - 1) * 100.0 - cost_pct
        return {"ret": round(ret, 3), "R": round(ret / risk_pct, 3), "days": int(j - e + 1), "why": why}

    # 出場 A：停損＋收盤跌破 MA20，最長 MAX_HOLD 天
    exit_a = None
    last_a = e + MAX_HOLD
    for j in range(e, min(last_a, n - 1) + 1):
        if L[j] <= stop:
            exit_a = finish(min(O[j], stop) if j > e else stop, j, "stop")
            break
        if j > e and C[j] < MA20[j]:
            exit_a = finish(C[j], j, "ma20")
            break
        if j == last_a:
            exit_a = finish(C[j], j, "time")
            break
    # 出場 B：停損＋固定持有 FIXED_HOLD 天
    exit_b = None
    last_b = e + FIXED_HOLD - 1
    for j in range(e, min(last_b, n - 1) + 1):
        if L[j] <= stop:
            exit_b = finish(min(O[j], stop) if j > e else stop, j, "stop")
            break
        if j == last_b:
            exit_b = finish(C[j], j, "time")
            break
    fwd = {}
    for k in FWD:
        j = e + k - 1
        if j <= n - 1:
            fwd[str(k)] = round((C[j] / entry - 1) * 100.0 - cost_pct, 3)
    return {"entry": round(float(entry), 4), "A": exit_a, "B": exit_b, "fwd": fwd}


def run_market(market, data, years, cost_pct, seed):
    rng = random.Random(seed)
    first_valid = None
    trades = {g: [] for g, _ in GROUPS}
    total = len(data)
    for n_done, (sym, (item, df)) in enumerate(data.items(), 1):
        if n_done % 25 == 0:
            print(f"  [{market}] 回測 {n_done}/{total}，目前訊號："
                  + "、".join(f"{g}={len(trades[g])}" for g, _ in GROUPS if g != "BASE"), flush=True)
        try:
            idx = df.index
            O, H, L, C = (df[k].values for k in ("Open", "High", "Low", "Close"))
            MA20 = df["Close"].rolling(20).mean().values
            start_cut = idx[-1] - pd.DateOffset(years=years)
            cand = candidate_days(df)
            last_taken = {g: -10 ** 9 for g, _ in GROUPS}

            def add(group, t, row=None):
                if t - last_taken[group] < COOLDOWN:
                    return
                sim = simulate(O, H, L, C, MA20, t + 1, cost_pct)
                if not sim:
                    return
                last_taken[group] = t
                rec = {"symbol": sym, "date": idx[t].strftime("%Y-%m-%d"), **sim}
                if row is not None:
                    rec["pivot"] = row.get("pivot")
                    rec["score"] = row.get("score")
                trades[group].append(rec)

            for t in np.flatnonzero(cand):
                if t < WARMUP or t + 1 >= len(df) or idx[t] < start_cut:
                    continue
                row = sc.analyze(df.iloc[:t + 1], item, market)
                if not row:
                    continue
                a = row.get("type") == "breakout"
                b = (bool(row.get("squeeze_fire")) and row.get("squeeze_fire_days") == 0
                     and row.get("squeeze_fire_dir") == "bull")
                if a:
                    add("A", t, row)
                    if row.get("structure_quality_good"):
                        add("A_Q", t, row)
                if b:
                    add("B", t, row)
                    if row.get("squeeze_fire_prev_level") == "strong":
                        add("B_S", t, row)
                if a and b:
                    add("AB", t, row)

            off = rng.randrange(15)
            for t in np.flatnonzero(baseline_days(df, market, off)):
                if t < WARMUP or t + 1 >= len(df) or idx[t] < start_cut:
                    continue
                add("BASE", t)
        except Exception as e:  # 單一股票出錯不影響整體
            print("  回測略過", sym, e)
    return trades


# ----------------------------------------------------------------------------
# 統計與輸出
# ----------------------------------------------------------------------------
def stats(rets, Rs):
    a = np.asarray(rets, float)
    n = len(a)
    if n == 0:
        return {"n": 0}
    wins, loss = a[a > 0], a[a <= 0]
    streak = best = 0
    for x in rets:
        streak = streak + 1 if x <= 0 else 0
        best = max(best, streak)
    gross_w, gross_l = float(wins.sum()), float(abs(loss.sum()))
    return {
        "n": int(n),
        "win_pct": round(float((a > 0).mean() * 100), 1),
        "avg_ret": round(float(a.mean()), 2),
        "median_ret": round(float(np.median(a)), 2),
        "avg_win": round(float(wins.mean()), 2) if len(wins) else None,
        "avg_loss": round(float(loss.mean()), 2) if len(loss) else None,
        "payoff": round(float(wins.mean() / abs(loss.mean())), 2) if len(wins) and len(loss) and loss.mean() != 0 else None,
        "profit_factor": round(gross_w / gross_l, 2) if gross_l > 0 else None,
        "avg_R": round(float(np.mean(Rs)), 2),
        "max_loss_streak": int(best),
        "worst": round(float(a.min()), 2),
        "best": round(float(a.max()), 2),
    }


def summarize(trades):
    out = {}
    for g, name in GROUPS:
        tr = sorted(trades[g], key=lambda r: r["date"])
        res = {"name": name, "signals": len(tr)}
        for ex in ("A", "B"):
            sel = [t for t in tr if t.get(ex)]
            res["exit" + ex] = stats([t[ex]["ret"] for t in sel], [t[ex]["R"] for t in sel])
        fwd = {}
        for k in FWD:
            vals = [t["fwd"][str(k)] for t in tr if str(k) in t["fwd"]]
            fwd[str(k)] = ({"n": len(vals), "win_pct": round(float(np.mean([v > 0 for v in vals]) * 100), 1),
                            "avg": round(float(np.mean(vals)), 2), "median": round(float(np.median(vals)), 2)}
                           if vals else {"n": 0})
        res["fwd"] = fwd
        by_year = {}
        for t in tr:
            if t.get("A") and t["A"]:
                by_year.setdefault(t["date"][:4], []).append(t["A"]["ret"])
        res["by_year_exitA"] = {y: {"n": len(v), "win_pct": round(float(np.mean([x > 0 for x in v]) * 100), 1),
                                    "avg_ret": round(float(np.mean(v)), 2)} for y, v in sorted(by_year.items())}
        out[g] = res
    return out


def fmt(v, suffix=""):
    return "—" if v is None else f"{v}{suffix}"


def markdown(all_res, meta):
    L = ["# VCPulse 回測結果", "",
         f"- 回測期間：近 {meta['years']} 年｜股票池：每市場隨機取 {meta['max_symbols']} 檔（今天仍在交易的股票）",
         f"- 進場：訊號日隔天開盤｜停損 {int(STOP_PCT * 100)}%｜出場 A＝跌破 MA20（最長 {MAX_HOLD} 日）｜出場 B＝持有 {FIXED_HOLD} 日",
         "- ⚠️ 倖存者偏差會讓結果偏樂觀；訊號之間不獨立；不含滑價。看「相對基準組」比看絕對數字更有意義。", ""]
    for market, res in all_res.items():
        L += [f"## {market}（成本已扣 {meta['cost'][market]}%）", ""]
        for ex, title in (("exitA", "出場 A：停損 8% ＋ 跌破 MA20"), ("exitB", f"出場 B：停損 8% ＋ 持有 {FIXED_HOLD} 日")):
            L += [f"### {title}", "",
                  "| 訊號 | 筆數 | 勝率 | 平均報酬 | 中位數 | 賺賠比 | 獲利因子 | 平均 R | 最大連虧 |",
                  "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
            for g, name in GROUPS:
                s = res[g][ex]
                if s["n"] == 0:
                    L.append(f"| {name} | 0 | — | — | — | — | — | — | — |")
                    continue
                L.append(f"| {name} | {s['n']} | {s['win_pct']}% | {s['avg_ret']}% | {s['median_ret']}% | "
                         f"{fmt(s['payoff'])} | {fmt(s['profit_factor'])} | {s['avg_R']} | {s['max_loss_streak']} |")
            L.append("")
        L += ["### 不設停損的固定持有報酬（看訊號本身的品質）", "",
              "| 訊號 | 5 日 | 10 日 | 20 日 | 40 日 |", "|---|---:|---:|---:|---:|"]
        for g, name in GROUPS:
            cells = []
            for k in FWD:
                f = res[g]["fwd"][str(k)]
                cells.append("—" if f["n"] == 0 else f"{f['avg']}%（勝 {f['win_pct']}%，n={f['n']}）")
            L.append(f"| {name} | " + " | ".join(cells) + " |")
        L.append("")
        L += ["### 各年度（出場 A 平均報酬，看穩不穩定）", "", "| 訊號 | " + " | ".join(
            sorted({y for g, _ in GROUPS for y in res[g]["by_year_exitA"]})) + " |"]
        years_sorted = sorted({y for g, _ in GROUPS for y in res[g]["by_year_exitA"]})
        L.append("|---|" + "---:|" * len(years_sorted))
        for g, name in GROUPS:
            cells = []
            for y in years_sorted:
                v = res[g]["by_year_exitA"].get(y)
                cells.append("—" if not v else f"{v['avg_ret']}%（n={v['n']}）")
            L.append(f"| {name} | " + " | ".join(cells) + " |")
        L.append("")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", default="both", choices=["TW", "US", "both"])
    ap.add_argument("--years", type=int, default=3)
    ap.add_argument("--max-symbols", type=int, default=500)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--cost-tw", type=float, default=0.5, help="台股來回成本（%%，含證交稅與手續費）")
    ap.add_argument("--cost-us", type=float, default=0.1, help="美股來回成本（%%）")
    ap.add_argument("--out-dir", default="backtest_out")
    ap.add_argument("--synthetic", action="store_true", help="冒煙測試：用亂數資料，不連網")
    args = ap.parse_args()

    markets = ["TW", "US"] if args.market == "both" else [args.market]
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    all_res, all_trades = {}, {}
    costs = {"TW": args.cost_tw, "US": args.cost_us}
    for market in markets:
        print(f"== {market} ==", flush=True)
        if args.synthetic:
            data = synthetic_universe(min(args.max_symbols, 60), args.years, args.seed)
        else:
            universe = sc.fetch_tw_universe() if market == "TW" else sc.fetch_us_universe()
            random.Random(args.seed).shuffle(universe)
            universe = universe[:args.max_symbols]
            print(f"  股票池：隨機取 {len(universe)} 檔", flush=True)
            data = download(universe, args.years)
        print(f"  有效資料：{len(data)} 檔", flush=True)
        trades = run_market(market, data, args.years, costs[market], args.seed)
        all_trades[market] = trades
        all_res[market] = summarize(trades)

    meta = {"years": args.years, "max_symbols": args.max_symbols, "cost": costs, "seed": args.seed,
            "stop_pct": STOP_PCT, "max_hold": MAX_HOLD, "fixed_hold": FIXED_HOLD}
    (out_dir / "backtest_result.json").write_text(
        json.dumps({"meta": meta, "summary": all_res, "trades": all_trades}, ensure_ascii=False), encoding="utf-8")
    md = markdown(all_res, meta)
    (out_dir / "backtest_summary.md").write_text(md, encoding="utf-8")
    print("\n" + md)
    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_file:
        with open(summary_file, "a", encoding="utf-8") as f:
            f.write(md + "\n")


if __name__ == "__main__":
    main()
