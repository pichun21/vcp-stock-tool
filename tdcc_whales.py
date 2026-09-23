#!/usr/bin/env python3
"""Build/extend weekly TDCC 400-lot+ holding history for VCPulse."""
from __future__ import annotations
import csv, io, json, re
from datetime import date
from pathlib import Path
import requests

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'tdcc_whales.json'
TDCC='https://openapi.tdcc.com.tw/v1/opendata/1-5'
TDCC_CSV='https://smart.tdcc.com.tw/opendata/getOD.ashx?id=1-5'
ARCHIVE_API='https://api.github.com/repos/wirelessr/tdcc-opendata-archive/contents/snapshots/{year}'
UA={'User-Agent':'VCPulse-TDCC/1.0'}

def parse_rows(text:str):
    text=text.lstrip('\ufeff')
    rd=csv.DictReader(io.StringIO(text))
    out=[]
    for r in rd:
        sid=str(r.get('證券代號','')).strip()
        if not re.fullmatch(r'[0-9A-Za-z]{2,10}',sid): continue
        try: level=int(str(r.get('持股分級','')).strip()); pct=float(str(r.get('占集保庫存數比例%','')).replace(',','').strip())
        except: continue
        d=str(r.get('資料日期','')).strip()
        if len(d)==8 and d.isdigit(): d=f'{d[:4]}-{d[4:6]}-{d[6:]}'
        out.append((d,sid,level,pct))
    return out

def fetch_current():
    # Official CSV is the primary source. OpenAPI remains documented as /v1/opendata/1-5.
    r=requests.get(TDCC_CSV,headers=UA,timeout=60);r.raise_for_status()
    return parse_rows(r.content.decode('utf-8-sig','replace'))

def fetch_bootstrap():
    """Bootstrap recent history from an archive of unchanged official TDCC CSV snapshots."""
    y=date.today().year
    try:
        listing=requests.get(ARCHIVE_API.format(year=y),headers=UA,timeout=30);listing.raise_for_status()
        files=[x for x in listing.json() if x.get('name','').endswith('.csv')][-10:]
        allrows=[]
        for x in files:
            rr=requests.get(x['download_url'],headers=UA,timeout=30);rr.raise_for_status();allrows.extend(parse_rows(rr.content.decode('utf-8-sig','replace')))
        return allrows
    except Exception as e:
        print('bootstrap skipped:',e);return []

def merge(rows, db):
    by={}
    for d,sid,level,pct in rows:
        if level in (12,13,14,15): by.setdefault((d,sid),0.0);by[(d,sid)]+=pct
    syms=db.setdefault('symbols',{})
    for (d,sid),pct in by.items():
        arr=syms.setdefault(sid,[]); mp={x['date']:x for x in arr};mp[d]={'date':d,'big400':round(pct,4)}
        syms[sid]=sorted(mp.values(),key=lambda x:x['date'])[-16:]

def main():
    db={'source':'TDCC 集保戶股權分散表','definition':'持股分級 12-15 合計（400,001 股以上）','symbols':{}}
    if OUT.exists():
        try: db=json.loads(OUT.read_text(encoding='utf-8'))
        except: pass
    if not db.get('symbols'): merge(fetch_bootstrap(),db)
    merge(fetch_current(),db)
    dates=[r['date'] for a in db.get('symbols',{}).values() for r in a]
    db['updated']=max(dates) if dates else None
    OUT.write_text(json.dumps(db,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    print('TDCC whale history updated:',db.get('updated'),'symbols',len(db.get('symbols',{})))
if __name__=='__main__': main()
