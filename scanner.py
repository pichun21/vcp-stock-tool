# VCPulse BUILD 2.41.41 RESTORE-DATE ENGINE V2 + 2.41.16 QUOTE CACHE + 2.41.13 BENCHMARK PRESERVE + 2.39 OFFICIAL SAFETY GUARD
#!/usr/bin/env python3
import argparse, json, time, os, re
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import requests
import yfinance as yf

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "screening.json"
FINMIND = "https://api.finmindtrade.com/api/v4/data"
TAIPEI = ZoneInfo("Asia/Taipei")

def fetch_tw_universe():
    r=requests.get(FINMIND,params={"dataset":"TaiwanStockInfo"},timeout=45)
    r.raise_for_status()
    rows=r.json().get("data",[])
    if not rows: raise RuntimeError("FinMind TaiwanStockInfo 無資料")
    df=pd.DataFrame(rows)
    df["date"]=pd.to_datetime(df["date"],errors="coerce")
    df=df.sort_values("date").drop_duplicates("stock_id",keep="last")
    df=df[df["type"].isin(["twse","tpex"])]
    bad=df["industry_category"].fillna("").astype(str).str.contains("ETF|Index|大盤|所有證券",case=False,regex=True)
    df=df[~bad]
    df=df[df["stock_id"].astype(str).str.fullmatch(r"\d{4}")]
    out=[]
    for _,r in df.iterrows():
        suffix=".TW" if r["type"]=="twse" else ".TWO"
        out.append({"symbol":str(r["stock_id"]),"name":str(r["stock_name"]),"yf":str(r["stock_id"])+suffix,"exchange":str(r["type"]).upper(),"industry":str(r.get("industry_category") or "其他")})
    return out


def _yf_index_snapshot(ticker, label):
    """Best-effort server-side index quote for GitHub Actions.
    Prefer intraday bars during market hours; fall back to daily bars.
    """
    # 1) Intraday: best source for same-day values during the session.
    try:
        df = yf.download(
            ticker, period="2d", interval="5m",
            auto_adjust=False, progress=False, threads=False,
            prepost=False
        )
        if df is not None and len(df):
            if isinstance(df.columns, pd.MultiIndex):
                close = df["Close"].iloc[:, 0].dropna()
            else:
                close = df["Close"].dropna()
            if len(close):
                last = float(close.iloc[-1])

                # Find the prior completed trading day's last bar as previous close.
                idx = pd.to_datetime(close.index)
                dates = pd.Series(idx.date, index=close.index)
                last_day = dates.iloc[-1]
                prior = close[dates != last_day]
                if len(prior):
                    prev = float(prior.iloc[-1])
                else:
                    prev = float("nan")

                pts = last - prev if np.isfinite(prev) else float("nan")
                pct = (pts / prev * 100) if np.isfinite(prev) and prev else float("nan")
                ts = pd.Timestamp(close.index[-1])
                try:
                    if ts.tzinfo is not None:
                        ts = ts.tz_convert(TAIPEI)
                except Exception:
                    pass

                return {
                    "id": ticker,
                    "label": label,
                    "close": round(last, 2),
                    "change_points": round(pts, 2) if np.isfinite(pts) else None,
                    "change_pct": round(pct, 2) if np.isfinite(pct) else None,
                    "data_time": ts.strftime("%Y-%m-%d %H:%M"),
                    "source": "Yahoo/yfinance intraday"
                }
    except Exception as e:
        print(f"benchmark {ticker} intraday warning:", repr(e))

    # 2) Daily fallback.
    try:
        df = yf.download(
            ticker, period="10d", interval="1d",
            auto_adjust=False, progress=False, threads=False
        )
        if df is not None and len(df) >= 2:
            if isinstance(df.columns, pd.MultiIndex):
                close = df["Close"].iloc[:, 0].dropna()
            else:
                close = df["Close"].dropna()
            if len(close) >= 2:
                last = float(close.iloc[-1])
                prev = float(close.iloc[-2])
                pts = last - prev
                pct = (pts / prev * 100) if prev else 0.0
                d = pd.Timestamp(close.index[-1]).strftime("%Y-%m-%d")
                return {
                    "id": ticker,
                    "label": label,
                    "close": round(last, 2),
                    "change_points": round(pts, 2),
                    "change_pct": round(pct, 2),
                    "data_time": d,
                    "source": "Yahoo/yfinance daily"
                }
    except Exception as e:
        print(f"benchmark {ticker} daily warning:", repr(e))
    return None


def _fetch_tpex_official_close():
    """Official TPEx historical close fallback.
    The public OpenAPI is end-of-day/historical, so it is NOT used as the first
    source for an intraday snapshot.
    """
    try:
        url = "https://www.tpex.org.tw/openapi/v1/tpex_index"
        r = requests.get(
            url, timeout=30,
            headers={
                "User-Agent": "Mozilla/5.0 (VCPulse; GitHub Actions)",
                "Accept": "application/json"
            }
        )
        r.raise_for_status()
        data = r.json()
        if isinstance(data, dict):
            data = data.get("data") or data.get("results") or data.get("result") or []
        if not isinstance(data, list) or not data:
            return None

        def pick(row, names):
            for n in names:
                if n in row and row[n] not in (None, ""):
                    return row[n]
            normalized = {
                str(k).lower().replace(" ", "").replace("_", ""): v
                for k, v in row.items()
            }
            for n in names:
                nk = str(n).lower().replace(" ", "").replace("_", "")
                if nk in normalized and normalized[nk] not in (None, ""):
                    return normalized[nk]
            return None

        parsed = []
        for row in data:
            if not isinstance(row, dict):
                continue
            ds = pick(row, ["Date", "date", "資料日期", "日期"])
            cv = pick(row, ["Close", "close", "收市", "收盤", "收市指數", "Index", "index"])
            if cv in (None, ""):
                continue
            try:
                c = float(str(cv).replace(",", ""))
            except Exception:
                continue
            parsed.append((str(ds or ""), c, row))
        if not parsed:
            return None

        parsed.sort(key=lambda x: x[0])
        ds, last, lastrow = parsed[-1]

        change_raw = pick(lastrow, ["Change", "change", "漲跌", "指數漲跌", "ChangePoints"])
        pts = None
        if change_raw not in (None, ""):
            try:
                pts = float(str(change_raw).replace(",", "").replace("+", ""))
            except Exception:
                pts = None
        if pts is None and len(parsed) >= 2:
            pts = last - parsed[-2][1]
        if pts is None:
            pts = 0.0

        prev = last - pts
        pct = (pts / prev * 100) if prev else 0.0
        return {
            "id": "tpex_index",
            "label": "上櫃｜櫃買指數",
            "close": round(last, 2),
            "change_points": round(pts, 2),
            "change_pct": round(pct, 2),
            "data_time": ds,
            "source": "TPEx official close"
        }
    except Exception as e:
        print("benchmark TPEX official warning:", repr(e))
        return None


def fetch_tw_benchmarks():
    """Fetch Taiwan benchmarks on the GitHub Actions server.

    TWSE and TPEx first try Yahoo/yfinance intraday bars, avoiding browser CORS.
    TPEx official OpenAPI is retained only as an end-of-day fallback.
    """
    out = {}

    twse = _yf_index_snapshot("^TWII", "上市｜加權指數")
    if twse:
        out["TWSE"] = twse

    # Important: during the trading session, prefer a same-day Yahoo/yfinance
    # quote instead of accepting TPEx historical OpenAPI's previous-day close.
    tpex = _yf_index_snapshot("^TWOII", "上櫃｜櫃買指數")
    if not tpex:
        tpex = _yf_index_snapshot("^TWO", "上櫃｜櫃買指數")
    if not tpex:
        tpex = _fetch_tpex_official_close()
    if tpex:
        out["TPEX"] = tpex

    print("TW benchmarks:", {
        k: {"close": v.get("close"), "data_time": v.get("data_time"), "source": v.get("source")}
        for k, v in out.items()
    })
    return out


def fetch_us_benchmarks():
    """Fetch four US benchmark indices for the market dashboard."""
    specs={
        "SOX":("^SOX","費城半導體"),
        "SP500":("^GSPC","S&P 500"),
        "NASDAQ":("^IXIC","NASDAQ"),
        "RUSSELL2000":("^RUT","Russell 2000"),
    }
    out={}
    for key,(ticker,label) in specs.items():
        try:
            df=yf.download(ticker,period="10d",interval="1d",
                           auto_adjust=False,progress=False,threads=False)
            if df is None or len(df)<2:
                raise RuntimeError("not enough rows")
            if isinstance(df.columns,pd.MultiIndex):
                close=df["Close"].iloc[:,0].dropna()
            else:
                close=df["Close"].dropna()
            if len(close)<2:
                raise RuntimeError("not enough closes")
            last=float(close.iloc[-1]); prev=float(close.iloc[-2])
            pts=last-prev; pct=(pts/prev*100) if prev else 0.0
            d=pd.Timestamp(close.index[-1]).strftime("%Y-%m-%d")
            out[key]={
                "id":ticker,"label":label,
                "close":round(last,2),"change_points":round(pts,2),
                "change_pct":round(pct,2),"data_time":d
            }
        except Exception as e:
            print(f"benchmark {key} warning:",repr(e))
    return out

def filter_us_equity_universe(items):
    """Keep listed operating-company equities in the US radar.
    Explicitly removes indices, ETFs, mutual funds and other non-equity instruments.
    Yahoo quoteType is used when available; if Yahoo metadata is temporarily unavailable,
    a conservative name/symbol fallback is used so a metadata outage does not erase stocks.
    """
    if not items:
        return items

    blocked_types={
        "ETF","MUTUALFUND","INDEX","CURRENCY","CRYPTOCURRENCY",
        "FUTURE","OPTION"
    }
    quote_types={}
    headers={
        "User-Agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Accept-Language":"en-US,en;q=0.9"
    }

    symbols=[str(x.get("yf") or x.get("symbol") or "").strip() for x in items]
    symbols=[s for s in symbols if s]

    # Yahoo quote endpoint supports multiple symbols per request, so this adds only
    # a small number of metadata calls even for the full Russell 2000 universe.
    for i in range(0,len(symbols),150):
        chunk=symbols[i:i+150]
        try:
            r=requests.get(
                "https://query1.finance.yahoo.com/v7/finance/quote",
                params={"symbols":",".join(chunk)},
                headers=headers,timeout=25
            )
            r.raise_for_status()
            rows=((r.json() or {}).get("quoteResponse") or {}).get("result") or []
            for q in rows:
                sym=str(q.get("symbol") or "").upper()
                qt=str(q.get("quoteType") or "").upper()
                if sym:
                    quote_types[sym]=qt
        except Exception as e:
            print("US quoteType metadata warning:",repr(e))
            # Fail open: the conservative fallback below will still remove obvious funds/indices.
            break

    kept=[]; removed=[]
    obvious_name_pattern=re.compile(
        r"\b(ETF|ETN|EXCHANGE[- ]TRADED FUND|MUTUAL FUND|INDEX FUND|"
        r"WARRANTS?|RIGHTS?|UNITS?)\b",
        re.I
    )

    for item in items:
        sym=str(item.get("yf") or item.get("symbol") or "").upper()
        name=str(item.get("name") or "")
        qt=quote_types.get(sym,"")

        reason=None
        if sym.startswith("^"):
            reason="index symbol"
        elif qt in blocked_types:
            reason=f"Yahoo quoteType={qt}"
        elif obvious_name_pattern.search(name):
            reason="fund/index derivative name"

        if reason:
            removed.append((item.get("symbol"),name,reason))
        else:
            kept.append(item)

    print(
        f"US equity-only filter: input={len(items)} kept={len(kept)} "
        f"removed_non_equity={len(removed)} metadata={len(quote_types)}"
    )
    if removed:
        preview=", ".join(f"{s}({why})" for s,_,why in removed[:20])
        print("US non-equity removed:",preview)

    # Safety: filtering must never accidentally wipe out a large part of the equity universe.
    if len(items)>=1700 and len(kept)<1600:
        raise RuntimeError(
            f"US equity-only filter removed too many symbols: input={len(items)}, kept={len(kept)}"
        )
    return kept


def clean_us_company_name(name, symbol=""):
    """Remove quote-site price/change/date text accidentally appended to company names."""
    s=str(name or "").strip()
    if not s:
        return str(symbol or "").strip()

    # Examples from constituent source:
    # "Integer Holdings Corp $126.37 +0.13% Latest trade · 9 Sep"
    # "AtriCure, Inc. $53.10 -1.18% Latest trade · 9 Sep"
    s=re.sub(r"\s+\$[\d,]+(?:\.\d+)?\s+[+\-−]?\d+(?:\.\d+)?%\s+Latest\s+trade\b.*$","",s,flags=re.I)
    s=re.sub(r"\s+Latest\s+trade\b.*$","",s,flags=re.I)
    # Conservative trailing quote cleanup if wording changes but price/change remains.
    s=re.sub(r"\s+\$[\d,]+(?:\.\d+)?\s+[+\-−]?\d+(?:\.\d+)?%\s*$","",s)
    s=re.sub(r"\s{2,}"," ",s).strip(" ·|-")
    return s or str(symbol or "").strip()


def fetch_us_universe():
    """US universe: S&P 500 + Nasdaq-100 + SOX + Russell 2000 proxy.
    Uses separate, simpler constituent sources and refuses to silently continue
    with a severely incomplete US universe.
    """
    import io
    headers={
        "User-Agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Accept-Language":"en-US,en;q=0.9"
    }
    tickers={}

    def add(symbol,name=None,source=None):
        s=str(symbol or "").strip().upper().replace(".","-")
        if not s or s in ("NAN","-","--","CASH","USD") or len(s)>12:
            return
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9\-]*",s):
            return
        if s not in tickers:
            clean_name=clean_us_company_name(name or s,s)
            tickers[s]={"symbol":s,"name":clean_name,"yf":s,"sources":[]}
        if source and source not in tickers[s]["sources"]:
            tickers[s]["sources"].append(source)

    def get_text(url, timeout=45):
        r=requests.get(url,headers=headers,timeout=timeout)
        r.raise_for_status()
        return r.text

    # S&P 500
    sp_count=0
    try:
        html=get_text("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies")
        tables=pd.read_html(io.StringIO(html))
        table=next(t for t in tables if "Symbol" in t.columns and "Security" in t.columns)
        for _,r in table.iterrows():
            add(r.get("Symbol"),r.get("Security"),"SP500")
        sp_count=sum("SP500" in x["sources"] for x in tickers.values())
        print(f"US source SP500 loaded: {sp_count}")
    except Exception as e:
        print("US source SP500 FAILED:",repr(e))

    # Nasdaq-100: purpose-built constituent CSV (Yahoo-compatible symbols).
    nd_count=0
    try:
        url="https://yfiua.github.io/index-constituents/constituents-nasdaq100.csv"
        text=get_text(url)
        df=pd.read_csv(io.StringIO(text))
        # This dataset may be one-symbol-per-row or a current snapshot format.
        symbol_col=next((c for c in df.columns if str(c).lower() in ("ticker","tickers","symbol","symbols")),None)
        if symbol_col is not None:
            vals=[]
            for v in df[symbol_col].dropna():
                vals.extend(re.split(r"[\s,;]+",str(v).strip()))
            for s in vals: add(s,s,"NASDAQ100")
        else:
            # fallback: collect cells that look like tickers
            for v in df.astype(str).values.ravel():
                for s in re.split(r"[\s,;]+",str(v).strip()):
                    if re.fullmatch(r"[A-Z]{1,6}(?:-[A-Z])?",s):
                        add(s,s,"NASDAQ100")
        nd_count=sum("NASDAQ100" in x["sources"] for x in tickers.values())
        if nd_count < 80:
            raise RuntimeError(f"Nasdaq-100 parsed only {nd_count} symbols")
        print(f"US source NASDAQ100 loaded: {nd_count}")
    except Exception as e:
        print("US source NASDAQ100 FAILED:",repr(e))

    # SOX independent basket
    sox_symbols=[
        "AMD","ADI","AMAT","ARM","ASML","ALAB","AVGO","COHR","CRDO","ENTG",
        "GFS","INTC","KLAC","LRCX","MTSI","MRVL","MCHP","MU","MPWR","NVDA",
        "NXPI","ON","QCOM","RMBS","TER","TSM","TXN"
    ]
    for s in sox_symbols: add(s,s,"SOX")
    sox_count=sum("SOX" in x["sources"] for x in tickers.values())
    print(f"US source SOX loaded: {sox_count}")

    # Russell 2000 proxy: complete public constituent table derived from IWM holdings.
    r2k_count=0
    try:
        html=get_text("https://equibles.com/indexes/russell-2000",timeout=60)
        tables=pd.read_html(io.StringIO(html))
        candidates=[]
        for t in tables:
            cols=[str(c).strip().lower() for c in t.columns]
            tc=next((c for c in t.columns if str(c).strip().lower()=="ticker"),None)
            if tc is not None:
                candidates.append((len(t),t,tc))
        if not candidates:
            raise RuntimeError("Russell 2000 constituent table not found")
        _,table,ticker_col=max(candidates,key=lambda x:x[0])
        name_col=next((c for c in table.columns if "company" in str(c).lower() or "name" in str(c).lower()),None)
        for _,r in table.iterrows():
            add(r.get(ticker_col),r.get(name_col) if name_col is not None else r.get(ticker_col),"RUSSELL2000")
        r2k_count=sum("RUSSELL2000" in x["sources"] for x in tickers.values())
        if r2k_count < 1500:
            raise RuntimeError(f"Russell 2000 parsed only {r2k_count} symbols")
        print(f"US source RUSSELL2000 loaded: {r2k_count}")
        dirty_names=sum(
            1 for x in tickers.values()
            if "RUSSELL2000" in x.get("sources",[]) and
               ("Latest trade" in str(x.get("name","")) or re.search(r"\$[\d,]+(?:\.\d+)?\s+[+\-−]?\d+(?:\.\d+)?%",str(x.get("name",""))))
        )
        print(f"US Russell company-name cleanup: remaining_dirty={dirty_names}")
    except Exception as e:
        print("US source RUSSELL2000 FAILED:",repr(e))

    out=list(tickers.values())
    print("US universe summary:",
          f"SP500={sp_count}",f"NASDAQ100={nd_count}",f"SOX={sox_count}",
          f"RUSSELL2000={r2k_count}",f"DEDUPED={len(out)}")

    # Critical guard: a green Action must not hide a partial ~500-stock universe.
    if r2k_count < 1500 or nd_count < 80 or len(out) < 1700:
        raise RuntimeError(
            "US universe incomplete — stopping scan instead of publishing partial data. "
            f"SP500={sp_count}, NASDAQ100={nd_count}, SOX={sox_count}, "
            f"RUSSELL2000={r2k_count}, DEDUPED={len(out)}"
        )

    # Radar is for individual listed companies only.
    # NDAQ (Nasdaq, Inc.) remains because it is an EQUITY; ^IXIC/ETF/funds do not.
    out=filter_us_equity_universe(out)
    print(f"US universe after equity-only filter: {len(out)}")
    return out

def local_turns(close):
    vals=np.asarray(close,float); p=[]
    for i in range(3,len(vals)-3):
        w=vals[i-3:i+4]
        if vals[i]==np.nanmax(w): p.append((i,"H",vals[i]))
        if vals[i]==np.nanmin(w): p.append((i,"L",vals[i]))
    q=[]
    for item in p:
        if not q or q[-1][1]!=item[1]: q.append(item)
        elif (item[1]=="H" and item[2]>q[-1][2]) or (item[1]=="L" and item[2]<q[-1][2]): q[-1]=item
    return q

def analyze(df,item,market):
    df=df.dropna(subset=["Close"]).copy()
    if len(df)<170: return None
    close=df["Close"].astype(float); vol=df["Volume"].fillna(0).astype(float)
    ma50=close.rolling(50).mean().iloc[-1]; ma150=close.rolling(150).mean().iloc[-1]
    trend=bool(close.iloc[-1]>ma50>ma150)
    piv=local_turns(close.values); drops=[]
    for a,b in zip(piv,piv[1:]):
        if a[1]=="H" and b[1]=="L" and a[2]>0: drops.append((a[0],b[0],(a[2]-b[2])/a[2]*100))
    drops=drops[-4:]; seq=[x[2] for x in drops]
    contracting=len(seq)>=2 and all(seq[i]<seq[i-1]*1.12 for i in range(1,len(seq)))
    recent=close.iloc[-35:]; pivot=float(recent.iloc[:-3].max()); last=float(close.iloc[-1])
    distance=(last/pivot-1)*100
    v20=float(vol.iloc[-20:].mean())
    vprev=float(vol.iloc[-60:-20].mean()) if len(vol)>=60 else float(vol.iloc[:-20].mean())
    dry=bool(vprev>0 and v20<vprev*0.85)
    breakout=last>pivot; breakout_vol=bool(v20>0 and vol.iloc[-1]>v20*1.35)
    prev=float(close.iloc[-2]); change_pct=((last/prev)-1)*100 if prev else 0.0; today_breakout=bool(prev<=pivot and breakout and breakout_vol)
    score=sum([trend,len(seq)>=2,contracting,dry,today_breakout or ((not breakout) and distance>-8)])

    high=pd.to_numeric(df["High"],errors="coerce"); low=pd.to_numeric(df["Low"],errors="coerce")
    bb_mid=close.rolling(20).mean(); bb_std=close.rolling(20).std(ddof=0)
    bb_upper=bb_mid+2*bb_std; bb_lower=bb_mid-2*bb_std
    ema20=close.ewm(span=20,adjust=False).mean(); prev_close=close.shift(1)
    tr=pd.concat([(high-low).abs(),(high-prev_close).abs(),(low-prev_close).abs()],axis=1).max(axis=1)
    atr20=tr.rolling(20).mean()
    def inside_kc(mult):
        return bool(bb_upper.iloc[-1]<(ema20.iloc[-1]+atr20.iloc[-1]*mult) and bb_lower.iloc[-1]>(ema20.iloc[-1]-atr20.iloc[-1]*mult))
    if inside_kc(1.0): squeeze_level,squeeze_state="strong","🔴 強力壓縮"
    elif inside_kc(1.5): squeeze_level,squeeze_state="medium","🟠 中度壓縮"
    elif inside_kc(2.0): squeeze_level,squeeze_state="weak","🩷 一般壓縮"
    else: squeeze_level,squeeze_state="none","⚪ 無壓縮"

    mom=close-close.rolling(20).mean(); m_now,m_prev=float(mom.iloc[-1]),float(mom.iloc[-2])
    if m_now>=0 and m_now>=m_prev: momentum,momentum_dir="↑ 多方增強","bull_up"
    elif m_now>=0: momentum,momentum_dir="↘ 多方減弱","bull_down"
    elif m_now<0 and m_now<=m_prev: momentum,momentum_dir="↓ 空方增強","bear_down"
    else: momentum,momentum_dir="↗ 空方減弱","bear_up"
    combo=bool(squeeze_level!="none" and score>=4)

    avg_value=float((close.iloc[-20:]*vol.iloc[-20:]).mean())
    min_liq=20_000_000 if market=="TW" else 10_000_000
    if avg_value<min_liq or score<4: return None

    breakout_days=None
    if breakout:
        vals=close.iloc[-11:].tolist()
        for i in range(len(vals)-1,0,-1):
            if vals[i-1]<=pivot and vals[i]>pivot:
                breakout_days=(len(vals)-1)-i; break
    if today_breakout:
        typ,state="breakout","🟢 今日帶量突破"; breakout_days=0
    elif breakout and breakout_days is not None and breakout_days<=5 and distance<=12:
        typ,state="postbreakout",f"🔵 突破後第 {breakout_days+1} 天"
    elif not breakout and distance>-5: typ,state="near","🟡 接近 Pivot"
    elif not breakout: typ,state="forming","⚪ VCP 成形中"
    else: return None
    if distance>12: return None

    signal_points=0; signal_reasons=[]
    if score>=5: signal_points+=2; signal_reasons.append("VCP 5/5")
    elif score>=4: signal_points+=1; signal_reasons.append("VCP 4/5")
    if typ=="breakout": signal_points+=3; signal_reasons.append("今日帶量突破")
    elif typ=="postbreakout": signal_points+=2; signal_reasons.append("突破後仍守 Pivot")
    elif typ=="near": signal_points+=2; signal_reasons.append("接近 Pivot")
    if squeeze_level=="strong": signal_points+=2; signal_reasons.append("強力壓縮")
    elif squeeze_level=="medium": signal_points+=1; signal_reasons.append("中度壓縮")
    elif squeeze_level=="weak": signal_points+=0.5; signal_reasons.append("一般壓縮")
    if momentum_dir=="bull_up": signal_points+=2; signal_reasons.append("多方增強")
    elif momentum_dir=="bear_up": signal_points+=1; signal_reasons.append("空方減弱")
    if typ=="postbreakout" and distance>8:
        pulse_signal,pulse_label="extended","⚠️ 過度延伸"; signal_reasons.append("突破後距 Pivot 超過 8%")
    elif signal_points>=7: pulse_signal,pulse_label="hot","🔥 高關注"
    elif signal_points>=5: pulse_signal,pulse_label="watch","👀 觀察"
    else: pulse_signal,pulse_label="wait","⏳ 等待"

    return {
        "market":market,"symbol":item["symbol"],"name":item["name"],"exchange":item.get("exchange",""),"score":int(score),
        "contracts":" → ".join(f"-{x:.0f}%" for x in seq) if seq else "—",
        "pivot":round(pivot,2),"last":round(last,2),"distance":round(distance,2),"change_pct":round(change_pct,2),
        "volume_dry":dry,"type":typ,"state":state,"squeeze_level":squeeze_level,
        "squeeze_state":squeeze_state,"momentum":momentum,"momentum_dir":momentum_dir,
        "combo":combo,"breakout_days":breakout_days,"holding_pivot":bool(last>pivot),
        "pulse_signal":pulse_signal,"pulse_label":pulse_label,"pulse_points":signal_points,
        "pulse_reasons":signal_reasons,"data_date":df.index[-1].strftime("%Y-%m-%d"),
        "avg_value_20d":round(avg_value,0),
    }



COMMON_SPLIT_RATIOS = (2, 3, 4, 5, 10, 20, 50, 100)

def _nearest_common_ratio(x, tolerance=0.12):
    try:
        x=float(x)
    except Exception:
        return None
    if not np.isfinite(x) or x < 1.5:
        return None
    best=min(COMMON_SPLIT_RATIOS,key=lambda r:abs(x/r-1))
    return float(best) if abs(x/best-1) <= tolerance else None

def _window_median(series, start, end):
    s=pd.to_numeric(series.iloc[start:end],errors="coerce").dropna()
    if len(s)==0:
        return float("nan")
    return float(s.median())

def _window_stability(series, start, end):
    s=pd.to_numeric(series.iloc[start:end],errors="coerce").dropna()
    if len(s)<2:
        return 0.0
    med=float(s.median())
    if not np.isfinite(med) or med<=0:
        return 999.0
    return float((s-med).abs().median()/med)

def _confirm_yahoo_split(ticker, restore_date, share_ratio):
    """Best-effort Yahoo corporate-action confirmation for strong candidates only."""
    try:
        splits=yf.Ticker(ticker).splits
        if splits is None or len(splits)==0:
            return None
        rd=pd.Timestamp(restore_date)
        expected=float(share_ratio)
        best=None
        for idx,val in splits.items():
            try:
                dt=pd.Timestamp(idx)
                if dt.tzinfo is not None:
                    dt=dt.tz_localize(None)
                days=abs((dt.normalize()-rd.normalize()).days)
                ratio=float(val)
            except Exception:
                continue
            if days>21 or not np.isfinite(ratio) or ratio<=0:
                continue
            err=abs(ratio/expected-1) if expected else 999
            if err<=0.18 and (best is None or days<best["days"]):
                best={"event_date":dt.strftime("%Y-%m-%d"),"ratio":ratio,"days":days}
        return best
    except Exception:
        return None

def detect_restore_events(df, item=None):
    """Detect split / face-value price-scale changes from persistent raw prices."""
    if df is None or df.empty or "Close" not in df.columns:
        return []

    usable=df.dropna(subset=["Close"]).copy()
    if len(usable)<8:
        return []

    close=pd.to_numeric(usable["Close"],errors="coerce")
    volume=(pd.to_numeric(usable["Volume"],errors="coerce")
            if "Volume" in usable.columns else pd.Series(index=usable.index,dtype=float))
    events=[]

    for i in range(3, len(usable)-2):
        prev=float(close.iloc[i-1]) if pd.notna(close.iloc[i-1]) else float("nan")
        cur=float(close.iloc[i]) if pd.notna(close.iloc[i]) else float("nan")
        if not (np.isfinite(prev) and np.isfinite(cur) and prev>0 and cur>0):
            continue

        adjacent=cur/prev
        if 0.60 <= adjacent <= 1.67:
            continue

        if adjacent < 1:
            magnitude=_nearest_common_ratio(1.0/adjacent, tolerance=0.15)
            if magnitude is None:
                continue
            expected=1.0/magnitude
            pre_multiplier=1.0/magnitude
            share_ratio=magnitude
            direction="split"
        else:
            magnitude=_nearest_common_ratio(adjacent, tolerance=0.15)
            if magnitude is None:
                continue
            expected=magnitude
            pre_multiplier=magnitude
            share_ratio=1.0/magnitude
            direction="reverse_split"

        pre_med=_window_median(close, i-3, i)
        post_med=_window_median(close, i, min(len(close), i+3))
        if not (np.isfinite(pre_med) and np.isfinite(post_med) and pre_med>0 and post_med>0):
            continue

        observed=post_med/pre_med
        ratio_error=abs(observed/expected-1)
        adjacent_error=abs(adjacent/expected-1)
        if ratio_error>0.12 or adjacent_error>0.18:
            continue

        pre_stability=_window_stability(close, i-3, i)
        post_stability=_window_stability(close, i, min(len(close), i+3))
        if pre_stability>0.22 or post_stability>0.22:
            continue

        volume_support=None
        try:
            pre_v=_window_median(volume, i-3, i)
            post_v=_window_median(volume, i, min(len(volume), i+3))
            if np.isfinite(pre_v) and np.isfinite(post_v) and pre_v>0 and post_v>0:
                volume_support=round(post_v/pre_v,3)
        except Exception:
            pass

        idx=usable.index[i]
        restore_date=idx.strftime("%Y-%m-%d") if hasattr(idx,"strftime") else str(idx)[:10]

        yahoo=None
        if item and item.get("yf"):
            yahoo=_confirm_yahoo_split(item["yf"], restore_date, share_ratio)

        status="confirmed_by_price_scale_persistence"
        source="Yahoo raw price persistence"
        event_date=""
        if yahoo:
            status="confirmed_by_yahoo_split_and_price"
            source="Yahoo split event + raw price persistence"
            event_date=yahoo["event_date"]

        ev={
            "restore_date":restore_date,
            "event_date":event_date,
            "pre_price_multiplier":round(float(pre_multiplier),8),
            "share_ratio":round(float(share_ratio),8),
            "direction":direction,
            "observed_price_ratio":round(float(observed),6),
            "ratio_error_pct":round(float(ratio_error*100),2),
            "adjacent_error_pct":round(float(adjacent_error*100),2),
            "pre_stability_pct":round(float(pre_stability*100),2),
            "post_stability_pct":round(float(post_stability*100),2),
            "volume_ratio_post_pre":volume_support,
            "source":source,
            "status":status
        }

        if events and abs((pd.Timestamp(restore_date)-pd.Timestamp(events[-1]["restore_date"])).days)<=5:
            continue
        events.append(ev)

    return events

def apply_restore_events_df(df, events):
    """Put all OHLC/Volume on the latest post-event scale."""
    if df is None or df.empty or not events:
        return df.copy() if df is not None else df

    out=df.copy()
    idx_dates=pd.Series([pd.Timestamp(x).strftime("%Y-%m-%d") for x in out.index],index=out.index)

    for ev in sorted(events,key=lambda x:str(x.get("restore_date",""))):
        rd=str(ev.get("restore_date") or "")
        mult=float(ev.get("pre_price_multiplier") or 1)
        if not rd or not np.isfinite(mult) or mult<=0 or abs(mult-1)<1e-12:
            continue

        mask=idx_dates < rd
        for col in ("Open","High","Low","Close","Adj Close"):
            if col in out.columns:
                vals=pd.to_numeric(out[col],errors="coerce")
                out.loc[mask,col]=vals.loc[mask]*mult
        if "Volume" in out.columns:
            vals=pd.to_numeric(out["Volume"],errors="coerce")
            out.loc[mask,"Volume"]=vals.loc[mask]/mult

    return out


def download_batch(items,market):
    tickers=[x["yf"] for x in items]
    try:
        raw=yf.download(tickers=tickers,period="1y",interval="1d",group_by="ticker",auto_adjust=False,progress=False,threads=True,timeout=30)
    except Exception as e:
        print("batch download failed",e); return [], [], [], {}, {}
    results=[]; dates=[]; flows=[]; quotes={}; restore_events={}
    for item in items:
        try:
            if len(tickers)==1: d=raw
            else:
                if item["yf"] not in raw.columns.get_level_values(0): continue
                d=raw[item["yf"]]
            if d is None or d.empty: continue
            usable=d.dropna(subset=["Close"]) if "Close" in d.columns else d.dropna(how="all")
            if usable is None or usable.empty: continue
            data_date=usable.index[-1].strftime("%Y-%m-%d")
            dates.append(data_date)

            # V2.41.40: record restore dates for every valid symbol, not only radar candidates.
            ev=detect_restore_events(d,item)
            if ev:
                restore_events[str(item["symbol"]).upper()]=ev
                for _ev in ev:
                    sr=float(_ev.get("share_ratio") or 0)
                    ratio_text=(f"1→{sr:g}" if sr>=1 else f"{1/sr:g}→1")
                    print(
                        f"{market} RESTORE CONFIRMED: {item['symbol']} {item.get('name','')} | "
                        f"{_ev.get('restore_date')} | shares {ratio_text} | "
                        f"price x{float(_ev.get('pre_price_multiplier') or 1):g} | "
                        f"{_ev.get('status')}"
                    )

            # V2.41.16: all-stock latest quote cache.
            # yfinance daily bars already used by the scanner normally contain the
            # current session's partial daily Close during market hours. Keep the
            # latest/previous close for EVERY valid universe symbol, not only VCP candidates.
            if "Close" in usable.columns:
                c=pd.to_numeric(usable["Close"],errors="coerce")
                if len(c)>=2 and pd.notna(c.iloc[-1]) and pd.notna(c.iloc[-2]):
                    px=float(c.iloc[-1]); prev=float(c.iloc[-2])
                    if np.isfinite(px) and px>0 and np.isfinite(prev) and prev>0:
                        quotes[str(item["symbol"]).upper()]={
                            "price":round(px,4),
                            "prev_close":round(prev,4),
                            "data_date":data_date,
                            "name":item.get("name") or "",
                            "source":"VCPulse scanner"
                        }

            # V2.41: keep a lightweight all-market capital-flow observation.
            # Yahoo daily Volume * Close is used as an estimated traded-value proxy.
            # This is for relative industry heat, not an official net-capital-flow figure.
            if market=="TW" and "Close" in usable.columns and "Volume" in usable.columns:
                c=pd.to_numeric(usable["Close"],errors="coerce")
                v=pd.to_numeric(usable["Volume"],errors="coerce").fillna(0)
                value=(c*v).replace([np.inf,-np.inf],np.nan)
                if len(c)>=2 and pd.notna(c.iloc[-1]) and pd.notna(c.iloc[-2]):
                    latest_value=float(value.iloc[-1]) if pd.notna(value.iloc[-1]) else 0.0
                    hist=value.iloc[-21:-1].dropna()
                    avg20=float(hist.mean()) if len(hist) else 0.0
                    chg=(float(c.iloc[-1])/float(c.iloc[-2])-1)*100 if float(c.iloc[-2]) else 0.0
                    flows.append({
                        "symbol":item["symbol"],"industry":item.get("industry") or "其他",
                        "data_date":data_date,"value":latest_value,"avg20_value":avg20,
                        "change_pct":chg,"up":bool(chg>0)
                    })

            # V2.41.41: VCP uses the confirmed restore-date events.
            # Raw `d` remains unchanged for quote cache and capital-hotspot value.
            vcp_d=apply_restore_events_df(d,ev)
            r=analyze(vcp_d,item,market)
            if r:
                r["industry"]=item.get("industry") or ""
                r["split_adjusted"]=bool(ev)
                if ev:
                    r["restore_events"]=ev
                results.append(r)
        except Exception as e: print("analyze warning",item["symbol"],e)
    return results, dates, flows, quotes, restore_events

def build_capital_hotspots(flow_rows, candidate_rows, topn=5):
    """Build VCPulse industry heat from broad-market observations.
    This is an activity/attention model, not official buy/sell net flow.
    """
    if not flow_rows:
        return []
    df=pd.DataFrame(flow_rows)
    df=df[(df["industry"].fillna("")!="") & (df["industry"]!="其他")]
    if df.empty: return []
    latest=max(df["data_date"].astype(str))
    df=df[df["data_date"].astype(str)==latest].copy()
    if df.empty: return []

    g=df.groupby("industry",dropna=False).agg(
        stock_count=("symbol","count"),
        trading_value=("value","sum"),
        avg20_value=("avg20_value","sum"),
        up_count=("up","sum"),
        avg_change_pct=("change_pct","mean")
    ).reset_index()
    # Avoid tiny classifications dominating the ranking.
    g=g[g["stock_count"]>=3].copy()
    if g.empty: return []

    total_value=float(g["trading_value"].sum()) or 1.0
    g["market_share_pct"]=g["trading_value"]/total_value*100
    g["value_ratio"]=np.where(g["avg20_value"]>0,g["trading_value"]/g["avg20_value"],1.0)
    g["breadth_pct"]=g["up_count"]/g["stock_count"]*100

    cand=pd.DataFrame(candidate_rows or [])
    if not cand.empty and "industry" in cand.columns:
        cg=cand.groupby("industry").agg(
            vcp_count=("symbol","count"),
            breakout_count=("type",lambda s:int((s=="breakout").sum()))
        )
        g=g.merge(cg,left_on="industry",right_index=True,how="left")
    else:
        g["vcp_count"]=0; g["breakout_count"]=0
    g[["vcp_count","breakout_count"]]=g[["vcp_count","breakout_count"]].fillna(0)

    def pct_rank(series):
        if len(series)<=1: return pd.Series([50.0]*len(series),index=series.index)
        return series.rank(pct=True,method="average")*100

    # 0–100 composite: traded-value acceleration, market share, breadth,
    # price momentum, VCP concentration and breakout concentration.
    g["heat_score"]=(
        pct_rank(g["value_ratio"])*0.35 +
        pct_rank(g["market_share_pct"])*0.25 +
        pct_rank(g["breadth_pct"])*0.15 +
        pct_rank(g["avg_change_pct"])*0.10 +
        pct_rank(g["vcp_count"]/g["stock_count"])*0.10 +
        pct_rank(g["breakout_count"]/g["stock_count"])*0.05
    ).round().clip(0,100).astype(int)

    def level(x):
        if x>=80: return ("hot","🔥 強力升溫")
        if x>=65: return ("warming","🟠 資金升溫")
        if x>=50: return ("active","🟡 持續活躍")
        return ("cooling","🔵 資金降溫")

    rows=[]
    for _,r in g.sort_values(["heat_score","trading_value"],ascending=[False,False]).head(topn).iterrows():
        key,label=level(int(r["heat_score"]))
        rows.append({
            "industry":str(r["industry"]),
            "heat_score":int(r["heat_score"]),
            "heat_level":key,
            "heat_label":label,
            "market_share_pct":round(float(r["market_share_pct"]),1),
            "value_ratio":round(float(r["value_ratio"]),2),
            "breadth_pct":round(float(r["breadth_pct"]),1),
            "avg_change_pct":round(float(r["avg_change_pct"]),2),
            "vcp_count":int(r["vcp_count"]),
            "breakout_count":int(r["breakout_count"]),
            "stock_count":int(r["stock_count"]),
            "data_date":latest
        })
    return rows

def scan(market):
    universe=fetch_tw_universe() if market=="TW" else fetch_us_universe()
    print(f"{market}: universe {len(universe)}")
    batch_size=120 if market=="TW" else 120
    batches=[universe[i:i+batch_size] for i in range(0,len(universe),batch_size)]
    results=[]; latest_dates=[]; flow_rows=[]; quote_cache={}; restore_event_cache={}
    for i,b in enumerate(batches,1):
        print(f"{market}: batch {i}/{len(batches)}")
        batch_results,batch_dates,batch_flows,batch_quotes,batch_restore_events=download_batch(b,market)
        results.extend(batch_results); latest_dates.extend(batch_dates); flow_rows.extend(batch_flows); quote_cache.update(batch_quotes); restore_event_cache.update(batch_restore_events); time.sleep(1)
    state_rank={"breakout":0,"postbreakout":1,"near":2,"forming":3}
    results.sort(key=lambda r:(state_rank.get(r["type"],9),-r["score"],abs(r["distance"])))
    today=datetime.now(TAIPEI).strftime("%Y-%m-%d")
    valid=len(latest_dates); today_count=sum(1 for d in latest_dates if d==today)
    stats={
        "universe":len(universe), "valid":valid, "today":today_count,
        "valid_pct":round(valid/max(len(universe),1)*100,1),
        "today_pct":round(today_count/max(valid,1)*100,1),
        "latest_date":max(latest_dates,default="")
    }
    hotspots=build_capital_hotspots(flow_rows,results) if market=="TW" else []
    print(f"{market} DATA CHECK: latest={stats['latest_date']} today={stats['today']}/{stats['valid']} ({stats['today_pct']}%) valid={stats['valid']}/{stats['universe']} ({stats['valid_pct']}%)")
    if hotspots:
        print("TW CAPITAL HOTSPOTS:", " | ".join(f"{x['industry']} {x['heat_score']}" for x in hotspots))
    split_count=sum(1 for r in results if r.get("split_adjusted"))
    if split_count:
        print(f"{market} SPLIT-SAFE VCP: adjusted {split_count} radar candidates")
    print(f"{market} ALL-STOCK QUOTE CACHE: {len(quote_cache)} symbols")
    if restore_event_cache:
        print(f"{market} RESTORE-DATE CACHE: {len(restore_event_cache)} symbols / {sum(len(v) for v in restore_event_cache.values())} events")
    return results[:150], stats, hotspots, quote_cache, restore_event_cache

def load_existing():
    if OUT.exists():
        try: return json.loads(OUT.read_text(encoding="utf-8"))
        except Exception: pass
    return {"results":[],"markets":{}}

def new_reason(r):
    if r.get("type")=="breakout": return "今日帶量突破後新進雷達"
    if r.get("type")=="near": return "今日進入 Pivot 接近區並新進雷達"
    sq=r.get("squeeze_level")
    if sq in ("strong","medium","weak"):
        label={"strong":"強力壓縮","medium":"中度壓縮","weak":"一般壓縮"}[sq]
        return f"今日達到 VCP {r.get('score',4)}/5 入選門檻，且為{label}"
    return f"今日達到 VCP {r.get('score',4)}/5 入選門檻"

def apply_new_flags(rows, old_rows, old_data_date):
    if not rows:
        return rows

    new_date=max((r.get("data_date") or "" for r in rows),default="")

    # First activation / no prior comparison baseline:
    # establish the baseline only, and do NOT label anything as NEW.
    # This prevents a false batch of NEW badges on the day the feature is introduced.
    if not old_data_date:
        for r in rows:
            r["is_new"]=False
            r["new_reason"]=""
        return rows

    # Re-running on the same trading day must preserve the original NEW flags.
    if new_date==old_data_date:
        old_map={(str(r.get("market")),str(r.get("symbol"))):r for r in old_rows}
        for r in rows:
            prev=old_map.get((str(r.get("market")),str(r.get("symbol"))),{})
            r["is_new"]=bool(prev.get("is_new",False))
            r["new_reason"]=prev.get("new_reason","") if r["is_new"] else ""
        return rows

    # New trading day: compare with the previous completed radar list.
    old_keys={(str(r.get("market")),str(r.get("symbol"))) for r in old_rows}
    for r in rows:
        key=(str(r.get("market")),str(r.get("symbol")))
        r["is_new"]=key not in old_keys
        r["new_reason"]=new_reason(r) if r["is_new"] else ""
    return rows

def is_tw_official_snapshot(rows):
    """TW NEW baseline is only advanced after the cash market has closed.
    Manual intraday runs may refresh the radar, but must not alter NEW comparison state.
    """
    if not rows:
        return False
    now=datetime.now(TAIPEI)
    data_date=max((r.get("data_date") or "" for r in rows),default="")
    today=now.strftime("%Y-%m-%d")
    # If the latest available bar is from an earlier trading day, it is already a completed session.
    if data_date and data_date < today:
        return True
    # For today's bar, require a post-close buffer so the daily bar/volume has time to settle.
    return bool(data_date == today and (now.hour > 14 or (now.hour == 14 and now.minute >= 30)))


def _split_market(rows, market):
    return [r for r in (rows or []) if r.get("market")==market]

def _replace_market(base_rows, market, new_rows):
    return [r for r in (base_rows or []) if r.get("market")!=market] + list(new_rows or [])

def _meta_is_intraday(meta, payload_generated_at=None):
    """Infer whether an older payload represents a TW intraday snapshot."""
    if not meta:
        return False
    if meta.get("snapshot_type")=="intraday":
        return True
    data_date=meta.get("data_date")
    if not data_date:
        return False
    now=datetime.now(TAIPEI)
    if data_date != now.strftime("%Y-%m-%d"):
        return False
    stamp=meta.get("scanned_at") or payload_generated_at or ""
    try:
        hhmm=stamp.split(" ")[-1]
        hh,mm=[int(x) for x in hhmm.split(":")[:2]]
        return (hh,mm) < (14,30)
    except Exception:
        return now.hour < 14 or (now.hour==14 and now.minute<30)

def recover_previous_official_tw(current_data_date):
    """One-time migration safety net.
    If an intraday run already overwrote screening.json before V2.21,
    recover the newest earlier TW completed-session snapshot from GitHub history.
    """
    repo=os.environ.get("GITHUB_REPOSITORY","pichun21/vcp-stock-tool")
    try:
        headers={"Accept":"application/vnd.github+json","User-Agent":"VCPulse-migration"}
        token=os.environ.get("GITHUB_TOKEN")
        if token:
            headers["Authorization"]=f"Bearer {token}"
        api=f"https://api.github.com/repos/{repo}/commits"
        resp=requests.get(api,params={"path":"screening.json","per_page":30},headers=headers,timeout=30)
        resp.raise_for_status()
        commits=resp.json()
        for c in commits:
            sha=c.get("sha")
            if not sha:
                continue
            raw=f"https://raw.githubusercontent.com/{repo}/{sha}/screening.json"
            rr=requests.get(raw,headers={"User-Agent":"VCPulse-migration"},timeout=30)
            if not rr.ok:
                continue
            try:
                j=rr.json()
            except Exception:
                continue
            rows=j.get("official_results") or j.get("results") or []
            tw=_split_market(rows,"TW")
            if not tw:
                continue
            d=max((r.get("data_date") or "" for r in tw),default="")
            if d and current_data_date and d < current_data_date:
                meta=(j.get("official_markets") or j.get("markets") or {}).get("TW",{})
                for r in tw:
                    r.setdefault("is_new",False)
                    r.setdefault("new_reason","")
                print(f"Recovered previous official TW snapshot {d} from {sha[:7]}")
                return tw, {
                    "data_date":d,
                    "count":len(tw),
                    "scanned_at":meta.get("scanned_at") or j.get("generated_at"),
                    "snapshot_type":"official"
                }
    except Exception as e:
        print("previous official recovery warning:",e)
    return [], {}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--market",choices=["TW","US","both"],default="both")
    ap.add_argument(
        "--snapshot",
        choices=["auto","intraday","official"],
        default="auto",
        help="Where to store this run. Manual Actions should pass intraday/official explicitly."
    )
    args=ap.parse_args()

    old=load_existing()
    old_results=old.get("results",[]) or []
    old_markets=old.get("markets",{}) or {}

    # V2.21 stores completed-session and intraday snapshots separately.
    official_results=list(old.get("official_results",[]) or [])
    intraday_results=list(old.get("intraday_results",[]) or [])
    official_markets=dict(old.get("official_markets",{}) or {})
    intraday_markets=dict(old.get("intraday_markets",{}) or {})
    official_benchmarks=dict(old.get("official_benchmarks",{}) or {})
    intraday_benchmarks=dict(old.get("intraday_benchmarks",{}) or {})
    official_capital_hotspots=dict(old.get("official_capital_hotspots",{}) or {})
    intraday_capital_hotspots=dict(old.get("intraday_capital_hotspots",{}) or {})
    official_quotes=dict(old.get("official_quotes",{}) or {})
    intraday_quotes=dict(old.get("intraday_quotes",{}) or {})
    official_restore_events=dict(old.get("official_restore_events",{}) or {})
    intraday_restore_events=dict(old.get("intraday_restore_events",{}) or {})

    # Migration from pre-V2.21 payloads.
    if not old.get("dual_snapshot_version"):
        old_tw=_split_market(old_results,"TW")
        old_us=_split_market(old_results,"US")

        # US daily data is treated as completed-session data.
        if old_us and not _split_market(official_results,"US"):
            official_results=_replace_market(official_results,"US",old_us)
            official_markets["US"]=dict(old_markets.get("US",{}),snapshot_type="official")

        if old_tw:
            tw_meta=old_markets.get("TW",{})
            tw_date=max((r.get("data_date") or "" for r in old_tw),default="")
            if _meta_is_intraday(tw_meta,old.get("generated_at")):
                intraday_results=_replace_market(intraday_results,"TW",old_tw)
                intraday_markets["TW"]=dict(tw_meta,snapshot_type="intraday")
                if not _split_market(official_results,"TW"):
                    recovered,recovered_meta=recover_previous_official_tw(tw_date)
                    if recovered:
                        official_results=_replace_market(official_results,"TW",recovered)
                        official_markets["TW"]=recovered_meta
            elif not _split_market(official_results,"TW"):
                official_results=_replace_market(official_results,"TW",old_tw)
                official_markets["TW"]=dict(tw_meta,snapshot_type="official")

    # V2.21.1 repair: if a previous V2.21 run already saved an empty official TW
    # snapshot, retry recovery on every run until it succeeds.
    if not _split_market(official_results,"TW"):
        intraday_tw=_split_market(intraday_results,"TW")
        current_tw_date=max((r.get("data_date") or "" for r in intraday_tw),default="")
        if not current_tw_date:
            old_tw=_split_market(old_results,"TW")
            current_tw_date=max((r.get("data_date") or "" for r in old_tw),default="")
        if current_tw_date:
            recovered,recovered_meta=recover_previous_official_tw(current_tw_date)
            if recovered:
                official_results=_replace_market(official_results,"TW",recovered)
                official_markets["TW"]=recovered_meta

    targets=["TW","US"] if args.market=="both" else [args.market]

    for market in targets:
        rows,scan_stats,capital_hotspots,market_quote_cache,market_restore_events=scan(market)
        nowstamp=datetime.now(TAIPEI).strftime("%Y-%m-%d %H:%M")
        if not rows:
            print(f"{market}: no new rows; preserving existing snapshots")
            continue

        current_date=max((r.get("data_date") or "" for r in rows),default="")
        if args.snapshot=="official":
            official=True
        elif args.snapshot=="intraday":
            official=False
        else:
            # Backward compatibility only. GitHub Actions V2.33 always passes an explicit mode.
            official = (market=="US") or is_tw_official_snapshot(rows)

        print(f"{market}: requested snapshot={args.snapshot} -> storing as {'official' if official else 'intraday'}")
        market_benchmark = fetch_tw_benchmarks() if market=="TW" else (fetch_us_benchmarks() if market=="US" else {})

        if official:
            # V2.39 safety guard for TW official snapshots.
            # Do not overwrite a good official snapshot when today's daily bars are not sufficiently ready.
            if market=="TW":
                today=datetime.now(TAIPEI).strftime("%Y-%m-%d")
                ready=(
                    scan_stats.get("latest_date")==today and
                    scan_stats.get("today_pct",0)>=95.0 and
                    scan_stats.get("valid_pct",0)>=85.0
                )
                print(
                    f"TW OFFICIAL GUARD: today bars={scan_stats.get('today',0)}/{scan_stats.get('valid',0)} "
                    f"({scan_stats.get('today_pct',0)}%), valid coverage={scan_stats.get('valid_pct',0)}% -> "
                    f"{'PASS' if ready else 'BLOCK'}"
                )
                if not ready:
                    print("TW official NOT overwritten: daily data completeness is below safety threshold; preserving previous official and intraday snapshots.")
                    continue
            previous=_split_market(official_results,market)
            previous_date=(official_markets.get(market) or {}).get("data_date")
            if previous:
                rows=apply_new_flags(rows,previous,previous_date)
            else:
                # First official baseline: do not create a fake batch of NEW labels.
                for r in rows:
                    r["is_new"]=False
                    r["new_reason"]=""

            official_results=_replace_market(official_results,market,rows)
            official_markets[market]={
                "data_date":current_date,
                "count":len(rows),
                "scanned_at":nowstamp,
                "snapshot_type":"official"
            }
            if market_benchmark:
                # Preserve any previously available benchmark card when a single
                # source temporarily fails during this run (e.g. TPEx).
                prev=dict(official_benchmarks.get(market,{}) or {})
                prev.update(market_benchmark)
                official_benchmarks[market]=prev
            if market=="TW" and capital_hotspots:
                official_capital_hotspots["TW"]=capital_hotspots
            if market_quote_cache:
                official_quotes[market]=market_quote_cache
            if market_restore_events:
                official_restore_events[market]=market_restore_events

            # V2.39: preserve the intraday snapshot even after an official run.
            # The two snapshots are independent; updating official must never erase intraday.
        else:
            # Intraday scan is stored separately and NEVER advances NEW baseline.
            for r in rows:
                r["is_new"]=False
                r["new_reason"]=""
            intraday_results=_replace_market(intraday_results,market,rows)
            intraday_markets[market]={
                "data_date":current_date,
                "count":len(rows),
                "scanned_at":nowstamp,
                "snapshot_type":"intraday"
            }
            if market_benchmark:
                # Preserve any previously available benchmark card when a single
                # source temporarily fails during this run (e.g. TPEx).
                prev=dict(intraday_benchmarks.get(market,{}) or {})
                prev.update(market_benchmark)
                intraday_benchmarks[market]=prev
            if market=="TW" and capital_hotspots:
                intraday_capital_hotspots["TW"]=capital_hotspots
            if market_quote_cache:
                intraday_quotes[market]=market_quote_cache
            if market_restore_events:
                intraday_restore_events[market]=market_restore_events

    # Backward-compatible "results" stays the official snapshot only.
    payload={
        "generated_at":datetime.now(TAIPEI).strftime("%Y-%m-%d %H:%M"),
        "timezone":"Asia/Taipei",
        "new_feature_version":2,
        "dual_snapshot_version":1,
        "markets":official_markets,
        "official_markets":official_markets,
        "intraday_markets":intraday_markets,
        "official_benchmarks":official_benchmarks,
        "intraday_benchmarks":intraday_benchmarks,
        "official_capital_hotspots":official_capital_hotspots,
        "intraday_capital_hotspots":intraday_capital_hotspots,
        "all_stock_quote_cache_version":1,
        "official_quotes":official_quotes,
        "intraday_quotes":intraday_quotes,
        "restore_date_engine_version":1,
        "official_restore_events":official_restore_events,
        "intraday_restore_events":intraday_restore_events,
        "results":official_results,
        "official_results":official_results,
        "intraday_results":intraday_results
    }
    OUT.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
    print(
        f"wrote {OUT}: official={len(official_results)} "
        f"intraday={len(intraday_results)}"
    )

if __name__=="__main__":
    main()
