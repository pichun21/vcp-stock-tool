#!/usr/bin/env python3
"""VCPulse Market Breadth Beta v0.2 (experimental calibration)
Read-only. Does not modify scanner.py. v0.1 stays frozen as baseline.
"""
from __future__ import annotations
import argparse,csv,json
from collections import Counter
from pathlib import Path

WEIGHTS={"breakout_impulse":.20,"postbreakout_health":.20,"setup_pressure":.15,"vcp_quality":.15,"industry_spread":.15,"risk_control":.15}
def clamp(x,lo=0,hi=100): return max(lo,min(hi,x))
def sat(x,target): return clamp(x/target*100) if target else 0

def compute(s):
 rows=[r for r in s.get('official_results',s.get('results',[])) if r.get('market')=='TW']; n=len(rows)
 t=Counter(str(r.get('type','')) for r in rows); p=Counter(str(r.get('pulse_signal','')) for r in rows)
 bo,post,near,forming=t['breakout'],t['postbreakout'],t['near'],t['forming']
 vol=sum(1 for r in rows if r.get('type')=='breakout' and '帶量' in str(r.get('state','')))
 # v0.2 removes the v0.1 all-or-nothing 100 score when every breakout happens to be volume-confirmed.
 # Absolute breadth matters: 1/1 volume breakout is not treated like 20/20.
 breakout_impulse=clamp(.70*sat(bo/n if n else 0,.08)+.30*sat(vol/n if n else 0,.05))
 holding=sum(1 for r in rows if r.get('type')=='postbreakout' and r.get('holding_pivot') is not False)
 postbreakout_health=clamp(.65*sat(post/n if n else 0,.30)+.35*((holding/post*100) if post else 0))
 setup_pressure=clamp(.70*sat(near/n if n else 0,.40)+.30*sat((near+forming)/n if n else 0,.75))
 scores=[float(r.get('score') or 0) for r in rows]; avg=sum(scores)/len(scores) if scores else 0
 hi=sum(x>=4 for x in scores)/len(scores) if scores else 0
 vcp_quality=clamp(.5*sat(avg,5)+.5*hi*100)
 inds={str(r.get('industry') or '').strip() for r in rows if str(r.get('industry') or '').strip()}
 active={str(r.get('industry') or '').strip() for r in rows if str(r.get('industry') or '').strip() and r.get('type') in {'breakout','postbreakout'}}
 # no hotspot bonus: avoids repeatedly reaching 100 merely because Top-5 hotspots exist.
 industry_spread=sat(len(active)/len(inds) if inds else 0,.45)
 extended=sum(1 for r in rows if str(r.get('pulse_signal',''))=='extended' or '過度延伸' in str(r.get('pulse_label','')))
 failed=sum(1 for r in rows if any(k in str(r.get('state','')) for k in ('失敗','跌破','失效')))
 risk=(extended+failed)/n if n else 0
 risk_control=100-sat(risk,.12)
 c=locals(); comps={k:round(c[k],1) for k in WEIGHTS}; total=round(sum(comps[k]*WEIGHTS[k] for k in WEIGHTS),1)
 regime='偏多' if total>=70 else '中性偏多' if total>=55 else '中性' if total>=45 else '中性偏空' if total>=30 else '偏空'
 b=s.get('official_benchmarks',{}).get('TW',{}).get('TWSE',{})
 return {'version':'market_breadth_v0.2','data_date':rows[0].get('data_date') if rows else None,'score':total,'regime':regime,'candidate_count':n,'breakout_count':bo,'postbreakout_count':post,'near_pivot_count':near,'forming_count':forming,'volume_breakout_count':vol,'active_industry_count':len(active),'industry_count':len(inds),'extended_count':extended,'failed_count':failed,'components':comps,'weights':WEIGHTS,'twse_close':b.get('close'),'twse_change_pct':b.get('change_pct'),'note':'Experimental calibration; not a trading signal or predictive probability.'}
def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--input',default='screening.json'); ap.add_argument('--output',default='data/market_breadth_v0_2_latest.json'); a=ap.parse_args()
 s=json.loads(Path(a.input).read_text(encoding='utf8')); r=compute(s); Path(a.output).parent.mkdir(parents=True,exist_ok=True); Path(a.output).write_text(json.dumps(r,ensure_ascii=False,indent=2),encoding='utf8'); print(json.dumps(r,ensure_ascii=False,indent=2))
if __name__=='__main__': main()
