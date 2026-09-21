#!/usr/bin/env python3
"""Build a lightweight Taiwan intraday quote cache for VCPulse.

This intentionally does NOT recompute VCP structure. It only refreshes market
fields used by the UI (last price, previous close, day change and quote time)
for the current TW radar symbols in screening.json.
"""
from __future__ import annotations

import argparse
import json
import math
import time
import random
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

TZ = ZoneInfo("Asia/Taipei")
MIS_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"


def _num(v):
    try:
        x = float(str(v).replace(",", "").strip())
        return x if math.isfinite(x) else None
    except Exception:
        return None


def _quote_time(row):
    t = str(row.get("t") or "").replace(".000", "").strip()
    if t:
        return t[:8]
    ms = _num(row.get("tlong"))
    if ms:
        try:
            return datetime.fromtimestamp(ms / 1000, TZ).strftime("%H:%M:%S")
        except Exception:
            pass
    return ""


def _quote_date(row):
    d = str(row.get("d") or "").strip()
    if len(d) == 8 and d.isdigit():
        return f"{d[:4]}-{d[4:6]}-{d[6:8]}"
    return ""


def load_targets(screening_path: Path):
    payload = json.loads(screening_path.read_text(encoding="utf-8"))
    rows = payload.get("intraday_results") or []
    tw = [r for r in rows if str(r.get("market") or "").upper() == "TW"]
    if not tw:
        rows = payload.get("official_results") or []
        tw = [r for r in rows if str(r.get("market") or "").upper() == "TW"]

    out = []
    seen = set()
    for r in tw:
        sym = str(r.get("symbol") or "").strip().upper()
        if not sym or sym in seen:
            continue
        seen.add(sym)
        ex = str(r.get("exchange") or "").upper()
        channel = "otc" if ("TPEX" in ex or "OTC" in ex) else "tse"
        out.append({"symbol": sym, "exchange": ex, "channel": channel})
    return out


def fetch_chunk(session: requests.Session, targets, *, attempts=4):
    """Fetch one small MIS batch with conservative retry/backoff.

    TWSE MIS can transiently return a partial/empty msgArray without raising an
    HTTP error.  We therefore keep batches small and retry suspiciously short
    replies before accepting them.
    """
    ex_ch = "|".join(f"{x['channel']}_{x['symbol']}.tw" for x in targets)
    expected = len(targets)
    last_rows = []
    last_error = None

    for attempt in range(1, attempts + 1):
        try:
            params = {
                "ex_ch": ex_ch,
                "json": "1",
                "delay": "0",
                "_": str(int(time.time() * 1000)),
            }
            r = session.get(MIS_URL, params=params, timeout=20)
            r.raise_for_status()
            j = r.json()
            rows = j.get("msgArray") or []
            last_rows = rows

            # Normally MIS returns a row for nearly every requested symbol,
            # even when the symbol has not traded yet.  A very short reply is
            # usually throttling/transient truncation, so retry it.
            minimum_rows = max(1, math.ceil(expected * 0.75))
            if len(rows) >= minimum_rows:
                return rows

            last_error = RuntimeError(
                f"partial MIS response {len(rows)}/{expected} rows"
            )
        except Exception as e:
            last_error = e

        if attempt < attempts:
            # Exponential backoff with a little jitter avoids hammering MIS.
            wait = min(8.0, 1.0 * (2 ** (attempt - 1))) + random.uniform(0.15, 0.55)
            time.sleep(wait)

    if last_rows:
        return last_rows
    if last_error:
        raise last_error
    return []


def _best_level(raw):
    """Return the first positive price from an MIS 5-level quote string."""
    for part in str(raw or "").split("_"):
        x = _num(part)
        if x is not None and x > 0:
            return x
    return None


def parse_row(row):
    sym = str(row.get("c") or "").strip().upper()
    if not sym:
        return None

    # MIS `z` is the latest transaction field, but it is frequently `-`
    # between trades even though a live order book is present.  Prefer the
    # exact transaction price; when it is absent, use the best bid as an
    # *indicative* live price (best ask only if there is no bid).  Keep the
    # price kind in the cache so the UI/debugging can distinguish the two.
    trade = _num(row.get("z"))
    bid = _best_level(row.get("b"))
    ask = _best_level(row.get("a"))
    prev = _num(row.get("y"))

    if trade is not None and trade > 0:
        price = trade
        price_kind = "last_trade"
    elif bid is not None and bid > 0:
        price = bid
        price_kind = "best_bid_indicative"
    elif ask is not None and ask > 0:
        price = ask
        price_kind = "best_ask_indicative"
    else:
        return None

    if prev is None or prev <= 0:
        return None

    pct = (price / prev - 1.0) * 100.0
    return {
        "symbol": sym,
        "name": str(row.get("n") or "").strip(),
        "price": round(price, 4),
        "prev_close": round(prev, 4),
        "change_pct": round(pct, 4),
        "data_date": _quote_date(row),
        "quote_time": _quote_time(row),
        "source": "TWSE MIS",
        "price_kind": price_kind,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--screening", default="screening.json")
    ap.add_argument("--output", default="data/live_quotes_tw.json")
    ap.add_argument("--chunk-size", type=int, default=20)
    args = ap.parse_args()

    screening = Path(args.screening)
    output = Path(args.output)
    targets = load_targets(screening)
    now = datetime.now(TZ)

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (VCPulse live quote cache)",
        "Referer": "https://mis.twse.com.tw/stock/index.jsp",
        "Accept": "application/json,text/plain,*/*",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    })

    # Warm the session once so MIS can set any cookies it expects before the
    # API batches start.  Failure here is harmless; the API calls still retry.
    try:
        session.get("https://mis.twse.com.tw/stock/index.jsp", timeout=15)
    except Exception:
        pass
    time.sleep(0.8)

    quotes = {}
    errors = []
    size = max(1, int(args.chunk_size))
    for i in range(0, len(targets), size):
        chunk = targets[i:i + size]
        try:
            rows = fetch_chunk(session, chunk)
            before = len(quotes)
            for row in rows:
                q = parse_row(row)
                if q:
                    quotes[q["symbol"]] = q
            added = len(quotes) - before
            print(
                f"chunk {i // size + 1}: requested {len(chunk)}, "
                f"MIS rows {len(rows)}, usable quotes +{added}"
            )
        except Exception as e:
            errors.append(f"chunk {i // size + 1}: {type(e).__name__}: {e}")
        # Keep the request cadence deliberately gentle.
        time.sleep(1.15 + random.uniform(0.10, 0.35))

    dates = sorted({q.get("data_date") for q in quotes.values() if q.get("data_date")})
    times = [q.get("quote_time") for q in quotes.values() if q.get("quote_time")]
    payload = {
        "version": 1,
        "market": "TW",
        "generated_at": now.strftime("%Y-%m-%d %H:%M:%S"),
        "generated_at_iso": now.isoformat(timespec="seconds"),
        "data_dates": dates,
        "latest_quote_time": max(times) if times else "",
        "target_count": len(targets),
        "quote_count": len(quotes),
        "source": "TWSE MIS",
        "errors": errors,
        "quotes": quotes,
    }
    # Safety guard: a transient exchange/network failure must never replace a
    # healthy cache with an empty/partial file. GitHub Actions will fail this
    # run and the previously committed cache stays intact.
    minimum = max(5, math.ceil(len(targets) * 0.50)) if targets else 0
    if targets and len(quotes) < minimum:
        print(f"TW live quote cache rejected: only {len(quotes)}/{len(targets)} quotes (minimum {minimum}).")
        if errors:
            print("Warnings:")
            for x in errors:
                print(" -", x)
        raise SystemExit(2)

    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_suffix(output.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(output)
    print(f"TW live quote cache: {len(quotes)}/{len(targets)} symbols -> {output}")
    if errors:
        print("Warnings:")
        for x in errors:
            print(" -", x)


if __name__ == "__main__":
    main()
