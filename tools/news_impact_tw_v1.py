#!/usr/bin/env python3
# VCPulse News Impact TW v1.1 — full 200 / intraday 60
# Public-data information layer: Google News RSS + existing screening.json price/VCP context.
# It does NOT change VCP score, ranking, or radar eligibility.

from __future__ import annotations
import argparse
import html
import json
import math
import re
import time
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import quote_plus
import xml.etree.ElementTree as ET

import requests

ROOT = Path(__file__).resolve().parents[1]
SCREENING = ROOT / "screening.json"
OUT = ROOT / "data" / "news_impact.json"
TZ8 = timezone(timedelta(hours=8))

EVENT_RULES = [
    (("營收","財報","財測","獲利","eps","毛利","法說","季報","年報"),
     "財務／營運", "營收、毛利率、EPS、公司財測", "中期",
     "可能改變市場對營運成長與獲利能力的預期。"),
    (("接單","訂單","客戶","供應","出貨","需求","標案","得標"),
     "訂單／需求", "營收、訂單能見度、產能利用率", "中期",
     "訂單與需求變化通常會影響未來營收能見度與產能利用。"),
    (("擴產","建廠","新廠","資本支出","capex","產能"),
     "擴產／資本支出", "資本支出、折舊、產能、產能利用率", "中長期",
     "擴產可能提升未來供應能力，同時也會增加資本支出與折舊壓力。"),
    (("漲價","降價","報價","價格","asp"),
     "價格／報價", "ASP、營收、毛利率", "短中期",
     "產品價格或報價變動可能影響營收與毛利率。"),
    (("關稅","政策","法規","補助","制裁","禁令","出口管制"),
     "政策／法規", "需求、成本、供應鏈、資本支出", "中期",
     "政策與法規可能改變需求、成本或供應鏈配置。"),
    (("量產","新品","新產品","認證","驗證","技術","製程"),
     "產品／技術", "產品組合、營收、毛利率、量產進度", "中長期",
     "產品或技術進展可能影響產品組合、量產時程與後續營收。"),
    (("股利","配息","庫藏股","增資","減資","現增","可轉債"),
     "資本／股東回饋", "資本結構、股東回饋、股本", "短中期",
     "資本結構或股東回饋政策可能影響市場對資金運用的解讀。"),
    (("併購","收購","合作","策略聯盟","投資","合資"),
     "策略／投資", "營收來源、成本、資本支出、策略布局", "中長期",
     "策略合作或投資可能改變公司的市場布局與資源配置。"),
    (("停工","事故","火災","地震","訴訟","裁罰","召回"),
     "營運風險", "產能、成本、交期、一次性損益", "短中期",
     "營運中斷或法律事件可能影響產能、成本或交付時程。"),
]

IMPORTANT_WORDS = (
    "營收","財報","財測","法說","接單","訂單","擴產","建廠","資本支出",
    "漲價","關稅","政策","補助","制裁","量產","新品","認證","併購",
    "收購","停工","事故","庫藏股","增資","減資","重大訊息"
)

def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default

def clean_name(name: str) -> str:
    s = str(name or "").strip()
    s = re.sub(r"[-－—–]\s*創\s*$", "", s).strip()
    return s

def collect_tw_rows(obj):
    """Find stock-like dicts anywhere in screening.json and keep the richest TW row per symbol."""
    best = {}
    def walk(x):
        if isinstance(x, dict):
            market = str(x.get("market","")).upper()
            symbol = str(x.get("symbol","")).upper().strip()
            if market == "TW" and re.fullmatch(r"\d{4,6}", symbol):
                score = sum(1 for k in (
                    "name","score","pulse_signal","type","change_pct","distance",
                    "structure_quality_good","volume_dry","pivot"
                ) if x.get(k) is not None)
                old = best.get(symbol)
                if old is None or score > old[0]:
                    best[symbol] = (score, dict(x))
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(obj)
    return [v[1] for v in best.values()]

def priority(row):
    pulse = {"hot":40,"watch":28,"wait":12,"extended":8}.get(str(row.get("pulse_signal")),0)
    typ = {"breakout":35,"near":25,"postbreakout":20,"forming":8}.get(str(row.get("type")),0)
    quality = 18 if row.get("structure_quality_good") else 0
    score = float(row.get("score") or 0) * 4
    chg = abs(float(row.get("change_pct") or 0))
    return pulse + typ + quality + score + min(chg,10)

def classify(title: str):
    low = title.lower()
    for words, event, impacts, horizon, why in EVENT_RULES:
        if any(w.lower() in low for w in words):
            return event, impacts, horizon, why
    return "公司／產業動態", "營運、需求與市場預期", "短中期", "這則消息可能改變市場對公司營運或產業需求的預期。"

def article_importance(title: str, published: datetime | None):
    s = 0
    low = title.lower()
    s += sum(7 for w in IMPORTANT_WORDS if w.lower() in low)
    if published:
        age_h = max(0, (datetime.now(timezone.utc) - published.astimezone(timezone.utc)).total_seconds()/3600)
        s += max(0, 30 - age_h/4)
    return s

def parse_pub(s):
    try:
        d = parsedate_to_datetime(s)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None

def source_from_item(item, title):
    src = item.find("source")
    if src is not None and (src.text or "").strip():
        return (src.text or "").strip()
    # Google News titles often end in " - Source".
    if " - " in title:
        return title.rsplit(" - ",1)[-1].strip()
    return ""

def strip_source_suffix(title, source):
    t = html.unescape(title or "").strip()
    if source and t.endswith(" - " + source):
        t = t[:-(len(source)+3)].strip()
    return t

def fetch_news(session: requests.Session, symbol: str, name: str, days=7):
    qname = clean_name(name)
    query = f'"{qname}" 台股' if qname else f"{symbol} 台股"
    # Add symbol without forcing it into every result; company names are usually more precise.
    if qname:
        query += f" OR {symbol}"
    url = (
        "https://news.google.com/rss/search?q=" + quote_plus(query)
        + "&hl=zh-TW&gl=TW&ceid=TW:zh-Hant"
    )
    r = session.get(url, timeout=15)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    seen, out = set(), []
    for item in root.findall(".//item"):
        raw_title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub = parse_pub(item.findtext("pubDate") or "")
        source = source_from_item(item, raw_title)
        title = strip_source_suffix(raw_title, source)
        if pub and pub.astimezone(timezone.utc) < cutoff:
            continue
        # Relevance guard.
        title_compact = re.sub(r"\s+","",title).lower()
        name_compact = re.sub(r"\s+","",qname).lower()
        if qname and name_compact not in title_compact and symbol not in title:
            continue
        key = re.sub(r"\W+","",title.lower())
        if not key or key in seen:
            continue
        seen.add(key)
        out.append({
            "title": title,
            "url": link,
            "source": source,
            "published_at": pub.astimezone(TZ8).isoformat(timespec="minutes") if pub else "",
            "_published": pub,
            "_importance": article_importance(title, pub),
        })
    out.sort(key=lambda x: (x["_importance"], x.get("published_at","")), reverse=True)
    return out[:8]

def market_context(row):
    chg = row.get("change_pct")
    try: chg = float(chg)
    except Exception: chg = None
    typ = str(row.get("type") or "")
    if chg is None:
        reaction = "目前缺少當日漲跌資料。"
    elif chg >= 2:
        reaction = f"當日價格反應偏強（{chg:+.1f}%）。"
    elif chg <= -2:
        reaction = f"當日價格反應偏弱（{chg:+.1f}%）。"
    else:
        reaction = f"當日價格反應相對有限（{chg:+.1f}%）。"

    stage = {
        "breakout":"目前為今日帶量突破 Pivot。",
        "postbreakout":"目前處於突破後追蹤階段。",
        "near":"目前接近 Pivot。",
        "forming":"目前仍在 VCP 成形階段。",
    }.get(typ, "目前 VCP 階段以雷達最新資料為準。")

    bits = []
    if row.get("structure_quality_good"):
        bits.append("💎 結構品質佳")
    score = row.get("score")
    if score is not None:
        bits.append(f"VCP {score}/5")
    if row.get("volume_dry"):
        bits.append("量縮")
    relation = "；".join(bits) if bits else "請搭配 VCP 結構與 Pivot 位置判讀"
    return reaction, stage, relation

def build_stock(row, articles):
    symbol = str(row.get("symbol"))
    name = clean_name(row.get("name") or symbol)
    reaction, stage, relation = market_context(row)
    items = []
    for a in articles[:3]:
        event, impacts, horizon, why = classify(a["title"])
        items.append({
            "title": a["title"],
            "url": a["url"],
            "source": a["source"],
            "published_at": a["published_at"],
            "event": event,
            "why": why,
            "horizon": horizon,
            "possible_impact": impacts,
            "market_reaction": reaction + " " + stage,
            "vcp_relation": relation,
        })
    return {
        "symbol": symbol,
        "name": name,
        "market": "TW",
        "updated_at": datetime.now(TZ8).isoformat(timespec="minutes"),
        "items": items,
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["full","intraday"], default="full")
    ap.add_argument("--full-limit", type=int, default=200)
    ap.add_argument("--intraday-limit", type=int, default=60)
    args = ap.parse_args()

    screening = load_json(SCREENING, {})
    rows = collect_tw_rows(screening)
    rows.sort(key=priority, reverse=True)
    # The current screening ranking is the source of truth for News Impact membership.
    # A full run rebuilds the collection; an intraday run refreshes the top 60 while
    # retaining older news only for stocks still inside the current top-200 universe.
    universe = rows[:args.full_limit]
    targets = universe if args.mode == "full" else universe[:args.intraday_limit]
    allowed_symbols = {str(row.get("symbol", "")) for row in universe}

    previous = load_json(OUT, {})
    previous_stocks = dict(previous.get("stocks") or {})
    if args.mode == "full":
        stocks = {}
    else:
        stocks = {
            symbol: value
            for symbol, value in previous_stocks.items()
            if symbol in allowed_symbols
        }
    session = requests.Session()
    session.headers.update({
        "User-Agent":"Mozilla/5.0 (compatible; VCPulse-NewsImpact/1.0; +https://github.com/pichun21/vcp-stock-tool)"
    })

    ok = fail = 0
    for i,row in enumerate(targets,1):
        symbol = str(row.get("symbol",""))
        name = clean_name(row.get("name") or symbol)
        try:
            arts = fetch_news(session, symbol, name)
            stocks[symbol] = build_stock(row, arts)
            ok += 1
        except Exception as e:
            fail += 1
            # Keep older news when a source is temporarily unavailable.
            if symbol not in stocks:
                stocks[symbol] = build_stock(row, [])
            stocks[symbol]["fetch_error"] = str(e)[:180]
        if i % 20 == 0:
            print(f"[{i}/{len(targets)}] ok={ok} fail={fail}")
        time.sleep(0.12)

    payload = {
        "version":"1.0",
        "status":"ok",
        "market":"TW",
        "mode":args.mode,
        "generated_at":datetime.now(TZ8).isoformat(timespec="seconds"),
        "source_note":"近期新聞由 Google News RSS 公開索引彙整；VCPulse 僅整理事件、可能影響與當下價格反應，不預測新聞一定造成上漲或下跌。",
        "updated_stocks":len(targets),
        "ok":ok,
        "failed":fail,
        "stocks":stocks,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"News Impact done: targets={len(targets)} ok={ok} fail={fail} -> {OUT}")

if __name__ == "__main__":
    main()
