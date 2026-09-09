# VCPulse BUILD 2.30 US EQUITY-ONLY FILTER
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
        out.append({"symbol":str(r["stock_id"]),"name":str(r["stock_name"]),"yf":str(r["stock_id"])+suffix,"exchange":str(r["type"]).upper()})
    return out


def fetch_tw_benchmarks():
    """Fetch Taiwan benchmark snapshots.
    TWSE uses Yahoo ^TWII (already stable in this project).
    TPEx uses the official TPEx OpenAPI first, with Yahoo only as fallback.
    """
    out={}

    # ---- TWSE: Yahoo ^TWII ----
    try:
        df=yf.download("^TWII",period="10d",interval="1d",
                       auto_adjust=False,progress=False,threads=False)
        if df is not None and len(df)>=2:
            if isinstance(df.columns,pd.MultiIndex):
                close=df["Close"].iloc[:,0].dropna()
            else:
                close=df["Close"].dropna()
            last=float(close.iloc[-1]); prev=float(close.iloc[-2])
            pts=last-prev; pct=(pts/prev*100) if prev else 0.0
            d=pd.Timestamp(close.index[-1]).strftime("%Y-%m-%d")
            out["TWSE"]={
                "id":"^TWII","label":"上市｜加權指數",
                "close":round(last,2),"change_points":round(pts,2),
                "change_pct":round(pct,2),"data_time":d
            }
    except Exception as e:
        print("benchmark TWSE warning:",repr(e))

    # ---- TPEx: official OpenAPI ----
    try:
        url="https://www.tpex.org.tw/openapi/v1/tpex_index"
        r=requests.get(
            url,timeout=30,
            headers={
                "User-Agent":"Mozilla/5.0 (VCPulse; GitHub Actions)",
                "Accept":"application/json"
            }
        )
        r.raise_for_status()
        data=r.json()
        if isinstance(data,dict):
            data=data.get("data") or data.get("results") or data.get("result") or []
        if not isinstance(data,list) or len(data)<1:
            raise RuntimeError("TPEx OpenAPI returned no rows")

        def pick(row, names):
            # exact first
            for n in names:
                if n in row and row[n] not in (None,""):
                    return row[n]
            # normalized fallback
            normalized={str(k).lower().replace(" ","").replace("_",""):v for k,v in row.items()}
            for n in names:
                nk=str(n).lower().replace(" ","").replace("_","")
                if nk in normalized and normalized[nk] not in (None,""):
                    return normalized[nk]
            return None

        parsed=[]
        for row in data:
            if not isinstance(row,dict):
                continue
            ds=pick(row,["Date","date","資料日期","日期"])
            cv=pick(row,["Close","close","收市","收盤","收市指數","Index","index"])
            if cv in (None,""):
                continue
            try:
                c=float(str(cv).replace(",",""))
            except Exception:
                continue
            parsed.append((str(ds or ""),c,row))

        if not parsed:
            raise RuntimeError("TPEx OpenAPI rows had no parsable close")

        # The endpoint is historical. Prefer the last returned row; if dates are sortable,
        # sort by date text first so response order does not matter.
        parsed.sort(key=lambda x:x[0])
        ds,last,lastrow=parsed[-1]

        change_raw=pick(lastrow,["Change","change","漲跌","指數漲跌","ChangePoints"])
        pts=None
        if change_raw not in (None,""):
            try:
                pts=float(str(change_raw).replace(",","").replace("+",""))
            except Exception:
                pts=None
        if pts is None and len(parsed)>=2:
            pts=last-parsed[-2][1]
        if pts is None:
            pts=0.0

        prev=last-pts
        pct=(pts/prev*100) if prev else 0.0

        out["TPEX"]={
            "id":"tpex_index","label":"上櫃｜櫃買指數",
            "close":round(last,2),"change_points":round(pts,2),
            "change_pct":round(pct,2),"data_time":ds
        }
    except Exception as e:
        print("benchmark TPEX official warning:",repr(e))

        # Yahoo fallback, retained only as a safety net.
        for ticker in ("^TWOII","^TWO"):
            try:
                df=yf.download(ticker,period="10d",interval="1d",
                               auto_adjust=False,progress=False,threads=False)
                if df is None or len(df)<2:
                    continue
                if isinstance(df.columns,pd.MultiIndex):
                    close=df["Close"].iloc[:,0].dropna()
                else:
                    close=df["Close"].dropna()
                if len(close)<2:
                    continue
                last=float(close.iloc[-1]); prev=float(close.iloc[-2])
                pts=last-prev; pct=(pts/prev*100) if prev else 0.0
                d=pd.Timestamp(close.index[-1]).strftime("%Y-%m-%d")
                out["TPEX"]={
                    "id":ticker,"label":"上櫃｜櫃買指數",
                    "close":round(last,2),"change_points":round(pts,2),
                    "change_pct":round(pct,2),"data_time":d
                }
                break
            except Exception:
                pass

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
            tickers[s]={"symbol":s,"name":str(name or s).strip(),"yf":s,"sources":[]}
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

def download_batch(items,market):
    tickers=[x["yf"] for x in items]
    try:
        raw=yf.download(tickers=tickers,period="1y",interval="1d",group_by="ticker",auto_adjust=False,progress=False,threads=True,timeout=30)
    except Exception as e:
        print("batch download failed",e); return []
    results=[]
    for item in items:
        try:
            if len(tickers)==1: d=raw
            else:
                if item["yf"] not in raw.columns.get_level_values(0): continue
                d=raw[item["yf"]]
            if d is None or d.empty: continue
            r=analyze(d,item,market)
            if r: results.append(r)
        except Exception as e: print("analyze warning",item["symbol"],e)
    return results

def scan(market):
    universe=fetch_tw_universe() if market=="TW" else fetch_us_universe()
    print(f"{market}: universe {len(universe)}")
    batch_size=120 if market=="TW" else 120
    batches=[universe[i:i+batch_size] for i in range(0,len(universe),batch_size)]
    results=[]
    for i,b in enumerate(batches,1):
        print(f"{market}: batch {i}/{len(batches)}")
        results.extend(download_batch(b,market)); time.sleep(1)
    state_rank={"breakout":0,"postbreakout":1,"near":2,"forming":3}
    results.sort(key=lambda r:(state_rank.get(r["type"],9),-r["score"],abs(r["distance"])))
    return results[:150]

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
        rows=scan(market)
        nowstamp=datetime.now(TAIPEI).strftime("%Y-%m-%d %H:%M")
        if not rows:
            print(f"{market}: no new rows; preserving existing snapshots")
            continue

        current_date=max((r.get("data_date") or "" for r in rows),default="")
        official = (market=="US") or is_tw_official_snapshot(rows)
        market_benchmark = fetch_tw_benchmarks() if market=="TW" else (fetch_us_benchmarks() if market=="US" else {})

        if official:
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
                official_benchmarks[market]=market_benchmark

            # Once the same trading day has an official close snapshot,
            # remove the now-stale intraday copy for that market.
            intraday_results=_replace_market(intraday_results,market,[])
            intraday_markets.pop(market,None)
            intraday_benchmarks.pop(market,None)
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
                intraday_benchmarks[market]=market_benchmark

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
