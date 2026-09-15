#!/usr/bin/env python3
import argparse, json, math, sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
import pandas as pd
import requests
import yfinance as yf

ROOT=Path(__file__).resolve().parents[1]
MODEL=ROOT/'data'/'market_pulse_model_v0_6.json'
OUT=ROOT/'market_pulse.json'
TZ=ZoneInfo('Asia/Taipei')

def num(v):
    if v is None: return None
    s=str(v).replace(',','').replace('%','').replace('▲','').replace('▼','').strip()
    if s in ('','-','--','nan','None'): return None
    try: return float(s)
    except: return None

def pick(d,*names):
    for n in names:
        if n in d and d[n] not in (None,''): return d[n]
    return None

def fetch_tx_night(target_date):
    """Use TAIFEX official TX after-hours page and require the attributed trading date."""
    url='https://www.taifex.com.tw/cht/3/futDailyMarketExcel?marketCode=1'
    r=requests.get(url,timeout=35,headers={'User-Agent':'VCPulse-Market-Pulse/0.6.1'})
    r.raise_for_status()
    import re
    m=re.search(r'日期[：:]\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})', r.text)
    if not m: raise RuntimeError('TAIFEX 夜盤頁面找不到交易日期')
    page_date=f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    if page_date != target_date:
        raise RuntimeError(f'TAIFEX 最新歸屬日 {page_date}，尚非目標日 {target_date}')
    tables=pd.read_html(r.text)
    best=None
    for df in tables:
        if df.empty: continue
        # Flatten possible MultiIndex headers.
        if isinstance(df.columns, pd.MultiIndex):
            df.columns=[' '.join(str(x) for x in c if str(x)!='nan').strip() for c in df.columns]
        else:
            df.columns=[str(c).strip() for c in df.columns]
        cols=list(df.columns)
        month_col=next((c for c in cols if '到期' in c and ('月份' in c or '週別' in c)),None)
        pct_col=next((c for c in cols if '漲跌%' in c or c.strip()=='%'),None)
        vol_col=next((c for c in cols if '成交量' in c and '價差' not in c),None)
        contract_col=next((c for c in cols if c.strip()=='契約' or c.startswith('契約 ')),None)
        last_col=next((c for c in cols if '最後' in c and ('成交價' in c or c.strip()=='Last')),None)
        if not month_col or not pct_col or not vol_col: continue
        for _,row in df.iterrows():
            contract=str(row.get(contract_col,'TX')).strip() if contract_col else 'TX'
            month=str(row.get(month_col,'')).strip()
            if contract!='TX' or '/' in month or not month or month.lower()=='nan': continue
            pct=num(row.get(pct_col)); vol=num(row.get(vol_col)) or 0
            last=num(row.get(last_col)) if last_col else None
            if pct is None: continue
            item=(vol,pct,month,last)
            if best is None or item[0]>best[0]: best=item
    if best is None: raise RuntimeError('TAIFEX 夜盤頁面找不到 TX 單式契約資料')
    vol,pct,month,last=best
    return {'value':pct,'date':page_date,'contract':month,'last':last,'volume':vol,'source':'TAIFEX official after-hours'}

def yf_change(symbol, cutoff_date):
    """Return the last completed daily bar strictly before Taiwan target date."""
    cutoff=pd.Timestamp(cutoff_date)
    start=(cutoff-pd.Timedelta(days=14)).strftime('%Y-%m-%d')
    end=cutoff.strftime('%Y-%m-%d')  # yfinance end is exclusive
    x=yf.download(symbol,start=start,end=end,interval='1d',auto_adjust=False,progress=False,threads=False)
    if x is None or len(x)<2: raise RuntimeError(f'{symbol} 截止 {cutoff_date} 前歷史資料不足')
    close=x['Close']
    if hasattr(close,'columns'): close=close.iloc[:,0]
    close=pd.to_numeric(close,errors='coerce').dropna()
    if len(close)<2: raise RuntimeError(f'{symbol} 收盤資料不足')
    last_date=str(pd.Timestamp(close.index[-1]).date())
    if last_date >= cutoff_date: raise RuntimeError(f'{symbol} 日期鎖定失敗：{last_date} >= {cutoff_date}')
    pct=(float(close.iloc[-1])/float(close.iloc[-2])-1)*100
    return {'value':pct,'date':last_date,'close':float(close.iloc[-1]),'source':'Yahoo Finance (07:00 cutoff)'}

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--output',default=str(OUT)); args=ap.parse_args()
    model=json.loads(MODEL.read_text(encoding='utf-8'))
    errors=[]; raw={}
    now=datetime.now(TZ)
    target_date=now.date().isoformat()
    try: raw['tx_night']=fetch_tx_night(target_date)
    except Exception as e: errors.append(f'TX night: {e}')
    for key,sym in {'nasdaq':'^IXIC','sox':'^SOX','us10y':'^TNX','brent':'BZ=F','usdtwd':'TWD=X'}.items():
        try: raw[key]=yf_change(sym,target_date)
        except Exception as e: errors.append(f'{key}: {e}')
    required=['tx_night','nasdaq','sox','us10y','brent','usdtwd']
    if any(k not in raw for k in required):
        out={'version':'market-pulse-v0.6.1-beta','status':'unavailable','generated_at':now.isoformat(),'target_date':target_date,'data_cutoff':'07:00 Asia/Taipei','errors':errors,'signals':raw}
        Path(args.output).write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8'); print(json.dumps(out,ensure_ascii=False,indent=2)); return 2
    v={k:raw[k]['value'] for k in required}
    v['tx_tech_divergence']=v['tx_night']-(v['nasdaq']+v['sox'])/2
    v['oil_yield_shock']=max(v['brent'],0)*max(v['us10y'],0)
    contributions={}
    pred=model['coef']['intercept']
    for f in model['features']:
        z=(v[f]-model['mean'][f])/model['std'][f]
        c=model['coef'][f]*z; contributions[f]=c; pred+=c
    score=max(0,min(100,50+50*math.tanh(pred/(2*model['score_scale']))))
    if score<=30: state,emoji='偏空','🔴'
    elif score>=70: state,emoji='偏多','🟢'
    else: state,emoji='中性','🟡'
    primary=[v['tx_night'],v['nasdaq'],v['sox']]
    pos=sum(x>0 for x in primary); neg=sum(x<0 for x in primary)
    consistency='高' if max(pos,neg)==3 else ('中' if max(pos,neg)==2 else '低')
    labels={'tx_night':'台指夜盤','nasdaq':'Nasdaq','sox':'費半','us10y':'美債殖利率','brent':'Brent','usdtwd':'USD/TWD','tx_tech_divergence':'台股相對科技股','oil_yield_shock':'油價×殖利率風險'}
    strongest=sorted(contributions.items(),key=lambda kv:abs(kv[1]),reverse=True)[:3]
    reason='、'.join(f"{labels[k]}{'偏多' if c>0 else '偏空'}" for k,c in strongest)
    out={'version':'market-pulse-v0.6.1-beta','status':'ok','experimental':True,'generated_at':now.isoformat(),'target_date':target_date,'data_cutoff':'07:00 Asia/Taipei',
         'score':round(score,1),'state':state,'emoji':emoji,'predicted_tw_close_ret':round(pred,3),
         'consistency':consistency,'reason':reason,'signals':raw,'derived':{k:round(v[k],4) for k in ['tx_tech_divergence','oil_yield_shock']},
         'contributions':{k:round(x,4) for k,x in contributions.items()},'model_trained_through':model['trained_through'],'errors':errors}
    Path(args.output).write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8'); print(json.dumps(out,ensure_ascii=False,indent=2)); return 0
if __name__=='__main__': sys.exit(main())
