/* VCPulse 主程式（原 index.html 內最大的一支內嵌腳本，原樣搬出） */
const $=id=>document.getElementById(id), API='https://api.finmindtrade.com/api/v4/data';
function pct(x){return (x>=0?'+':'')+x.toFixed(1)+'%'}
function sma(a,n){return a.map((_,i)=>i<n-1?null:a.slice(i-n+1,i+1).reduce((x,y)=>x+y,0)/n)}
/* V2.46.0 — 與 scanner.py 同一套判斷：波浪品質（只標註）＋ Squeeze 爆發（日線／週線） */
const WAVE_TIME_TOL=1.25, LAST_CONTRACTION_MAX_PCT=10, LAST_CONTRACTION_MAX_RATIO=0.70, SQZ_MIN_RUN=3, SQZ_FIRE_FRESH_DAYS=2, SQZ_FIRE_FRESH_WEEKS=1;
const SQZ_NAME={3:'strong',2:'medium',1:'weak'}, SQZ_LABEL={strong:'強力壓縮',medium:'中度壓縮',weak:'一般壓縮'};
function waveQuality(drops){
 const bars=drops.map(x=>x.l.i-x.h.i), seq=drops.map(x=>Number(x.drop));
 let timeShrinking=false,lastTight=false;
 if(drops.length>=2){
  timeShrinking=bars.slice(1).every((b,i)=>b<=bars[i]*WAVE_TIME_TOL) && bars[bars.length-1]<bars[0];
  lastTight=seq[seq.length-1]<=LAST_CONTRACTION_MAX_PCT && seq[seq.length-1]<=seq[0]*LAST_CONTRACTION_MAX_RATIO;
 }
 return {contractionBars:bars,timeShrinking,lastTight};
}
function sqzLevels(high,low,close){
 const n=close.length, out=new Array(n).fill(-1);
 let ema=close[0]; const emaArr=[ema], a=2/21;
 for(let i=1;i<n;i++){ ema=a*close[i]+(1-a)*ema; emaArr.push(ema); }
 const tr=close.map((c,i)=>i===0?Math.abs(high[i]-low[i]):Math.max(Math.abs(high[i]-low[i]),Math.abs(high[i]-close[i-1]),Math.abs(low[i]-close[i-1])));
 for(let i=0;i<n;i++){
  if(i<19) continue;                      // 20 根 BB 與 20 根 ATR 都要滿（與 pandas rolling(20) 相同）
  const w=close.slice(i-19,i+1), m=w.reduce((x,y)=>x+y,0)/20, sd=Math.sqrt(w.reduce((x,y)=>x+(y-m)**2,0)/20);
  const t=tr.slice(i-19,i+1); if(t.some(v=>!Number.isFinite(v))) continue;
  const atr=t.reduce((x,y)=>x+y,0)/20, up=m+2*sd, lo=m-2*sd;
  const inside=k=>up<emaArr[i]+atr*k && lo>emaArr[i]-atr*k;
  out[i]=inside(1.0)?3:inside(1.5)?2:inside(2.0)?1:0;
 }
 return out;
}
function sqzFire(levels,mom,maxAge,minRun=SQZ_MIN_RUN){
 const n=levels.length, out={levelNow:n?levels[n-1]:-1,runNow:0,age:null,prevLevel:0,prevBars:0,dir:null};
 if(n<2||levels[n-1]<0) return out;
 if(levels[n-1]>0){ let k=0,i=n-1; while(i>=0&&levels[i]>0){k++;i--} out.runNow=k; return out; }
 let i=n-1,k=0; while(i>=0&&levels[i]===0){k++;i--}
 if(i<0||levels[i]<=0) return out;
 const age=k-1; if(age>maxAge) return out;
 let j=i,run=0,peak=0; while(j>=0&&levels[j]>0){run++; peak=Math.max(peak,levels[j]); j--}
 if(run<minRun) return out;
 const m=Number.isFinite(mom[n-k])?mom[n-k]:0;
 out.age=age; out.prevLevel=peak; out.prevBars=run; out.dir=m>=0?'bull':'bear';
 return out;
}
function sqzMomentum(close){ return close.map((c,i)=>i<19?NaN:c-close.slice(i-19,i+1).reduce((x,y)=>x+y,0)/20); }
function isoWeekKey(dateStr){ // 週五收盤制：同一個週一～週日歸同一週
 const t=new Date(dateStr+'T00:00:00Z'); const dow=(t.getUTCDay()+6)%7; // Mon=0
 const mon=new Date(t.getTime()-dow*86400000); return mon.toISOString().slice(0,10);
}
function sqzFirePack(high,low,close,dates){
 const res={};
 const d=sqzFire(sqzLevels(high,low,close),sqzMomentum(close),5);
 res.squeeze_run_days=d.runNow; res.squeeze_fire_days=d.age;
 res.squeeze_fire=d.age!==null&&d.age<=SQZ_FIRE_FRESH_DAYS; res.squeeze_fire_dir=d.dir;
 res.squeeze_fire_prev_level=SQZ_NAME[d.prevLevel]||''; res.squeeze_fire_prev_bars=d.prevBars;
 Object.assign(res,{sqz_w_level:'',sqz_w_run:0,sqz_w_fire_weeks:null,sqz_w_fire:false,sqz_w_fire_dir:null,sqz_w_prev_level:'',sqz_w_prev_bars:0,sqz_w_partial:false});
 try{
  const keys=[],H=[],L=[],C=[];
  dates.forEach((dt,i)=>{ const k=isoWeekKey(dt); if(!keys.length||keys[keys.length-1]!==k){keys.push(k);H.push(high[i]);L.push(low[i]);C.push(close[i]);}
   else{ const j=keys.length-1; H[j]=Math.max(H[j],high[i]); L[j]=Math.min(L[j],low[i]); C[j]=close[i]; } });
  if(C.length>=30){
   const w=sqzFire(sqzLevels(H,L,C),sqzMomentum(C),3);
   res.sqz_w_level=SQZ_NAME[w.levelNow]||''; res.sqz_w_run=w.runNow; res.sqz_w_fire_weeks=w.age;
   res.sqz_w_fire=w.age!==null&&w.age<=SQZ_FIRE_FRESH_WEEKS; res.sqz_w_fire_dir=w.dir;
   res.sqz_w_prev_level=SQZ_NAME[w.prevLevel]||''; res.sqz_w_prev_bars=w.prevBars;
   const ld=new Date(dates[dates.length-1]+'T00:00:00Z'); const wd=ld.getUTCDay(); res.sqz_w_partial=(wd>=1&&wd<=4);
  }
 }catch(e){ console.warn('weekly squeeze',e); }
 return res;
}
function analyze(d){
 const close=d.map(x=>+x.close), vol=d.map(x=>+x.Trading_Volume||+x.Trading_money||0), rawVolume=d.map(x=>+x.Trading_Volume||+x.Volume||0), money=d.map(x=>+x.Trading_money||(+x.close)*(+x.Trading_Volume||+x.Volume||0)), n=close.length, ma50=sma(close,50), ma150=sma(close,150);
 let trend=ma50[n-1]&&ma150[n-1]&&close[n-1]>ma50[n-1]&&ma50[n-1]>ma150[n-1];
 // Detect local peaks/troughs, then derive recent peak-to-trough contractions.
 let piv=[]; for(let i=3;i<n-3;i++){let w=close.slice(i-3,i+4); if(close[i]===Math.max(...w))piv.push({i,t:'H',p:close[i]}); if(close[i]===Math.min(...w))piv.push({i,t:'L',p:close[i]})}
 piv=piv.filter((x,i)=>!i||x.t!==piv[i-1].t);
 let drops=[]; for(let i=0;i<piv.length-1;i++) if(piv[i].t==='H'&&piv[i+1].t==='L') drops.push({h:piv[i],l:piv[i+1],drop:(piv[i].p-piv[i+1].p)/piv[i].p*100});
 // V2.43.2 — keep browser-side single-stock contraction logic identical to scanner.py.
 // Near-100% peak-to-trough legs are broken/unusable price-series artifacts, not VCP contractions.
 drops=drops.filter(x=>Number.isFinite(Number(x.drop)) && Number(x.drop)>0 && Number(x.drop)<95).slice(-4);
 const wq=waveQuality(drops);
 let seq=drops.map(x=>x.drop), contracting=seq.length>=2&&seq.slice(1).every((x,i)=>x<seq[i]*1.12);
 let recent=close.slice(-35), pivot=Math.max(...recent.slice(0,-3)), last=close[n-1], distance=(last/pivot-1)*100;
 let v20=vol.slice(-20).reduce((a,b)=>a+b,0)/20, v60=vol.slice(-60,-20).reduce((a,b)=>a+b,0)/Math.max(1,vol.slice(-60,-20).length), dry=v20<v60*.85;
 const avgVolume20=rawVolume.slice(-20).reduce((a,b)=>a+b,0)/Math.max(1,rawVolume.slice(-20).length);
 const avgValue20=money.slice(-20).reduce((a,b)=>a+b,0)/Math.max(1,money.slice(-20).length);
 // PowerSqueeze: BB(20,2σ) vs Keltner Channel(EMA20,ATR20)
 const c20=close.slice(-20), mean20=c20.reduce((a,b)=>a+b,0)/c20.length;
 const sd20=Math.sqrt(c20.reduce((a,b)=>a+(b-mean20)**2,0)/c20.length);
 const bbU=mean20+2*sd20, bbL=mean20-2*sd20;
 let ema=close[n-20], alpha=2/21;
 for(let i=n-19;i<n;i++) ema=alpha*close[i]+(1-alpha)*ema;
 let trs=[]; for(let i=n-20;i<n;i++){
   let hi=+(d[i].max??d[i].High??d[i].high), lo=+(d[i].min??d[i].Low??d[i].low);
   trs.push(Math.max(hi-lo,Math.abs(hi-close[i-1]),Math.abs(lo-close[i-1])));
 }
 const atr=trs.reduce((a,b)=>a+b,0)/trs.length;
 const inside=m=>bbU<ema+atr*m && bbL>ema-atr*m;
 const squeezeLevel=inside(1.0)?'strong':inside(1.5)?'medium':inside(2.0)?'weak':'none';
 const squeezeState=squeezeLevel==='strong'?'🔴 強力壓縮':squeezeLevel==='medium'?'🟠 中度壓縮':squeezeLevel==='weak'?'🩷 一般壓縮':'⚪ 無壓縮';
 const prevMean=close.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
 const momNow=last-mean20, momPrev=close[n-2]-prevMean;
 const momentum=momNow>=0?(momNow>=momPrev?'↑ 多方增強':'↘ 多方減弱'):(momNow<=momPrev?'↓ 空方增強':'↗ 空方減弱');
 let breakout=last>pivot, breakoutVol=vol[n-1]>v20*1.35;
 let prev=close[n-2], todayBreakout=prev<=pivot && breakout && breakoutVol;
 let pts=0; if(trend)pts++; if(seq.length>=2)pts++; if(contracting)pts++; if(dry)pts++; if(todayBreakout||(!breakout&&distance>-8))pts++;
 let state=todayBreakout?'🟢 今日帶量突破':(!breakout&&distance>-5?'🟡 接近 Pivot':(!breakout?'⚪ VCP 成形中':'🔵 突破後觀察'));
 const hiArr=d.map(x=>+(x.max??x.High??x.high)), loArr=d.map(x=>+(x.min??x.Low??x.low));
 const sqz=sqzFirePack(hiArr,loArr,close,d.map(x=>x.date));
 return {wave:wq,sqz,lastLow:(drops.length?drops[drops.length-1].l.p:null),close,trend,seq,drops,contracting,dry,pivot,last,distance,breakout,breakoutVol,todayBreakout,pts,state,squeezeLevel,squeezeState,momentum,combo:(pts>=4&&squeezeLevel!=='none'),avgVolume20,avgValue20,vols:rawVolume,dates:d.map(x=>x.date)}
}
function draw(a){
 let c=$('chart');
 const cssW=Math.max(320,Math.round(c.getBoundingClientRect().width||720));
 if(window.__chartA!==a) window.__chartHover=null;
  window.__chartA=a; window.__chartDrawnW=cssW;
 const volAll=Array.isArray(a.vols)?a.vols:[];
  const hasVol=volAll.length===a.close.length && volAll.slice(-120).some(v=>v>0);
  const cssH=Math.round(cssW*(hasVol?0.60:0.50));
  const volH=hasVol?Math.round(cssH*0.17):0;
 const dpr=Math.min(window.devicePixelRatio||1,2.5);

 // High-DPI backing store keeps lines/text crisp on phones and Retina screens.
 c.style.width='100%';
 c.style.height='auto';
 c.width=Math.round(cssW*dpr);
 c.height=Math.round(cssH*dpr);

 let x=c.getContext('2d');
 x.setTransform(dpr,0,0,dpr,0,0);
 let W=cssW,H=cssH;
 x.clearRect(0,0,W,H);
  const isMob=cssW<=760;

 let vals=a.close.slice(-120);
 let rawMin=Math.min(...vals), rawMax=Math.max(...vals);
 let range=Math.max(rawMax-rawMin,1);
 let min=rawMin-range*.08, max=rawMax+range*.10;
 let pad={l:42,r:28,t:hasVol?(isMob?58:60):54,b:30+(hasVol?volH+10:0)};
 let X=i=>pad.l+i*(W-pad.l-pad.r)/(Math.max(vals.length-1,1));
 let Y=v=>H-pad.b-(v-min)*(H-pad.t-pad.b)/(max-min);

 // 圖例：收盤價 / MA20（月線） / Pivot（突破價）— 依文字實際寬度排版，窄螢幕自動縮小字級
  x.save();
  const legendY=20;
  const legendItems=[
    {label:'收盤價',color:'#2b2622',text:'#4a423a',w:isMob?1.7:2.2,dash:[]},
    {label:'MA20（月線）',color:'#2a97ab',text:'#1f7f90',w:isMob?1.7:2.1,dash:[]},
    {label:'Pivot（突破價）',color:'#cf9a1b',text:'#8a6209',w:isMob?1.4:1.7,dash:[6,4]}
  ];
  let lgFont=isMob?10:11;
  const lgSample=isMob?16:22, lgGap=6, lgItemGap=isMob?12:18;
  const lgMeasure=function(){
    x.font='700 '+lgFont+'px system-ui,-apple-system,sans-serif';
    return legendItems.reduce(function(sum,it){return sum+lgSample+lgGap+x.measureText(it.label).width;},0)+lgItemGap*(legendItems.length-1);
  };
  let lgTotal=lgMeasure();
  while(lgTotal>W-16 && lgFont>8){ lgFont-=0.5; lgTotal=lgMeasure(); }
  let lgX=pad.l; if(lgX+lgTotal>W-8) lgX=Math.max(8,W-8-lgTotal);
  x.textBaseline='middle'; x.textAlign='left';
  legendItems.forEach(function(it){
    x.strokeStyle=it.color; x.lineWidth=it.w; x.lineCap='round'; x.setLineDash(it.dash);
    x.beginPath(); x.moveTo(lgX,legendY); x.lineTo(lgX+lgSample,legendY); x.stroke();
    x.setLineDash([]);
    x.font='700 '+lgFont+'px system-ui,-apple-system,sans-serif';
    x.fillStyle=it.text;
    x.fillText(it.label,lgX+lgSample+lgGap,legendY);
    lgX+=lgSample+lgGap+x.measureText(it.label).width+lgItemGap;
  });
  x.restore();

  // subtle grid
 x.strokeStyle='#ece8e1';
 x.lineWidth=1;
 for(let k=0;k<5;k++){
   let y=pad.t+k*(H-pad.t-pad.b)/4;
   x.beginPath();
   x.moveTo(pad.l,y);
   x.lineTo(W-pad.r,y);
   x.stroke();
 }

 // 成交量柱（圖表下方）：淡綠＝量縮、橘＝放量上漲、深褐＝放量突破、其餘中性灰綠
  if(hasVol){
    const vs=volAll.slice(-120), off0=a.close.length-vs.length;
    const base=H-30;
    const sorted=vs.slice().sort((p,q)=>p-q), p97=sorted[Math.min(sorted.length-1,Math.floor(sorted.length*0.97))]||1;
    const vmax=Math.max(1,Math.min(Math.max(...vs),p97*1.35));
    const avg20At=function(gi){ let sum=0,cnt=0; for(let j=Math.max(0,gi-20);j<gi;j++){ sum+=volAll[j]; cnt++; } return cnt?sum/cnt:0; };
    const bw=Math.max(1.6,(W-pad.l-pad.r)/vs.length*0.62);
    x.save();
    x.strokeStyle='#e4dfd6'; x.lineWidth=1; x.beginPath(); x.moveTo(pad.l,base+.5); x.lineTo(W-pad.r,base+.5); x.stroke();
    vs.forEach(function(v,i){
      const gi=off0+i, av=avg20At(gi), up=gi>0&&a.close[gi]>=a.close[gi-1];
      const brk=gi>0&&a.close[gi]>a.pivot&&a.close[gi-1]<=a.pivot&&av>0&&v>=av*1.35;
      let col='#d5dcd8';
      if(brk) col='#c0262d'; else if(av>0&&v>=av*1.4&&up) col='#eba96a'; else if(av>0&&v>=av*1.4&&!up) col='#7f9bb3'; else if(av>0&&v<av*0.75) col='#bcd3cc';
      const h=Math.max(1,Math.min(1,v/vmax)*(volH-2));
      x.fillStyle=col; x.fillRect(X(i)-bw/2,base-h,bw,h);
      if(brk){ const tx=X(i), ty=base-h-4; x.fillStyle='#c0262d'; x.beginPath(); x.moveTo(tx,ty-6); x.lineTo(tx-4,ty); x.lineTo(tx+4,ty); x.closePath(); x.fill(); }   // 突破日加小三角，色盲也看得出來
    });
    x.font='700 '+(isMob?9:10)+'px system-ui,-apple-system,sans-serif'; x.fillStyle='#9a9285'; x.textAlign='right'; x.textBaseline='middle';
    x.fillText('量',pad.l-6,base-volH/2);
    // 圖例第二列
    const items2=[{label:'量縮',color:'#bcd3cc'},{label:'一般',color:'#d5dcd8'},{label:'放量上漲',color:'#eba96a'},{label:'放量下跌',color:'#7f9bb3'},{label:'放量突破',color:'#c0262d'}];
    x.textAlign='left'; x.textBaseline='middle';
    let fs2=isMob?10:11, gap2=isMob?9:16;
    const measure2=function(){ x.font='700 '+fs2+'px system-ui,-apple-system,sans-serif'; return items2.reduce(function(sum,it){return sum+15+x.measureText(it.label).width;},0)+gap2*(items2.length-1); };
    let tot2=measure2(); while(tot2>W-16 && fs2>8){ fs2-=0.5; tot2=measure2(); }
    let lx=Math.max(8,Math.min(pad.l,W-8-tot2));
    items2.forEach(function(it){
      x.fillStyle=it.color; x.fillRect(lx,38-5,10,10);
      x.fillStyle='#6b6258'; x.fillText(it.label,lx+15,38);
      lx+=15+x.measureText(it.label).width+gap2;
    });
    x.restore();
  }

  // 還原日標記：使用 scanner 已確認的價格尺度切換日。
 const chartDates=a.dates.slice(-120).map(v=>String(v||'').slice(0,10));
 const restoreInView=(a.restoreEvents||[]).filter(ev=>chartDates.includes(restoreEffectiveDate(ev)));
 restoreInView.forEach((ev,idx)=>{
   const rd=restoreEffectiveDate(ev), i=chartDates.indexOf(rd);
   if(i<0) return;
   const xx=X(i);
   x.save();
   x.strokeStyle='#b3a898'; x.globalAlpha=.72; x.lineWidth=1.2; x.setLineDash([4,5]);
   x.beginPath(); x.moveTo(xx,pad.t); x.lineTo(xx,H-pad.b); x.stroke();
   x.setLineDash([]); x.globalAlpha=1;
   x.font=cssW<=760?'700 9px system-ui,-apple-system,sans-serif':'700 10px system-ui,-apple-system,sans-serif';
   x.fillStyle='#8a7f70'; x.textAlign='center'; x.textBaseline='bottom';
   const md=rd.slice(5).replace('-','/');
   x.fillText(`${md} 還原`,Math.max(pad.l+28,Math.min(W-pad.r-28,xx)),H-pad.b-3-(idx%2)*12);
   x.restore();
 });

 // MA20（月線）— 使用完整歷史計算，再對齊圖中的最後 120 個交易日。
 const fullMA20=sma(a.close,20);
 const ma20=fullMA20.slice(-120);

 const drawMALine=function(withHalo){
   x.save();
   x.lineJoin='round';
   x.lineCap='round';
   x.beginPath();
   let maStarted=false;
   ma20.forEach((v,i)=>{
     if(v==null || !Number.isFinite(v)) return;
     if(!maStarted){x.moveTo(X(i),Y(v));maStarted=true;}
     else x.lineTo(X(i),Y(v));
   });
   if(maStarted){
     if(withHalo){ x.strokeStyle='rgba(255,255,255,.9)'; x.lineWidth=isMob?3.8:4.8; x.stroke(); }
     x.strokeStyle='#2a97ab'; x.lineWidth=withHalo?(isMob?1.8:2.2):(isMob?1.5:1.9); x.stroke();
   }
   x.restore();
 };
 drawMALine(true);


 // stronger main price line
 x.strokeStyle='#2b2622';
 x.lineWidth=isMob?1.7:2.2;
 x.lineJoin='round';
 x.lineCap='round';
 x.beginPath();
 vals.forEach((v,i)=>i?x.lineTo(X(i),Y(v)):x.moveTo(X(i),Y(v)));
 x.stroke();

 // Pivot line
 const py=Y(a.pivot);
 x.save();
 x.setLineDash(isMob?[6,5]:[8,6]);
 x.strokeStyle='#cf9a1b';
 x.lineWidth=isMob?1.4:1.7;
 x.beginPath();
 x.moveTo(pad.l,py);
 x.lineTo(W-pad.r,py);
 x.stroke();
 x.restore();

 // Pivot pill
 const pivotText='Pivot '+a.pivot.toFixed(2);
 x.font=isMob?'700 10.5px system-ui,-apple-system,sans-serif':'700 12px system-ui,-apple-system,sans-serif';
 const tw=x.measureText(pivotText).width;
 const pillX=pad.l+5, pillY=Math.max(pad.t+2,py-(isMob?23:27)), pillW=tw+(isMob?14:18), pillH=isMob?18:22;
 x.fillStyle='rgba(250,237,184,.97)';
 if(x.roundRect){
   x.beginPath();
   x.roundRect(pillX,pillY,pillW,pillH,10);
   x.fill();
 }else{
   x.fillRect(pillX,pillY,pillW,pillH);
 }
 x.fillStyle='#7a5a05';
 x.textBaseline='middle';
 x.fillText(pivotText,pillX+9,pillY+pillH/2);

 let offset=Math.max(0,a.close.length-120);
 const colors=['#d04a3c','#3f6fd1','#3d9a63','#8a56b5'];
 // V2.41.27：桌機維持原本質感；手機才縮細 C1~C4 視覺重量。
 const mobileChart=cssW<=760;
 const contractionGlowWidth=mobileChart?6:8;
 const contractionLineWidth=mobileChart?2.3:3;
 const contractionDotRadius=mobileChart?3.6:5;
 const contractionLabelSize=mobileChart?14:16;
 const contractionLabelOffset=mobileChart?15:18;
 const placedBadges=[];
 const badgeQueue=[];
 const segs=[];
 const hoverK=(typeof window.__chartHover==='number')?window.__chartHover:null;
 const fmtD=function(v){const m=String(v||'').match(/^\d{4}-(\d{2})-(\d{2})$/);return m?(m[1]+'/'+m[2]):String(v||'');};

 (a.drops||[]).forEach((d,k)=>{
   if(k>3)return;
   let hi=d.h.i-offset, lo=d.l.i-offset;
   if(hi<0||lo<0||hi>=vals.length||lo>=vals.length)return;

   let x1=X(hi),y1=Y(d.h.p),x2=X(lo),y2=Y(d.l.p);
   const cc=colors[k];

   const isHover=hoverK===k, isDim=hoverK!==null&&!isHover;

   // soft ribbon underlay
   x.save();
   x.strokeStyle=cc;
   x.globalAlpha=isHover?.28:(isDim?.06:.16);
   x.lineWidth=contractionGlowWidth+(isHover?4:2);
   x.lineCap='round';
   x.lineJoin='round';
   x.beginPath();
   x.moveTo(x1,y1);
   x.lineTo(x2,y2);
   x.stroke();
   x.restore();

   // center line + endpoints
   x.save();
   x.globalAlpha=isDim?.32:1;
   x.strokeStyle=cc;
   x.lineWidth=contractionLineWidth+(isHover?1.2:0);
   x.lineCap='round';
   x.beginPath();
   x.moveTo(x1,y1);
   x.lineTo(x2,y2);
   x.stroke();
   [[x1,y1],[x2,y2]].forEach(function(pt,pi){
     x.beginPath(); x.fillStyle='#fff'; x.arc(pt[0],pt[1],contractionDotRadius+2,0,Math.PI*2); x.fill();
     x.beginPath(); x.fillStyle=cc; x.arc(pt[0],pt[1],contractionDotRadius,0,Math.PI*2); x.fill();
     if(pi===0){ x.beginPath(); x.fillStyle='#fff'; x.arc(pt[0],pt[1],contractionDotRadius*.38,0,Math.PI*2); x.fill(); }
   });
   x.restore();

   // 小圓徽章位置：沿線段法線方向外推，避免壓住線與端點
   const mx=(x1+x2)/2, my=(y1+y2)/2;
   const cr=mobileChart?8:9;
   const clampY=v=>Math.max(pad.t+cr+2,Math.min(H-pad.b-cr-2,v));
   const ddx=x2-x1, ddy=y2-y1, dlen=Math.max(Math.hypot(ddx,ddy),1);
   let nx=-ddy/dlen, ny=ddx/dlen;
   if(Math.abs(nx)>=Math.abs(ny)){ if(nx*(k%2===0?1:-1)<0){nx=-nx;ny=-ny;} }
   else { if(ny*(k%2===0?-1:1)<0){nx=-nx;ny=-ny;} }
   const off=cr*(Math.abs(nx)+Math.abs(ny))+(dlen<40?12:7);
   let cy=clampY(my+ny*off);
   let cx=Math.max(pad.l+cr+2,Math.min(W-pad.r-cr-2,mx+nx*off));
   placedBadges.forEach(function(q){
     if(Math.hypot(cx-q.x,cy-q.y)<cr*2+3){ cy=clampY(q.y+(cy>=q.y?1:-1)*(cr*2+4)); }
   });
   placedBadges.push({x:cx,y:cy});
   segs.push({k:k,x1:x1,y1:y1,x2:x2,y2:y2,cx:cx,cy:cy,cr:cr});

   badgeQueue.push(function(){
     x.save();
     if(isHover){
       const dropTxt='C'+(k+1)+'  −'+Math.abs(Number(d.drop)||0).toFixed(1)+'%';
       const hiD=(a.dates&&a.dates[d.h.i])||'', loD=(a.dates&&a.dates[d.l.i])||'';
       const subTxt=(hiD&&loD)?(fmtD(hiD)+' → '+fmtD(loD)):'';
       x.font='800 13px system-ui,-apple-system,sans-serif';
       const w1=x.measureText(dropTxt).width;
       x.font='600 11px system-ui,-apple-system,sans-serif';
       const w2=subTxt?x.measureText(subTxt).width:0;
       const pw=Math.max(w1,w2)+22, ph=subTxt?40:26;
       let pcx=cx+nx*(pw/2-cr), pcy=cy+ny*(ph/2-cr);
       pcx=Math.max(pad.l+pw/2+2,Math.min(W-pad.r-pw/2-2,pcx));
       pcy=Math.max(pad.t+ph/2+2,Math.min(H-pad.b-ph/2-2,pcy));
       const px0=pcx-pw/2, py0=pcy-ph/2;
       x.shadowColor='rgba(46,42,37,.30)'; x.shadowBlur=10; x.shadowOffsetY=3;
       x.fillStyle=cc;
       x.beginPath();
       if(x.roundRect) x.roundRect(px0,py0,pw,ph,11); else x.rect(px0,py0,pw,ph);
       x.fill();
       x.shadowColor='transparent';
       x.strokeStyle='#fff'; x.lineWidth=1.8; x.stroke();
       x.fillStyle='#fff'; x.textBaseline='middle'; x.textAlign='center';
       x.font='800 13px system-ui,-apple-system,sans-serif';
       x.fillText(dropTxt,pcx,subTxt?py0+14:pcy+.5);
       if(subTxt){ x.globalAlpha=.92; x.font='600 11px system-ui,-apple-system,sans-serif'; x.fillText(subTxt,pcx,py0+29); }
     }else{
       x.globalAlpha=isDim?.45:1;
       x.shadowColor='rgba(46,42,37,.25)'; x.shadowBlur=5; x.shadowOffsetY=2;
       x.fillStyle=cc;
       x.beginPath(); x.arc(cx,cy,cr,0,Math.PI*2); x.fill();
       x.shadowColor='transparent';
       x.strokeStyle='#fff'; x.lineWidth=1.6; x.stroke();
       x.fillStyle='#fff'; x.textBaseline='middle'; x.textAlign='center';
       x.font='800 '+(mobileChart?10:11)+'px system-ui,-apple-system,sans-serif';
       x.fillText(String(k+1),cx,cy+.5);
     }
     x.restore();
   });
 });
 window.__chartSegs=segs;
 drawMALine(false);
 badgeQueue.forEach(function(f){f();});
 x.textBaseline='alphabetic';
}

function renderContractionLegend(a){
 const el=$('contractionLegend');
 if(!el) return;
 const drops=(a?.drops||[]).slice(0,4);
 if(!drops.length){el.innerHTML='';return;}
 const colors=['c1','c2','c3','c4'];
 el.innerHTML=drops.map((d,k)=>{
   const hiDate=a?.dates?.[d?.h?.i]||'';
   const loDate=a?.dates?.[d?.l?.i]||'';
   const fmt=s=>{
     const m=String(s||'').match(/^\d{4}-(\d{2})-(\d{2})$/);
     return m?`${m[1]}/${m[2]}`:String(s||'');
   };
   const dates=(hiDate&&loDate)?`${fmt(hiDate)} → ${fmt(loDate)}`:'回檔區間';
   return `<div class="contraction-item ${colors[k]}">
     <div class="contraction-head"><span class="contraction-dot"></span><span>C${k+1}</span><span>−${Math.abs(Number(d.drop)||0).toFixed(1)}%</span></div>
     <div class="contraction-date">${dates}</div>
   </div>`;
 }).join('');
}

/* ===== FinMind 請求快取層：同一檔不重複打 API，限流時改用舊快取，降低「用久了就查不到」 =====
   - 記憶體 + localStorage 快取（最多保留 24 筆，滿了先丟最舊的）
   - 同一個網址同時發出只送一次；遇到 402／429（額度用完）就冷卻 45 秒，不再連續重打
   - 價格與法人資料「不使用過期舊資料」：抓不到就如實報錯，不顯示舊數字；只有股票名稱清單（幾乎不變）可退回舊快取 */
const FM_MEM=new Map(), FM_INFLIGHT=new Map(), FM_LS='vcp_fm1:', FM_LS_MAX=24;
let FM_COOLDOWN_UNTIL=0;
function fmLsGet(key){
  try{
    const raw=localStorage.getItem(FM_LS+key); if(!raw) return null;
    const i=raw.indexOf('|'); return {t:Number(raw.slice(0,i)),j:JSON.parse(raw.slice(i+1))};
  }catch(e){ return null; }
}
function fmLsEvict(force){
  try{
    const ks=[]; for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); if(k&&k.startsWith(FM_LS)) ks.push(k); }
    let over=ks.length-FM_LS_MAX; if(force) over=Math.max(over,Math.ceil(ks.length/3)); if(over<=0) return;
    const withT=ks.map(k=>{ const raw=localStorage.getItem(k)||''; return [k,Number(raw.slice(0,raw.indexOf('|')))||0]; }).sort((a,b)=>a[1]-b[1]);
    for(let i=0;i<over&&i<withT.length;i++) localStorage.removeItem(withT[i][0]);
  }catch(e){}
}
function fmLsSet(key,ent){
  const v=ent.t+'|'+JSON.stringify(ent.j);
  try{ localStorage.setItem(FM_LS+key,v); }
  catch(e){ fmLsEvict(true); try{ localStorage.setItem(FM_LS+key,v); }catch(e2){} }
  fmLsEvict(false);
}
async function fmFetchJson(url,opt){
  const o=Object.assign({ttl:3600e3,persist:true,timeout:15000,retries:1,staleMax:0},opt||{});
  const key=String(url).replace(API,'');
  let hit=FM_MEM.get(key);
  if(!hit&&o.persist){ hit=fmLsGet(key); if(hit) FM_MEM.set(key,hit); }
  if(hit && Date.now()-hit.t<o.ttl) return hit.j;
  if(FM_INFLIGHT.has(key)) return FM_INFLIGHT.get(key);
  const run=(async()=>{
    let err=null;
    if(Date.now()<FM_COOLDOWN_UNTIL){ err=Object.assign(new Error('FinMind cooldown'),{code:'busy',detail:'冷卻中：剛被限流，約 45 秒內不再重打'}); }
    else for(let a=0;a<=o.retries;a++){
      try{
        const ctl=new AbortController(), tm=setTimeout(()=>ctl.abort(),o.timeout);
        let r; try{ r=await fetch(url,{cache:'no-store',signal:ctl.signal}); } finally{ clearTimeout(tm); }
        const j=await r.json().catch(()=>null);
        if(r.ok && j && !(j.status && Number(j.status)!==200)){
          const ent={t:Date.now(),j}; FM_MEM.set(key,ent); if(o.persist) fmLsSet(key,ent); return j;
        }
        if(r.status===402||r.status===429||(j&&(Number(j.status)===402||Number(j.status)===429))){
          FM_COOLDOWN_UNTIL=Date.now()+45000; err=Object.assign(new Error('FinMind rate limit'),{code:'busy',detail:'HTTP '+r.status}); break;
        }
        err=Object.assign(new Error('FinMind HTTP '+r.status),{code:'http',detail:'HTTP '+r.status});
      }catch(e){ err=Object.assign(new Error('FinMind network'),{code:'net',detail:(e&&e.name==='AbortError')?('逾時 '+Math.round(o.timeout/1000)+' 秒'):('連線失敗：'+((e&&e.message)||'未知'))}); }
      if(a<o.retries) await new Promise(res=>setTimeout(res,1200));
    }
    if(hit && Date.now()-hit.t<o.staleMax){ console.warn('FinMind unavailable; using stale cache',key); return hit.j; }
    throw err;
  })().finally(()=>FM_INFLIGHT.delete(key));
  FM_INFLIGHT.set(key,run); return run;
}
/* 股票清單（代號→名稱）：只存精簡版，快取 7 天；抓不到時退回任何舊資料 */
async function fmStockInfo(market){
  const dataset=market==='US'?'USStockInfo':'TaiwanStockInfo', mk='info:'+dataset;
  let hit=FM_MEM.get(mk)||fmLsGet(mk);
  if(hit && Date.now()-hit.t<7*864e5){ FM_MEM.set(mk,hit); return hit.j; }
  try{
    const j=await fmFetchJson(`${API}?dataset=${dataset}`,{persist:false,ttl:7*864e5,retries:1});
    const seen=new Set(), rows=[];
    for(const x of (Array.isArray(j?.data)?j.data:[])){
      const id=String(x?.stock_id||''); if(!id||seen.has(id)) continue; seen.add(id);
      rows.push({stock_id:id,stock_name:String(x.stock_name||id)});
    }
    if(rows.length){ const ent={t:Date.now(),j:rows}; FM_MEM.set(mk,ent); fmLsSet(mk,ent); return rows; }
  }catch(e){}
  if(hit) return hit.j;
  return [];
}

let currentMarket='TW';
async function getStockName(s,market){
 try{
  const infoRows=await fmStockInfo(market);
   if(infoRows.length){
    let row=infoRows.find(x=>String(x.stock_id).toUpperCase()===s.toUpperCase());
   if(row) return row.stock_name || row.stock_id;
  }
 }catch(e){}
 return '';
}
function normalizeData(rows,market){
 if(market==='US'){
  return rows.map(x=>({
   date:x.date,
   close:+x.Close,
   open:+x.Open,
   max:+x.High,
   min:+x.Low,
   Trading_Volume:+x.Volume
  })).filter(x=>Number.isFinite(x.close));
 }
 return rows.map(x=>({
  ...x,
  close:+x.close,
  Trading_Volume:+x.Trading_Volume
 })).filter(x=>Number.isFinite(x.close));
}


// V2.41.46 — verified official-event fallback cache.
// This is metadata, not stock-specific calculation logic. It keeps single-stock
// analysis correct even if screening.json has not finished loading yet or an old
// GitHub Pages cache is still being served. All events still use the same generic
// market-effective restore engine below.
const VERIFIED_RESTORE_EVENT_FALLBACK={
 TW:{
  '5904':[{symbol:'5904',name:'寶雅',market:'TPEX',price_effective_date:'2026-08-10',restore_date:'2026-08-10',share_ratio:10,event_type:'face_value_change',source:'TPEx official announcement'}],
  '3086':[{symbol:'3086',name:'華義',market:'TPEX',price_effective_date:'2026-04-20',restore_date:'2026-04-20',share_ratio:10,event_type:'face_value_change',source:'TPEx official announcement'}],
  '8932':[{symbol:'8932',name:'智通*',market:'TPEX',price_effective_date:'2026-03-09',restore_date:'2026-03-09',share_ratio:2,event_type:'face_value_change',source:'TPEx official announcement'}],
  '6949':[{symbol:'6949',name:'沛爾生醫-創',market:'TWSE',price_effective_date:'2026-09-07',restore_date:'2026-09-07',share_ratio:20,event_type:'face_value_change',source:'TWSE face-value-change table'}],
  '6669':[{symbol:'6669',name:'緯穎',market:'TWSE',price_effective_date:'2026-09-02',restore_date:'2026-09-02',share_ratio:2.98422578,event_type:'stock_dividend_ex_right',source:'TWSE/MOPS official ex-right event'}]
 }
};
function getRestoreEvents(market,symbol){
 const m=String(market||'TW').toUpperCase(), sym=String(symbol||'').toUpperCase();
 const pools=[
   radarRestoreEvents?.intraday?.[m]?.[sym],
   radarRestoreEvents?.official?.[m]?.[sym],
   VERIFIED_RESTORE_EVENT_FALLBACK?.[m]?.[sym]
 ];
 const merged=[];
 const seen=new Set();
 for(const arr of pools){
   if(!Array.isArray(arr)) continue;
   for(const ev of arr){
     const rd=restoreEffectiveDate(ev), sr=Number(ev?.share_ratio);
     if(!rd||!Number.isFinite(sr)||sr<=0) continue;
     const key=`${rd}|${sr.toFixed(8)}|${String(ev?.event_type||'')}`;
     if(seen.has(key)) continue;
     seen.add(key); merged.push({...ev});
   }
 }
 return merged.sort((a,b)=>restoreEffectiveDate(a).localeCompare(restoreEffectiveDate(b)));
}
function restoreEffectiveDate(ev){
 return String(ev?.price_effective_date||ev?.resume_trading_date||ev?.restore_date||'').slice(0,10);
}
function medianNums(xs){
 const a=xs.map(Number).filter(Number.isFinite).sort((x,y)=>x-y);
 if(!a.length) return NaN;
 const m=Math.floor(a.length/2);
 return a.length%2?a[m]:(a[m-1]+a[m])/2;
}
function eventMultiplierForRows(rows,ev){
 const rd=restoreEffectiveDate(ev), sr=Number(ev?.share_ratio);
 if(!rd||!Number.isFinite(sr)||sr<=0) return 1;
 const expected=1/sr;
 const usable=rows.map((r,i)=>({i,date:String(r.date||'').slice(0,10),close:Number(r.close ?? r.Close)}))
   .filter(x=>x.date&&Number.isFinite(x.close)&&x.close>0);
 const pre=usable.filter(x=>x.date<rd), post=usable.filter(x=>x.date>=rd);
 if(!pre.length||!post.length) return 1;
 const p=pre.length-1, q=0;
 const preMed=medianNums(pre.slice(Math.max(0,p-2),p+1).map(x=>x.close));
 const postMed=medianNums(post.slice(q,q+3).map(x=>x.close));
 if(!Number.isFinite(preMed)||!Number.isFinite(postMed)||preMed<=0) return 1;
 const observed=postMed/preMed;
 const rawErr=Math.abs(observed/expected-1);
 const adjustedErr=Math.abs(observed-1);
 // Each data provider is judged independently. Scanner/Yahoo may already be
 // adjusted while FinMind on the webpage may still be raw (or vice versa).
 if(rawErr<=0.30 && rawErr<adjustedErr) return expected;
 if(adjustedErr<=0.22) return 1;
 // Official events never get invented from price jumps; a mismatch is left
 // untouched rather than forcing a possibly-wrong rescale.
 return 1;
}
function applyRestoreEvents(rows,events){
 if(!Array.isArray(rows)||!rows.length||!Array.isArray(events)||!events.length) return rows;
 let out=rows.map(r=>({...r}));
 const sorted=events.slice().sort((a,b)=>restoreEffectiveDate(a).localeCompare(restoreEffectiveDate(b)));
 for(const ev of sorted){
   const rd=restoreEffectiveDate(ev), mult=eventMultiplierForRows(out,ev);
   if(!rd||!Number.isFinite(mult)||mult<=0||Math.abs(mult-1)<1e-12) continue;
   out=out.map(row=>{
     const x={...row}, date=String(x.date||'').slice(0,10);
     if(!date||date>=rd) return x;
     for(const k of ['close','open','max','min','High','Low','Open','Close'])
       if(Number.isFinite(Number(x[k]))) x[k]=Number(x[k])*mult;
     if(Number.isFinite(Number(x.Trading_Volume))) x.Trading_Volume=Number(x.Trading_Volume)/mult;
     return x;
   });
 }
 return out;
}

async function resolveTaiwanInput(raw){
 const q=raw.trim();
 if(/^\d+$/.test(q) && !/^\d{4,6}$/.test(q))
   throw new Error(`「${q}」不是有效的台股代號格式，請輸入 4 至 6 位數的股票代號，例如 2330。`);
 if(/^\d{4,6}$/.test(q)) return {symbol:q,name:''};
 try{
  const rows=(await fmStockInfo('TW')).filter(x=>x.stock_id && x.stock_name);
  let exact=rows.find(x=>String(x.stock_name).trim()===q);
  if(exact) return {symbol:String(exact.stock_id),name:String(exact.stock_name)};
  let hits=rows.filter(x=>String(x.stock_name).includes(q));
  const unique=[...new Map(hits.map(x=>[String(x.stock_id),x])).values()];
  if(unique.length===1) return {symbol:String(unique[0].stock_id),name:String(unique[0].stock_name)};
  if(unique.length>1) throw new Error(`「${q}」符合多檔股票，請輸入更完整名稱或股票代號。`);
 }catch(e){
  if(e.message && e.message.includes('符合多檔')) throw e;
 }
 throw new Error(`找不到「${q}」，請輸入台股代號或完整中文名稱，例如 2330、台積電。`);
}


function singleBenchmarkFor(row){
 if(!row) return null;
 const m=String(row.market||currentMarket||'TW').toUpperCase();
 const all=(radarBenchmarkData[radarSnapshot]||{});
 if(m==='US') return (all.US||{}).SP500||null;
 const ex=String(row.exchange||'').toUpperCase();
 const key=(ex.includes('TPEX')||ex.includes('OTC'))?'TPEX':'TWSE';
 return (all.TW||{})[key]||null;
}
function updateSingleQuickRead(radarMatch,d,a,liveQuote=null){
 const livePrice=Number(liveQuote?.price);
 const livePrev=Number(liveQuote?.prev_close);
 const liveChange=(Number.isFinite(livePrice) && Number.isFinite(livePrev) && livePrev!==0)
   ? ((livePrice/livePrev)-1)*100
   : NaN;
 const stockChange=Number.isFinite(liveChange)
   ? liveChange
   : (Number.isFinite(Number(radarMatch?.change_pct))
      ? Number(radarMatch.change_pct)
      : ((d?.length>=2 && Number(d[d.length-2]?.close)) ? ((Number(d[d.length-1].close)/Number(d[d.length-2].close)-1)*100) : NaN));
 const changeEl=$('singleChange');
 if(changeEl){
   changeEl.textContent=Number.isFinite(stockChange)?`${stockChange>0?'+':''}${stockChange.toFixed(1)}%`:'—';
   changeEl.className=Number.isFinite(stockChange)?(stockChange>0?'up':stockChange<0?'down':''):'';
 }
 const bm=singleBenchmarkFor(radarMatch || {market:currentMarket});
 const bmPct=Number(bm?.change_pct);
 $('singleMarketChange').textContent=Number.isFinite(bmPct)?`${bmPct>0?'+':''}${bmPct.toFixed(2)}%`:'—';
 $('singleMarketChange').className=Number.isFinite(bmPct)?(bmPct>0?'up':bmPct<0?'down':''):'';
 $('singleMarketName').textContent=bm?.label||'';
 const rel=(Number.isFinite(stockChange)&&Number.isFinite(bmPct))?stockChange-bmPct:NaN;
 const relEl=$('singleRelative');
 if(Number.isFinite(rel)){
   relEl.textContent=`${rel>0.05?'💪 強於大盤':rel<-0.05?'弱於大盤':'≈ 跟大盤'} ${rel>0?'+':''}${rel.toFixed(2)}%`;
   relEl.className=rel>0.05?'single-relative-strong':rel<-0.05?'single-relative-weak':'';
 }else{
   relEl.textContent='—'; relEl.className='';
 }
 const chips=[];
 if(radarMatch?.pulse_signal==='hot') chips.push('🔥 高關注');
 else if(radarMatch?.pulse_signal==='watch') chips.push('👀 觀察');
 else if(radarMatch?.pulse_signal==='wait') chips.push('⏳ 等待');
 $('singleSignals').innerHTML=chips.map(x=>`<span class="single-signal-chip">${escHtml(x)}</span>`).join('');
 updateSingleSqz(a,radarMatch);
 updateSingleLiquidity(radarMatch,a);
}
/* 風險參考：最近收縮低點 / Pivot 下 7～8%（僅供參考，不是建議、不計入 VCP 星數） */
function updateSingleRisk(pivot,last,low){
 const box=$('singleRisk'); if(!box) return;
 const P=Number(pivot), L=Number(last), W=Number(low);
 if(!(P>0)||!(L>0)){ box.hidden=true; box.innerHTML=''; return; }
 const dist=v=>{const x=(v/L-1)*100; return `${x>0?'+':''}${x.toFixed(1)}%`;};
 const rows=[];
 if(W>0){
   const broke=L<=W;
   rows.push(`<div class="sqz-row${broke?' is-bear':''}"><span class="sqz-k">最近收縮低點</span><span class="sqz-v">${W.toFixed(2)}<small>　距現價 ${dist(W)}${broke?'　已跌破':''}</small></span></div>`);
 }
 const a8=P*0.92, a7=P*0.93, broke2=L<=a7;
 rows.push(`<div class="sqz-row${broke2?' is-bear':''}"><span class="sqz-k">Pivot 下 7～8%</span><span class="sqz-v">${a8.toFixed(2)}～${a7.toFixed(2)}<small>　距現價 ${dist(a8)}～${dist(a7)}${broke2?'　已跌破':''}</small></span></div>`);
 box.innerHTML=`<div class="sqz-card-title">風險參考<em>僅供參考，非買賣建議，不計入 VCP 星數</em></div>`+rows.join('')+
  `<div class="risk-foot">收縮低點以收盤價計算。停損離進場價越遠，同樣部位的單筆虧損越大；實際停損請依自己的資金規劃。</div>`;
 box.hidden=false;
}
/* PowerSqueeze 整併卡：日線狀態／週線狀態／動能，放在同一處 */
function updateSingleSqz(a,rm){
 const box=$('singleSqz'); if(!box) return;
 const sp=effectiveSqz(a,rm)||{};
 let d, dCls='', w, wCls='';
 if(sp.squeeze_fire){ d=sqzDailyText(sp); dCls=sp.squeeze_fire_dir==='bear'?' is-bear':' is-fire'; }
 else{
   const run=Number(sp.squeeze_run_days)>0?`，已連續 ${Number(sp.squeeze_run_days)} 日`:'';
   d=a?.squeezeState?`${a.squeezeState}${a.squeezeState.includes('無壓縮')?'':run}`:'—';
 }
 if(sp.sqz_w_fire){ w=sqzWeeklyText(sp); wCls=sp.sqz_w_fire_dir==='bear'?' is-bear':' is-fire'; }
 else if(sp.sqz_w_level){ w=`${SQZ_LABEL[sp.sqz_w_level]||'壓縮'}，已 ${Number(sp.sqz_w_run)||0} 週`; }
 else{ w='無壓縮'; }
 const m=a?.momentum||'—';
 box.innerHTML=`<div class="sqz-card-title">PowerSqueeze<em>不計入 VCP 星數</em></div>`+
  `<div class="sqz-row${dCls}"><span class="sqz-k">日線</span><span class="sqz-v">${escHtml(d)}</span></div>`+
  `<div class="sqz-row${wCls}"><span class="sqz-k">週線</span><span class="sqz-v">${escHtml(w)}</span></div>`+
  `<div class="sqz-row"><span class="sqz-k">動能</span><span class="sqz-v">${escHtml(m)}</span></div>`;
 box.hidden=false;
}
function resetSingleQuickRead(){
 ['singleChange','singleMarketChange','singleRelative'].forEach(id=>{const el=$(id);if(el){el.textContent='—';el.className='';}});
 if($('singleMarketName')) $('singleMarketName').textContent='';
 if($('singleSignals')) $('singleSignals').innerHTML='';
 if($('singleSqz')){$('singleSqz').hidden=true;$('singleSqz').innerHTML='';}
 if($('singleRisk')){$('singleRisk').hidden=true;$('singleRisk').innerHTML='';}
 if($('singleLiquidity')){$('singleLiquidity').hidden=true;$('singleLiquidity').innerHTML='';}
}


function getScannerCachedQuote(market,symbol){
 const m=String(market||'').toUpperCase();
 const s=String(symbol||'').toUpperCase();

 // Single-stock lookup always wants the freshest available snapshot:
 // intraday first, official second.
 const choices=[
   {kind:'intraday',map:radarAllQuotes?.intraday?.[m],meta:radarSnapshotMeta?.intraday?.[m]},
   {kind:'official',map:radarAllQuotes?.official?.[m],meta:radarSnapshotMeta?.official?.[m]}
 ];
 for(const x of choices){
   const q=x.map?.[s];
   const price=Number(q?.price), prev=Number(q?.prev_close);
   if(Number.isFinite(price) && price>0 && Number.isFinite(prev) && prev>0){
     const scanned=String(x.meta?.scanned_at||'');
     const quote_time=(scanned.match(/\s(\d{1,2}:\d{2})$/)||[])[1]||'';
     return {
       price,
       prev_close:prev,
       data_date:String(q?.data_date||x.meta?.data_date||''),
       quote_time,
       source:x.kind==='intraday'?'VCPulse 盤中快取':'VCPulse 收盤快取'
     };
   }
 }
 return null;
}

async function getSingleLatestQuote(market,symbol){
 const m=String(market||'').toUpperCase();
 const sym=String(symbol||'').toUpperCase();

 async function fetchJson(url,timeout=5500){
   const ctl=new AbortController();
   const timer=setTimeout(()=>ctl.abort(),timeout);
   try{
     const r=await fetch(url,{cache:'no-store',signal:ctl.signal});
     if(!r.ok) return null;
     return await r.json().catch(()=>null);
   }catch(e){
     return null;
   }finally{
     clearTimeout(timer);
   }
 }

 // V2.41.15：台股單股查詢先抓交易所盤中行情。
 // 同時嘗試上市/上櫃代碼，找到有即時成交價的那一筆。
 if(m==='TW'){
   try{
     const exch=`tse_${encodeURIComponent(sym)}.tw|otc_${encodeURIComponent(sym)}.tw`;
     const misUrl=`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exch}&json=1&delay=0&_=${Date.now()}`;
     const j=await fetchJson(misUrl,5000);
     const arr=Array.isArray(j?.msgArray)?j.msgArray:[];
     const row=arr.find(x=>{
       const z=Number(x?.z);
       const y=Number(x?.y);
       return Number.isFinite(z) && z>0 && Number.isFinite(y) && y>0;
     });
     if(row){
       const price=Number(row.z);
       const prev=Number(row.y);
       const rawDate=String(row.d||'');
       const data_date=/^\d{8}$/.test(rawDate)
         ? `${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}`
         : '';
       let quote_time=String(row.t||'').replace(/\.000$/,'');
       if(!quote_time && row.tlong){
         const dt=new Date(Number(row.tlong));
         if(!Number.isNaN(dt.getTime())){
           quote_time=dt.toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false});
         }
       }
       return {price,prev_close:prev,data_date,quote_time,source:'TWSE MIS'};
     }
   }catch(e){
     console.warn('TWSE MIS latest quote unavailable',e);
   }

   // 第二層：Yahoo 1m chart。上櫃先嘗試 .TWO，再嘗試 .TW。
   const yahooSymbols=[`${sym}.TW`,`${sym}.TWO`];
   for(const ys of yahooSymbols){
     try{
       const yurl=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ys)}?interval=1m&range=1d&includePrePost=false&_=${Date.now()}`;
       const yj=await fetchJson(yurl,5000);
       const result=yj?.chart?.result?.[0];
       const meta=result?.meta||{};
       const price=Number(meta.regularMarketPrice);
       const prev=Number(meta.chartPreviousClose ?? meta.previousClose);
       if(Number.isFinite(price) && price>0 && Number.isFinite(prev) && prev>0){
         const ts=Number(meta.regularMarketTime);
         const dt=Number.isFinite(ts)?new Date(ts*1000):null;
         const data_date=dt&&!Number.isNaN(dt.getTime())
           ? `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`
           : '';
         const quote_time=dt&&!Number.isNaN(dt.getTime())
           ? dt.toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false})
           : '';
         return {price,prev_close:prev,data_date,quote_time,source:'Yahoo'};
       }
     }catch(e){
       console.warn('Yahoo latest quote unavailable',ys,e);
     }
   }
 }

 // 瀏覽器直連交易所/Yahoo 若被 CORS 或裝置網路擋住，
 // 先讀每 5 分鐘更新的輕量台股行情快取。它只提供價格欄位，
 // 不會覆蓋 VCP 結構。
 if(m==='TW'){
   const liveCache=serverLiveQuoteFor(m,sym);
   if(liveCache) return {...liveCache,source:'VCPulse 5 分鐘行情快取'};
 }

 // 再退回 GitHub Actions 完整掃描時留下的「全市場盤中快取」。
 // 這包含所有可下載股票，不只每日雷達候選股。
 const scannerQuote=getScannerCachedQuote(m,sym);
 if(scannerQuote) return scannerQuote;

 // 最後才退回 FinMind 日資料備援。
 try{
   const dataset=m==='US'?'USStockPrice':'TaiwanStockPrice';
   const end=new Date(), start=new Date(); start.setDate(end.getDate()-12);
   const f=d=>d.toISOString().slice(0,10);
   const u=`${API}?dataset=${dataset}&data_id=${encodeURIComponent(sym)}&start_date=${f(start)}&end_date=${f(end)}`;
   const j=await fmFetchJson(u,{ttl:120000,persist:false,retries:0,timeout:7000}).catch(()=>null);
    if(!j || !Array.isArray(j.data) || !j.data.length) return null;
   const rows=normalizeData(j.data,m);
   if(!rows.length) return null;
   const last=rows[rows.length-1], prev=rows.length>1?rows[rows.length-2]:null;
   const price=Number(last.close);
   if(!Number.isFinite(price)) return null;
   return {
     price,
     prev_close:prev?Number(prev.close):NaN,
     data_date:last.date||'',
     quote_time:'',
     source:'FinMind daily'
   };
 }catch(e){
   console.warn('Latest quote fetch failed; fallback to daily history',e);
   return null;
 }
}

function findLatestRadarMatch(market,symbol){
 const m=String(market).toUpperCase(), sym=String(symbol).toUpperCase();
 const intraday=(typeof radarSnapshotData!=='undefined' ? radarSnapshotData.intraday : [])||[];
 const official=(typeof radarSnapshotData!=='undefined' ? radarSnapshotData.official : [])||[];
 const live=intraday.find(x=>String(x.market||'').toUpperCase()===m && String(x.symbol||'').toUpperCase()===sym) || null;
 const base=official.find(x=>String(x.market||'').toUpperCase()===m && String(x.symbol||'').toUpperCase()===sym) || null;
 // V2.43.2 — intraday rows intentionally carry lighter fields. Enrich them with
 // official structural VCP fields so live price/status never replaces the scanner's
 // score components or contractions with a second browser-side calculation.
 if(live && base) return {...base,...live,
   score_components:live.score_components||base.score_components,
   contractions:Array.isArray(live.contractions)?live.contractions:base.contractions
 };
 return live || base || null;
}


function findAnyRadarMatch(market,symbol){
  const m=String(market||'').toUpperCase();
  const sym=String(symbol||'').toUpperCase();
  const pools=[
    ...(radarSnapshotData?.intraday||[]),
    ...(radarSnapshotData?.official||[])
  ];
  return pools.find(x=>
    String(x.market||'').toUpperCase()===m &&
    String(x.symbol||'').toUpperCase()===sym
  ) || null;
}

function drawRadarFallbackMessage(){
  const c=$('chart');
  if(!c) return;
  const ctx=c.getContext('2d');
  ctx.clearRect(0,0,c.width,c.height);
  ctx.save();
  ctx.textAlign='center';
  ctx.fillStyle='#8a8379';
  ctx.font='600 16px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  ctx.fillText('此裝置目前無法取得完整歷史日線圖',c.width/2,c.height/2-10);
  ctx.font='13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  ctx.fillText('已改用 VCPulse 每日雷達的預先計算結果',c.width/2,c.height/2+18);
  ctx.restore();
}

function renderSingleFromRadarFallback(symbol,row){
 const legend=$('contractionLegend'); if(legend) legend.innerHTML='';
  if(!row) return false;

  const pts=Number(row.score);
  const pivot=Number(row.pivot);
  const distance=Number(row.distance);
  const change=Number(row.change_pct);
  const name=row.name || '';
  const date=row.data_date || '';

  $('err').style.display='none';
  $('title').textContent=name ? `${name}（${symbol}）` : `${symbol} · ${currentMarket==='US'?'美股':'台股'}`;
  currentSingleFavoriteData={...row,market:String(currentMarket).toUpperCase(),symbol:String(symbol).toUpperCase(),name:name||symbol,_favorite_only:false};
  if(getFavorites().has(favoriteKey(currentMarket,symbol))) rememberFavoriteMeta(currentSingleFavoriteData);
  renderSingleFavorite(currentMarket,symbol);
  $('period').textContent=`${date || '最近一次雷達資料'}　·　已使用每日雷達備援`;
  $('state').textContent=stageLabel(row);

  if($('singleLiveNote')){
    $('singleLiveNote').hidden=false;
    $('singleLiveNote').textContent='🟡 此裝置目前無法直連歷史資料來源，已改用 VCPulse 雷達快取結果';
  }

  $('score').textContent=Number.isFinite(pts)?`${pts}/5`:'—';
  if($('scoreContext')){$('scoreContext').hidden=true;$('scoreContext').textContent='';}
  $('stars').textContent=Number.isFinite(pts)?'★'.repeat(Math.max(0,Math.min(5,pts)))+'☆'.repeat(Math.max(0,5-Math.min(5,pts))):'☆☆☆☆☆';
  if($('singleStructureQuality')) $('singleStructureQuality').hidden=!row.structure_quality_good;
  $('pivot').textContent=Number.isFinite(pivot)?pivot.toFixed(2):'—';
  $('dist').textContent=Number.isFinite(distance)?pct(distance):'—';
  $('contracts').textContent=row.contracts || '—';
  $('volume').textContent=row.volume_dry?'量縮 ✓':'未明顯量縮';

  // Do not fabricate individual checklist results when the full historical series
  // is unavailable on this device.
  $('checks').innerHTML='<div class="check"><span>完整歷史條件明細</span><b style="color:#9a6a1c">使用雷達快取</b></div>';

  const summaryBits=[];
  if(row.pulse_label) summaryBits.push(row.pulse_label);
  if(row.squeeze_state) summaryBits.push(row.squeeze_state);
  if(row.momentum) summaryBits.push(row.momentum);
  $('summary').textContent=(summaryBits.length?summaryBits.join('｜')+'。':'')+
    '本次使用每日雷達已預先計算的結果；完整 K 線圖需待此裝置可連線歷史資料來源時顯示。';

  // Quick read: reuse scanner values and current benchmark snapshot.
  if($('singleChange')){
    $('singleChange').textContent=Number.isFinite(change)?pct(change):'—';
    $('singleChange').className=Number.isFinite(change)?(change>0?'up':change<0?'down':''):'';
  }
  const bm=singleBenchmarkFor(row);
  const bmp=Number(bm?.change_pct);
  if($('singleMarketChange')){
    $('singleMarketChange').textContent=Number.isFinite(bmp)?pct(bmp):'—';
    $('singleMarketChange').className=Number.isFinite(bmp)?(bmp>0?'up':bmp<0?'down':''):'';
  }
  if($('singleMarketName')) $('singleMarketName').textContent=bm?.label||'';
  if($('singleRelative')){
    const rel=(Number.isFinite(change)&&Number.isFinite(bmp))?change-bmp:NaN;
    $('singleRelative').textContent=Number.isFinite(rel)?`${rel>=0?'強於':'弱於'}大盤 ${pct(Math.abs(rel))}`:'—';
    $('singleRelative').className=Number.isFinite(rel)?(rel>=0?'single-relative-strong':'single-relative-weak'):'';
  }

  if($('singleSignals')){
    const chips=[];
    if(row.pulse_label) chips.push(row.pulse_label);
    $('singleSignals').innerHTML=chips.map(x=>`<span class="single-signal-chip">${escHtml(x)}</span>`).join('');
  }
  updateSingleSqz({squeezeState:squeezeLabel(row),momentum:momentumLabel(row)},row);
  updateSingleRisk(row.pivot,row.last,null);
  updateSingleLiquidity(row,null);

  drawRadarFallbackMessage();
  renderNewsImpact(currentMarket,symbol);
  return true;
}

function rocDateToIso(v){
 const s=String(v||'').trim();
 const m=s.match(/^(\d{2,3})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
 if(!m) return s;
 return `${Number(m[1])+1911}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
}
function twseNum(v){
 const n=Number(String(v??'').replace(/,/g,'').replace(/--/g,'').trim());
 return Number.isFinite(n)?n:NaN;
}
async function fetchTwseOfficialHistory(symbol,months=14){
 const now=new Date();
 const jobs=[];
 for(let i=0;i<months;i++){
   const d=new Date(now.getFullYear(),now.getMonth()-i,1);
   const date=`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}01`;
   const url=`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${date}&stockNo=${encodeURIComponent(symbol)}&_=${Date.now()+i}`;
   jobs.push(fetch(url,{cache:'no-store'}).then(async r=>{
     if(!r.ok) return [];
     const j=await r.json().catch(()=>null);
     if(!j || !Array.isArray(j.data)) return [];
     return j.data.map(x=>({
       date:rocDateToIso(x?.[0]),
       Trading_Volume:twseNum(x?.[1]),
       Trading_money:twseNum(x?.[2]),
       open:twseNum(x?.[3]),
       max:twseNum(x?.[4]),
       min:twseNum(x?.[5]),
       close:twseNum(x?.[6])
     })).filter(x=>x.date && Number.isFinite(x.close));
   }).catch(()=>[]));
 }
 const chunks=await Promise.all(jobs);
 const map=new Map();
 chunks.flat().forEach(x=>map.set(x.date,x));
 return [...map.values()].sort((a,b)=>a.date.localeCompare(b.date));
}


let newsImpactCache=null;
let newsImpactPromise=null;

function newsImpactSafeUrl(v){
  try{
    const u=new URL(String(v||''),location.href);
    return /^https?:$/.test(u.protocol)?u.href:'';
  }catch(e){ return ''; }
}
function newsImpactDate(v){
  const s=String(v||'');
  const m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m?`${Number(m[2])}/${Number(m[3])}`:'';
}
async function getNewsImpactData(){
  if(newsImpactCache) return newsImpactCache;
  if(newsImpactPromise) return newsImpactPromise;
  newsImpactPromise=fetch(`data/news_impact.json?t=${Date.now()}`,{cache:'no-store'})
    .then(r=>{if(!r.ok) throw new Error('News Impact 尚未建立');return r.json();})
    .then(x=>(newsImpactCache=x))
    .catch(e=>({status:'error',error:String(e?.message||e),stocks:{}}))
    .finally(()=>{newsImpactPromise=null;});
  return newsImpactPromise;
}
function currentNewsVcpRelation(market,symbol,fallback=''){
  const row=currentSingleFavoriteData;
  const same=row && String(row.market||'').toUpperCase()===String(market||'').toUpperCase()
    && String(row.symbol||'').toUpperCase()===String(symbol||'').toUpperCase();
  if(!same) return fallback||'';
  const bits=[];
  // News Impact must not keep its own stale VCP judgement. Reuse the exact
  // single-stock analysis currently shown above whenever that analysis exists.
  if(row.structure_quality_good===true) bits.push('💎 結構品質佳');
  const score=Number(row.score);
  if(Number.isFinite(score)) bits.push(`VCP ${score}/5`);
  if(row.volume_dry===true) bits.push('量縮');
  return bits.length?bits.join('；'):(fallback||'');
}

function resetNewsImpact(message='輸入台股代號後，查看近期重要新聞與目前價格反應。'){
  const box=document.getElementById('newsImpactContent');
  const meta=document.getElementById('newsImpactMeta');
  if(box) box.innerHTML=`<div class="news-impact-empty">${escHtml(message)}</div>`;
  if(meta) meta.textContent='V1 先支援台股｜整理事件、可能影響與價格反應';
}
async function renderNewsImpact(market,symbol){
  const box=document.getElementById('newsImpactContent');
  const meta=document.getElementById('newsImpactMeta');
  if(!box) return;
  const radarRow=typeof findAnyRadarMatch==='function'?findAnyRadarMatch(market,symbol):null;
  const stockLabel=radarRow?.name?`${radarRow.name}（${symbol}）`:`${symbol}`;
  if(String(market||'').toUpperCase()!=='TW'){
    resetNewsImpact('News Impact V1 目前先支援台股；美股版之後再獨立加入。');
    return;
  }
  const sym=String(symbol||'').toUpperCase();
  box.innerHTML='<div class="news-impact-empty">正在讀取近期新聞…</div>';
  const data=await getNewsImpactData();
  const stock=data?.stocks?.[sym];
  if(meta){
    const t=String(data?.generated_at||'').replace('T',' ').slice(0,16);
    meta.textContent=t?`台股｜資料更新 ${t}`:'台股｜等待首次新聞資料更新';
  }
  if(!stock){
    box.innerHTML=`<div class="news-impact-empty">目前尚未納入「${escHtml(stockLabel)}」的本次 News Impact 更新；下一次完整更新後會再嘗試整理。</div>`;
    return;
  }
  const items=Array.isArray(stock.items)?stock.items.slice(0,3):[];
  if(!items.length){
    box.innerHTML=`<div class="news-impact-empty">近期未發現「${escHtml(stockLabel)}」需要特別整理的重要公開消息。可搭配 VCP 結構、成交量與價格反應持續觀察。</div>`;
    return;
  }
  box.innerHTML=items.map((n,i)=>{
    const url=newsImpactSafeUrl(n.url);
    const src=[n.source,newsImpactDate(n.published_at)].filter(Boolean).join(' · ');
    return `<details class="news-impact-item" ${i===0?'open':''}>
      <summary>
        <div class="news-impact-summary-top">
          <span class="news-impact-event">${escHtml(n.event||'公司／產業動態')}</span>
          <span class="news-impact-horizon">${escHtml(n.horizon||'')}</span>
        </div>
        <div class="news-impact-news-title">${escHtml(n.title||'')}</div>
        <div class="news-impact-source">${escHtml(src)}</div>
      </summary>
      <div class="news-impact-detail">
        <div class="news-impact-row"><b>為什麼重要：</b>${escHtml(n.why||'')}</div>
        ${n.possible_impact?`<div class="news-impact-row"><b>可能影響：</b>${escHtml(n.possible_impact)}</div>`:''}
        <div class="news-impact-row"><b>市場目前反應：</b>${escHtml(n.market_reaction||'')}</div>
        <div class="news-impact-row"><b>與 VCP 的關係：</b>${escHtml(currentNewsVcpRelation(market,sym,n.vcp_relation||''))}</div>
        ${url?`<a class="news-impact-link" href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">查看原始新聞 ↗</a>`:''}
      </div>
    </details>`;
  }).join('');
}

let __loadN=0;
function __loadCard(){ const t=document.getElementById('title'); return t?t.closest('.card'):null; }
function __loadStart(){
 __loadN++;
 const card=__loadCard(); if(card) card.classList.add('is-loading');
 const note=document.getElementById('vcpLoadingNote'), txt=document.getElementById('vcpLoadingText');
 if(note){
  const sym=String((document.getElementById('symbol')||{}).value||'').trim();
  if(txt) txt.textContent=sym?('正在分析 '+sym+'，請稍候…'):'分析中，請稍候…';
  note.hidden=false;
 }
}
function __loadEnd(){
 __loadN=Math.max(0,__loadN-1);
 if(__loadN>0) return;
 const card=__loadCard(); if(card) card.classList.remove('is-loading');
 const note=document.getElementById('vcpLoadingNote'); if(note) note.hidden=true;
}
async function run(){
 __loadStart();
 try{ return await __runInner(); }
 finally{ __loadEnd(); }
}
async function __runInner(){
 let raw=$('symbol').value.trim(), s=raw.toUpperCase(), resolvedName='';
 $('go').disabled=true;$('go').textContent='分析中…';$('err').style.display='none';
 try{
  resetAuxMarketAndForeign();
  if(currentMarket==='TW'){
   const resolved=await resolveTaiwanInput(raw);
   s=resolved.symbol; resolvedName=resolved.name||'';
  }else if(!/^[A-Z][A-Z0-9.\-^]{0,9}$/.test(s)){
   throw new Error('請輸入美股代號，例如 NVDA、TSLA、AAPL。');
  }
  renderNewsImpact(currentMarket,s);
 let end=new Date(), start=new Date();start.setDate(end.getDate()-420);let f=d=>d.toISOString().slice(0,10);
  let dataset=currentMarket==='US'?'USStockPrice':'TaiwanStockPrice';
  let u=`${API}?dataset=${dataset}&data_id=${encodeURIComponent(s)}&start_date=${f(start)}&end_date=${f(end)}`;
  let d=[], finmindIssue=null, finmindDetail='';   // finmindIssue：'busy'（額度用完／冷卻）、'net'／'http'（連線問題）、null
   try{
     const j=await fmFetchJson(u,{ttl:10*60e3});
     if(Array.isArray(j?.data) && j.data.length>=160) d=normalizeData(j.data,currentMarket);
   }catch(e){
     finmindIssue=e?.code||'net'; finmindDetail=e?.detail||''; console.warn('FinMind history unavailable',e);
   }
  // Desktop Chrome can block browser-to-Yahoo requests by CORS. For TW-listed
  // stocks, use TWSE's official monthly STOCK_DAY endpoint as a browser-safe fallback.
  if(d.length<160 && currentMarket==='TW'){
    const officialRows=await fetchTwseOfficialHistory(s,14);
    if(officialRows.length>=160){
      d=officialRows;
      console.info('Using TWSE official history fallback',s,d.length);
    }
  }
  if(d.length<160) throw Object.assign(new Error(finmindIssue?'__TRANSIENT__':'歷史資料不足'),{kind:finmindIssue,detail:finmindDetail});
  const restoreEvents=getRestoreEvents(currentMarket,s);
  if(restoreEvents.length) d=applyRestoreEvents(d,restoreEvents);
  const radarMatch=findLatestRadarMatch(currentMarket,s);
  // Keep the company name identical to Daily Radar whenever the symbol exists there.
  // Yahoo/FinMind metadata can add legal suffixes such as "Common Stock", while
  // the scanner stores the cleaned display name used throughout VCPulse.
  let a=analyze(d),stockName=resolvedName || String(radarMatch?.name||'').trim() || await getStockName(s,currentMarket);
  a.restoreEvents=restoreEvents;
  const restoreNote=$('singleRestoreNote');
  if(restoreNote){
    if(restoreEvents.length){
      const latest=restoreEvents[restoreEvents.length-1];
      const sr=Number(latest.share_ratio);
      let ratioText='';
      if(Number.isFinite(sr) && sr>0){
        ratioText = sr>=1
          ? `1:${Number(sr.toFixed(4)).toString()}`
          : `${Number((1/sr).toFixed(4)).toString()}:1`;
      }
      restoreNote.hidden=false;
      const rd=restoreEffectiveDate(latest);
      restoreNote.textContent=`🔄 還原日 ${rd}${ratioText?`｜股數比例 ${ratioText}`:''}｜依官方市場生效日，拆股／除權前歷史價格已統一為事件後價格尺度`;
    }else{
      restoreNote.hidden=true;
      restoreNote.textContent='';
    }
  }

  // If this stock exists in today's radar, use the SAME scanner result for the
  // headline VCP metrics. This keeps single-stock analysis and Daily Radar consistent.
  let liveQuote=null;
  try{
    liveQuote=await getSingleLatestQuote(currentMarket,s);
  }catch(e){
    console.warn('V2.36.2 live quote unavailable; continue with historical analysis',e);
    liveQuote=null;
  }
  if(radarMatch){
    if(Number.isFinite(Number(radarMatch.score))) a.pts=Number(radarMatch.score);
    if(Number.isFinite(Number(radarMatch.pivot))) a.pivot=Number(radarMatch.pivot);
    if(Number.isFinite(Number(radarMatch.distance))) a.distance=Number(radarMatch.distance);
    if(Array.isArray(radarMatch.contractions)) a.seq=radarMatch.contractions.map(Number).filter(Number.isFinite);
    if(typeof radarMatch.volume_dry==='boolean') a.dry=radarMatch.volume_dry;
    a.state=stageLabel(radarMatch);
    a.squeezeLevel=radarMatch.squeeze_level || a.squeezeLevel;
    a.squeezeState=squeezeLabel(radarMatch);
    a.momentum=momentumLabel(radarMatch);
    a.todayBreakout=radarMatch.type==='breakout';
    a.breakout=['breakout','postbreakout'].includes(radarMatch.type);
    a.combo=!!radarMatch.combo;
  }

  // V2.35: 單股搜尋不再只停留在昨日收盤。
  // VCP 結構仍以日線為主；最新可取得價格用來更新今日漲跌、距 Pivot 與盤中位置。
  if(liveQuote && Number.isFinite(Number(liveQuote.price))){
    const lp=Number(liveQuote.price), pc=Number(liveQuote.prev_close);
    a.last=lp;
    if(Number.isFinite(Number(a.pivot)) && Number(a.pivot)!==0){
      a.distance=(lp/Number(a.pivot)-1)*100;
      const above=lp>Number(a.pivot);
      if(above && !a.todayBreakout) a.state='🟡 盤中站上 Pivot';
      else if(!above && a.distance>-5) a.state='🟡 接近 Pivot';
    }
    // Make quick-read "今日漲跌" use latest quote.
    if(d.length){
      const lastDate=String(d[d.length-1]?.date||'');
      if(liveQuote.data_date && lastDate===String(liveQuote.data_date)){
        d[d.length-1].close=lp;
      }else{
        d.push({...d[d.length-1],date:liveQuote.data_date||lastDate,close:lp});
      }
    }
  }

  updateSingleQuickRead(radarMatch,d,a,liveQuote);
  updateAuxMarketAndForeign(s,d,currentMarket,liveQuote);

  const singlePrev=d.length>1?Number(d[d.length-2]?.close):NaN;
  const singleLast=Number(a.last ?? d[d.length-1]?.close);
  const singleChange=(Number.isFinite(singleLast)&&Number.isFinite(singlePrev)&&singlePrev!==0)?((singleLast/singlePrev)-1)*100:Number(radarMatch?.change_pct);
  currentSingleFavoriteData={
    market:String(currentMarket).toUpperCase(),symbol:String(s).toUpperCase(),name:stockName||s,
    score:Number.isFinite(Number(a.pts))?Number(a.pts):null,pivot:Number.isFinite(Number(a.pivot))?Number(a.pivot):null,
    distance:Number.isFinite(Number(a.distance))?Number(a.distance):null,change_pct:Number.isFinite(singleChange)?singleChange:null,
    volume_dry:!!a.dry,structure_quality_good:radarMatch?.structure_quality_good===true,type:radarMatch?.type||(a.todayBreakout?'breakout':(a.breakout?'postbreakout':(Number(a.distance)>-5?'near':'forming'))),
    state:a.state,squeeze_level:radarMatch?.squeeze_level||a.squeezeLevel||'',squeeze_state:a.squeezeState||'',
    momentum:radarMatch?.momentum||a.momentum||'',momentum_dir:radarMatch?.momentum_dir||'',combo:!!a.combo,
    pulse_signal:radarMatch?.pulse_signal||'wait',pulse_label:radarMatch?.pulse_label||'⭐ 單股收藏',
    contractions:Array.isArray(a.seq)?a.seq:[],data_date:d[d.length-1]?.date||'',_favorite_only:!radarMatch
  };
  if(getFavorites().has(favoriteKey(currentMarket,s))) rememberFavoriteMeta(currentSingleFavoriteData);
  // Refresh News Impact now that the live single-stock VCP analysis is available.
  // This makes its VCP score/volume/quality line use the same source as the card above.
  renderNewsImpact(currentMarket,s);
  $('title').textContent=stockName ? `${stockName}（${s}）` : `${s} · ${currentMarket==='US'?'美股':'台股'}`;renderSingleFavorite(currentMarket,s);$('period').textContent=d[0].date+' ～ '+d[d.length-1].date;$('state').textContent=a.state;
  const liveNote=$('singleLiveNote');
  if(liveNote){
    if(liveQuote && Number.isFinite(Number(liveQuote.price))){
      liveNote.hidden=false;
      const qt=liveQuote.quote_time?` ${liveQuote.quote_time}`:'';
      const src=liveQuote.source?`｜${liveQuote.source}`:'';
      const cached=String(liveQuote.source||'').includes('VCPulse');
      liveNote.textContent=`${cached?'🟡':'🟢'} ${cached?'最新盤中快取':'最新行情'} ${Number(liveQuote.price).toFixed(2)}${liveQuote.data_date?`｜${liveQuote.data_date}${qt}`:''}${src}｜盤中狀態僅供即時參考`;
    }else{
      liveNote.hidden=true; liveNote.textContent='';
    }
  }
  $('score').textContent=a.pts+'/5';$('stars').textContent='★'.repeat(a.pts)+'☆'.repeat(5-a.pts);if($('singleStructureQuality')) $('singleStructureQuality').hidden=!radarMatch?.structure_quality_good;$('pivot').textContent=a.pivot.toFixed(2);$('dist').textContent=pct(a.distance);
  // V2.43.4 — score is VCP shape quality; post-breakout is radar tracking state.
  const scoreContext=$('scoreContext');
  if(scoreContext){
    if(radarMatch?.type==='postbreakout'){
      const days=Number(radarMatch.breakout_days);
      const dtext=Number.isFinite(days)?` D+${days}`:'';
      const ret=Number(radarMatch.breakout_return_pct ?? radarMatch.distance);
      const high=Number(radarMatch.breakout_high_pct);
      const extended=String(radarMatch.pulse_signal||'')==='extended';
      const bits=[`🔵 突破後${dtext}｜雷達追蹤中`];
      if(Number.isFinite(ret)) bits.push(`目前距 Pivot ${pct(ret)}`);
      if(Number.isFinite(high)) bits.push(`突破後最高 ${pct(high)}`);
      if(extended) bits.push('⚠️ 過度延伸');
      scoreContext.hidden=false;
      scoreContext.innerHTML=`<b>型態品質 ${a.pts}/5</b><br>${bits.map(escHtml).join('｜')}`;
    }else{ scoreContext.hidden=true; scoreContext.textContent=''; }
  }
  $('contracts').textContent=a.seq.length?a.seq.map(x=>'-'+Math.abs(x).toFixed(0)+'%').join(' → '):'未辨識';$('volume').textContent=a.dry?'量縮 ✓':'未明顯量縮';
  // V2.43.1 — when Daily Radar supplied the score, render the five checks from
  // the exact same scanner components. This prevents e.g. 1/5 beside three ✓.
  const sc=radarMatch?.score_components;
  let rows=sc ? [
    ['中期上升趨勢',!!sc.trend],
    ['至少兩次價格收縮',!!sc.two_contractions],
    ['回檔幅度逐步縮小',!!sc.contracting],
    ['近期成交量乾涸',!!sc.volume_dry],
    ['接近／突破 Pivot',!!sc.pivot_condition]
  ] : [
    ['中期上升趨勢',a.trend],['至少兩次價格收縮',a.seq.length>=2],['回檔幅度逐步縮小',a.contracting],['近期成交量乾涸',a.dry],['接近／突破 Pivot',a.distance>-8]
  ];
  $('checks').innerHTML=rows.map(r=>`<div class="check"><span>${r[0]}</span><b class="${r[1]?'good':'bad'}">${r[1]?'✓':'×'}</b></div>`).join('');
  {
    const wv=effectiveWave(a,radarMatch), two=(wv.seq||[]).length>=2;
    const row=(label,detail,ok,txt,cls)=>`<div class="check check-extra"><span>${label}${detail?`<small>${escHtml(detail)}</small>`:''}</span><b class="${cls||(ok?'good':'mute')}">${txt||(ok?'✓':'–')}</b></div>`;
    $('checks').insertAdjacentHTML('beforeend',`<div class="checks-extra-title">進階參考<em>不計入 VCP 星數</em></div>`+
      row('波浪時間逐步縮短',two?`${wv.bars.join(' → ')} 日`:'需要至少兩次收縮',two&&wv.timeShrinking)+
      row('最後一次收縮夠緊（≤ 10%）',two?`最後 ${fmtDepth(wv.seq[wv.seq.length-1])}，第一次 ${fmtDepth(wv.seq[0])}`:'需要至少兩次收縮',two&&wv.lastTight));
  }
  updateSingleRisk(a.pivot,singleLast,a.lastLow);
  const _sp=effectiveSqz(a,radarMatch); const _fireNote=(_sp.squeeze_fire?` ${sqzDailyText(_sp)}${_sp.squeeze_fire_dir==='bear'?'，動能偏空，不是進場訊號。':'，動能偏多，可留意是否同時接近／突破 Pivot。'}`:'')+(_sp.sqz_w_fire?` ${sqzWeeklyText(_sp)}。`:'');
  $('summary').textContent=`${a.combo?'⚡ VCP＋Squeeze｜':''}${_sp.squeeze_fire?'':a.squeezeState+'｜'}Momentum ${a.momentum}。${_fireNote}`+(a.todayBreakout?' 最新交易日首次帶量突破 Pivot；仍應留意失敗突破風險。':(a.breakout?' 股價已在 Pivot 上方，屬突破後觀察，不列為「今日帶量突破」。':(a.distance>-5?' 價格已靠近 Pivot，可列入觀察，不必預先猜突破。':' 目前離 Pivot 還有距離，先觀察型態是否繼續收緊。')));
  draw(a)
  renderContractionLegend(a)
   setSingleStale(false);
 }catch(e){
   const fallback=findAnyRadarMatch(currentMarket,s);
   if(renderSingleFromRadarFallback(s,fallback)){
      setSingleStale(false);
    }else{
      if(e?.message==='__TRANSIENT__'){
        showErr(e.kind==='busy'
          ? `資料來源（FinMind）的免費查詢額度暫時用完，不是代號錯誤。剛查過的股票會直接用快取，其他請約 1～2 分鐘後再試。${e.detail?`（原因：${e.detail}）`:''}`
          : `暫時抓不到「${s}」的歷史資料：資料來源連線不穩，不是代號錯誤。${e.detail?`（原因：${e.detail}）`:''}`,true);
        setSingleStale(true);
        return;
      }
      const inputError=e?.message && (e.message.includes('不是有效的台股代號格式') || e.message.startsWith('找不到「') || e.message.includes('符合多檔股票') || e.message.startsWith('請輸入美股代號'));
     showErr(inputError ? e.message : `查無「${s}」可供分析的完整歷史資料。請確認股票代號是否正確；若代號正確，請稍後再試。`);
      setSingleStale(true);
    }
 }
 finally{$('go').disabled=false;$('go').textContent='開始分析'}
}
function showErr(t,retry){
  const box=$('err'); box.textContent=t; box.style.display='block';
  if(retry){
    const b=document.createElement('button'); b.type='button'; b.className='err-retry'; b.textContent='再試一次';
    b.addEventListener('click',()=>{ const go=$('go'); if(go&&!go.disabled) go.click(); });
    box.appendChild(document.createTextNode(' 請稍等幾秒後')); box.appendChild(b);
  }
}
/* 查詢失敗時，把上一檔股票的結果收起來，避免錯誤訊息下面還顯示別檔的圖表而被誤會 */
function setSingleStale(on){
  const g=document.querySelector('#singleStockAnalysis .grid'); if(g) g.classList.toggle('single-stale',!!on);
}

let capitalHotspotExpanded='';
let capitalHotspotMode='vcp';
function capitalStocksForIndustry(industry){
 const rows=(radarSnapshotData?.[radarSnapshot]||[]).filter(r=>
   String(r.market||'').toUpperCase()==='TW' && String(r.industry||'')===String(industry||'')
 );
 const seen=new Set();
 return rows.filter(r=>{const k=String(r.symbol||'');if(!k||seen.has(k))return false;seen.add(k);return true;});
}
function toggleCapitalHotspot(industry,mode){
 const key=String(industry||'');
 if(capitalHotspotExpanded===key && capitalHotspotMode===mode){
   capitalHotspotExpanded='';
 }else{
   capitalHotspotExpanded=key;
   capitalHotspotMode=mode;
 }
 renderCapitalHotspots();
}
let capitalReturnState=null;

function rememberCapitalPosition(symbol,sourceEl){
 capitalReturnState={
   symbol:String(symbol||'').toUpperCase(),
   industry:String(capitalHotspotExpanded||''),
   mode:String(capitalHotspotMode||'vcp'),
   scrollY:window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0,
   element:sourceEl || null
 };
 const btn=document.getElementById('radarBackFloat');
 if(btn){
   btn.hidden=false;
   btn.textContent='← 返回資金熱區';
   btn.setAttribute('onclick','returnToCapitalPosition()');
 }
}

function returnToCapitalPosition(){
 if(!capitalReturnState) return;
 const saved=capitalReturnState;
 capitalHotspotExpanded=saved.industry || '';
 capitalHotspotMode=saved.mode || 'vcp';
 renderCapitalHotspots();

 let target=[...document.querySelectorAll('.capital-stock-btn')].find(el=>{
   const txt=String(el.textContent||'').toUpperCase();
   return txt.includes(String(saved.symbol||'').toUpperCase());
 }) || null;
 if(target){
   const card=target.closest('.capital-hotspot') || target;
   try{ target.scrollIntoView({behavior:'smooth',block:'center'}); }
   catch(e){ target.scrollIntoView(); }
   card.classList.remove('radar-return-highlight-3s');
   void card.offsetWidth;
   card.classList.add('radar-return-highlight-3s');
   setTimeout(()=>{ if(card && document.documentElement.contains(card)) card.classList.remove('radar-return-highlight-3s'); },3000);
 }else{
   const y=Number(saved.scrollY)||0;
   try{ window.scrollTo({top:y,behavior:'smooth'}); }
   catch(e){ window.scrollTo(0,y); }
 }
 const btn=document.getElementById('radarBackFloat');
 if(btn) setTimeout(()=>btn.hidden=true,650);
}

function openCapitalStock(symbol,sourceEl){
 const input=document.getElementById('symbol');
 if(!input) return;
 rememberCapitalPosition(symbol,sourceEl);
 input.value=String(symbol||'');
 const singleSection=input.closest('.section') || input;
 if(singleSection){
   try{ singleSection.scrollIntoView({behavior:'smooth',block:'start'}); }
   catch(e){ singleSection.scrollIntoView(); }
 }else{
   window.scrollTo({top:0,behavior:'smooth'});
 }
 run();
}
function renderCapitalHotspots(){
 const box=document.getElementById('capitalHotspots');
 const grid=document.getElementById('capitalHotspotsGrid');
 if(!box || !grid) return;
 if(currentMarket!=='TW'){ box.hidden=true; grid.innerHTML=''; return; }
 const rows=(radarCapitalHotspots?.[radarSnapshot]?.TW)||[];
 if(!Array.isArray(rows) || !rows.length){
   box.hidden=false;
   grid.innerHTML='<div class="capital-hotspots-empty">尚無資金熱區資料；下一次台股完整掃描後建立。</div>';
   return;
 }
 box.hidden=false;
 // 相同熱度分數視為並列名次。卡片仍保留原資料順序，
 // 但不再用 1/2/3... 暗示同分產業存在實質高下。
 const scoreCounts=rows.reduce((m,x)=>{const k=Number(x.heat_score||0);m[k]=(m[k]||0)+1;return m;},{});
 const firstRankByScore={};
 rows.forEach((x,idx)=>{const k=Number(x.heat_score||0);if(firstRankByScore[k]==null)firstRankByScore[k]=idx+1;});
 const intradayRows=(radarCapitalHotspots?.intraday?.TW)||[];
 grid.innerHTML=rows.map((r,i)=>{
   const industry=String(r.industry||'—');
   const heatScore=Number(r.heat_score||0);
   const displayRank=firstRankByScore[heatScore] || (i+1);
   const isTie=(scoreCounts[heatScore]||0)>1;
   const intradayPeer=radarSnapshot==='official' ? intradayRows.find(x=>String(x.industry||'')===industry) : null;
   const scoreTrend=intradayPeer
     ? `<div class="capital-hotspot-scoretrend">盤中熱度 <b>${Number(intradayPeer.heat_score||0)}</b> → 收盤 <b>${heatScore}</b>${isTie?'｜同分並列':''}</div>`
     : (isTie?'<div class="capital-hotspot-scoretrend">同分並列，名次僅供排序參考</div>':'');
   const stocks=capitalStocksForIndustry(industry);
   const breakoutStocks=stocks.filter(x=>String(x.type||'')==='breakout');
   const expanded=capitalHotspotExpanded===industry;
   const shown=capitalHotspotMode==='breakout'?breakoutStocks:stocks;
   const title=capitalHotspotMode==='breakout'?`突破 ${breakoutStocks.length} 檔`:`VCP ${stocks.length} 檔`;
   const stockHtml=shown.length
     ? shown.map(x=>`<button type="button" class="capital-stock-btn ${String(x.type||'')==='breakout'?'breakout':''}" onclick="event.stopPropagation();openCapitalStock('${escHtml(String(x.symbol||''))}',this)">${escHtml(x.name||x.symbol||'—')} <span class="muted">${escHtml(x.symbol||'')}</span></button>`).join('')
     : '<div class="capital-hotspot-none">目前沒有符合的個股。</div>';
   return `
   <div class="capital-hotspot">
     <div class="capital-hotspot-top">
       <div class="capital-hotspot-namewrap">
         <span class="capital-hotspot-rank rank-${Math.min(displayRank,5)}">${displayRank}</span>
         <div class="capital-hotspot-name">${escHtml(industry)}</div>
       </div>
       <div class="capital-hotspot-scorewrap"><div class="capital-hotspot-score">${heatScore}</div>${isTie?'<span class="capital-hotspot-tie">同分</span>':''}</div>
     </div>
     <div class="capital-hotspot-metrics">
       <span>市場資金占比 <b>${Number(r.market_share_pct||0).toFixed(1)}%</b></span>
       <span>成交熱度 <b>${Number(r.value_ratio||0).toFixed(2)}×</b></span>
       <span>上漲家數 <b>${Number(r.breadth_pct||0).toFixed(0)}%</b></span>
     </div>
     ${scoreTrend}
     <div class="capital-hotspot-actions">
       <button type="button" class="capital-hotspot-action ${expanded&&capitalHotspotMode==='vcp'?'active':''}" ${stocks.length?'':'disabled'} onclick="toggleCapitalHotspot('${escHtml(industry)}','vcp')">VCP ${Number(r.vcp_count||stocks.length||0)} ▾</button>
       <button type="button" class="capital-hotspot-action ${expanded&&capitalHotspotMode==='breakout'?'active':''}" ${breakoutStocks.length?'':'disabled'} onclick="toggleCapitalHotspot('${escHtml(industry)}','breakout')">突破 ${Number(r.breakout_count||breakoutStocks.length||0)} ▾</button>
     </div>
     <div class="capital-hotspot-hint">點數字查看個股，再點股票進入完整分析</div>
     ${expanded?`<div class="capital-hotspot-detail"><div class="capital-hotspot-detail-title"><span>${title}</span><span class="muted">點股票分析 ↗</span></div><div class="capital-hotspot-list">${stockHtml}</div></div>`:''}
   </div>`;
 }).join('');
}


function cleanStockDisplayName(name){
 return String(name||'').trim().replace(/[-－—–]\s*創\s*$/u,'').trim();
}

function themeStockDisplayName(code){
 const c=String(code||'').toUpperCase();
 const q=(radarAllQuotes?.[radarSnapshot]?.TW||{})[c] || {};
 let name=String(q.name||'').trim();
 if(!name || name.toUpperCase()===c){
   const row=(radarRows||[]).find(r=>String(r.market||'').toUpperCase()==='TW' && String(r.symbol||'').toUpperCase()===c);
   name=String(row?.name||'').trim();
 }
 return name && name.toUpperCase()!==c ? name : '';
}

let themeReturnState=null;

function rememberThemePosition(symbol,sourceEl){
 themeReturnState={
   symbol:String(symbol||'').toUpperCase(),
   scrollY:window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0,
   element:sourceEl || null
 };
 const btn=document.getElementById('radarBackFloat');
 if(btn){
   btn.hidden=false;
   btn.textContent='← 返回題材雷達';
   btn.setAttribute('onclick','returnToThemePosition()');
 }
}

function returnToThemePosition(){
 if(!themeReturnState) return;
 const saved=themeReturnState;
 let target=saved.element;
 if(!target || !document.documentElement.contains(target)){
   target=[...document.querySelectorAll('[data-theme-stock]')].find(el=>String(el.dataset.themeStock||'').toUpperCase()===saved.symbol) || null;
 }
 if(target){
   const row=target.closest('.theme-row') || target;
   if(row.classList.contains('theme-row')) row.classList.add('theme-stocks-open');
   try{ row.scrollIntoView({behavior:'smooth',block:'center'}); }
   catch(e){ row.scrollIntoView(); }
   row.classList.remove('radar-return-highlight-3s');
   void row.offsetWidth;
   row.classList.add('radar-return-highlight-3s');
   setTimeout(()=>{ if(row && document.documentElement.contains(row)) row.classList.remove('radar-return-highlight-3s'); },3000);
 }else{
   const y=Number(saved.scrollY)||0;
   try{ window.scrollTo({top:y,behavior:'smooth'}); }
   catch(e){ window.scrollTo(0,y); }
 }
 const btn=document.getElementById('radarBackFloat');
 if(btn) btn.hidden=true;
}

async function openThemeStock(symbol,sourceEl){
 const code=String(symbol||'').toUpperCase();
 if(!code) return;
 rememberThemePosition(code,sourceEl);
 if(String(currentMarket||'').toUpperCase()!=='TW') setMarket('TW',{reset:false});
 $('symbol').value=code;
 const singleSection=$('symbol')?.closest('.section') || $('symbol');
 if(singleSection){
   try{ singleSection.scrollIntoView({behavior:'smooth',block:'start'}); }
   catch(e){ singleSection.scrollIntoView(); }
 }
 await run();
}

function themeLifecycleDisplay(label){
 const x=String(label||'').trim();
 if(x==='休眠') return '尚未活躍';
 return x || '觀察';
}

function renderThemeLeaderboards(){
 const box=document.getElementById('themeLeaderboards'), heatBox=document.getElementById('themeTop5List'), setupBox=document.getElementById('setupTop5List');
 if(!box||!heatBox||!setupBox)return;
 if(currentMarket!=='TW'){box.hidden=true;heatBox.innerHTML='';setupBox.innerHTML='';return;}
 const pack=(radarThemeLeaderboards?.[radarSnapshot]?.TW)||{}, heat=Array.isArray(pack.themeTop5)?pack.themeTop5:[], setup=Array.isArray(pack.setupTop5)?pack.setupTop5:[];
 box.hidden=false;
 const draw=(rows,mode)=>!rows.length?'<div class="theme-empty">尚無題材排行資料；下一次台股完整掃描後建立。</div>':rows.slice(0,5).map((r,i)=>{
  const main=mode==='heat'?Number(r.heat||0):Number(r.setup||0), peer=mode==='heat'?Number(r.setup||0):Number(r.heat||0);
  const stockDetails=Array.isArray(r.topStockDetails)&&r.topStockDetails.length
    ? r.topStockDetails.slice(0,5)
    : (Array.isArray(r.topStocks)?r.topStocks.slice(0,5).map(code=>({symbol:code,name:''})):[]);
  const stockLinks=stockDetails.map(item=>{
    const c=String(item?.symbol||'').toUpperCase();
    const dbName=String(item?.name||'').trim();
    const n=dbName || String(radarThemeStockNames?.[c]||'').trim() || themeStockDisplayName(c);
    const label=n?`${c} ${cleanStockDisplayName(n)}`:c;
    return `<button type="button" class="theme-stock-link" data-theme-stock="${escHtml(c)}" title="查看 ${escHtml(label)} 完整分析">${escHtml(label)}</button>`;
  }).join('');
  return `<div class="theme-row"><span class="theme-rank">${i+1}</span><div class="theme-main"><div class="theme-mobile-head"><div><div class="theme-name">${escHtml(String(r.theme||'—'))}</div><div class="theme-sub">共 ${Number(r.constituents||0)} 檔</div></div><div class="theme-score theme-score-mobile">${mode==='heat'?'🔥 市場熱度':'👀 蓄勢程度'} ${Math.round(main)}<small>${mode==='heat'?'👀 蓄勢程度':'🔥 市場熱度'} ${Math.round(peer)}</small></div></div>${stockLinks?`<button type="button" class="theme-stock-toggle">查看代表股 Top ${stockDetails.length}</button><div class="theme-stock-panel"><div class="theme-stock-caption">代表股 Top ${stockDetails.length}</div><div class="theme-stock-links">${stockLinks}</div></div>`:''}</div><div class="theme-score theme-score-desktop">${mode==='heat'?'🔥 市場熱度':'👀 蓄勢程度'} ${Math.round(main)}<small>${mode==='heat'?'👀 蓄勢程度':'🔥 市場熱度'} ${Math.round(peer)}</small></div></div>`;
 }).join('');
 heatBox.innerHTML=draw(heat,'heat'); setupBox.innerHTML=draw(setup,'setup');
}

document.addEventListener('click',e=>{
 const toggle=e.target.closest?.('.theme-stock-toggle');
 if(toggle){
  e.preventDefault();
  const row=toggle.closest('.theme-row');
  if(row) row.classList.toggle('theme-stocks-open');
  return;
 }
 const all=e.target.closest?.('[data-theme-expand-all]');
 if(all){
  e.preventDefault();
  const list=document.getElementById(all.dataset.themeExpandAll);
  if(!list)return;
  const rows=[...list.querySelectorAll('.theme-row')].filter(r=>r.querySelector('.theme-stock-panel'));
  const shouldOpen=rows.some(r=>!r.classList.contains('theme-stocks-open'));
  rows.forEach(r=>r.classList.toggle('theme-stocks-open',shouldOpen));
  all.textContent=shouldOpen?'全部收合 －':'展開全部 ＋';
  return;
 }
});

document.addEventListener('click',e=>{
 const btn=e.target.closest?.('[data-theme-stock]');
 if(!btn) return;
 e.preventDefault();
 openThemeStock(btn.dataset.themeStock,btn);
});

function updateMarketSpecificSnapshotUI(){
 const isUS=String(currentMarket||'TW').toUpperCase()==='US';
 const label=document.getElementById('officialSnapshotLabel');
 const note=document.getElementById('officialSnapshotNote');
 const count=document.getElementById('officialCount');
 const countText=count?.textContent||'';
 if(label){
   label.innerHTML=isUS
     ? `✅ 前一交易日收盤 <span id="officialCount">${countText}</span>`
     : `✅ 正式收盤 <span id="officialCount">${countText}</span>`;
 }
 if(note) note.textContent=isUS?'07:10 起更新':'18:10 起更新';
}

function setMarket(m,{reset=true}={}){
 const prevMarket=String(currentMarket||'').toUpperCase();
 currentMarket=m;document.documentElement.setAttribute('data-market',String(m||'TW').toUpperCase());
 const msCard=document.getElementById('marketStructureCard'); if(msCard) msCard.style.display=(String(m).toUpperCase()==='TW'?'':'none');
 if(reset || prevMarket!==String(m||'').toUpperCase()) mobileRadarPage=1;
 updateMarketSpecificSnapshotUI();
 document.querySelectorAll('.radar-market-btn').forEach(b=>b.classList.toggle('active',b.dataset.market===m));
 renderFreshness();
 renderMarketOverview();
 renderCapitalHotspots();
 renderThemeLeaderboards();
 const marketCount=(arr,m)=>arr.filter(x=>String(x.market||'').toUpperCase()===String(m||'TW').toUpperCase()).length;
 const officialCount=document.getElementById('officialCount');
 const intradayCount=document.getElementById('intradayCount');
 const intradayBtn=document.querySelector('.snapshot-btn[data-snapshot="intraday"]');
 const oc=marketCount(radarSnapshotData.official,m);
 const ic=marketCount(radarSnapshotData.intraday,m);
 if(officialCount) officialCount.textContent=oc?`(${oc})`:'';
 if(intradayCount) intradayCount.textContent=ic?`(${ic})`:'';
 updateMarketSpecificSnapshotUI();
 if(intradayBtn) intradayBtn.disabled=!ic;
 updateSnapshotAvailability();
 document.querySelectorAll('.marketbtn').forEach(b=>b.classList.toggle('active',b.dataset.market===m));
 $('symbol').placeholder=currentMarket==='US'?'例如：NVDA、TSLA、AAPL':'例如：2330、台積電';
 if(reset){
  resetNewsImpact(currentMarket==='US'?'News Impact V1 目前先支援台股；美股版之後再獨立加入。':'輸入台股代號後，查看近期重要新聞與目前價格反應。');
  $('symbol').value=currentMarket==='US'?'NVDA':'2330';
  $('title').textContent='等待分析';renderSingleFavorite(null,null);$('period').textContent='';if($('singleLiveNote')){$('singleLiveNote').hidden=true;$('singleLiveNote').textContent='';}if($('singleRestoreNote')){$('singleRestoreNote').hidden=true;$('singleRestoreNote').textContent='';}$('state').textContent='—';
  $('score').textContent='—';$('stars').textContent='☆☆☆☆☆';if($('singleStructureQuality')) $('singleStructureQuality').hidden=true;if($('scoreContext')){$('scoreContext').hidden=true;$('scoreContext').textContent='';}$('pivot').textContent='—';$('dist').textContent='—';
  $('contracts').textContent='—';$('volume').textContent='—';$('checks').innerHTML='';$('summary').textContent='輸入股票代號後開始。';resetSingleQuickRead();
 }
 renderRadar(radarFilter);
}
document.querySelectorAll('.marketbtn').forEach(btn=>{
 btn.onclick=()=>setMarket(btn.dataset.market,{reset:true});
});
$('go').onclick=run;$('symbol').onkeydown=e=>{if(e.key==='Enter')run()};


// Daily radar: load results generated by GitHub Actions.
let radarRows=[];
let radarSnapshot='official';
let radarSnapshotManuallyChosen=false;
let radarSnapshotData={official:[],intraday:[]};
let radarSnapshotMeta={official:{},intraday:{}};
let radarBenchmarkData={official:{},intraday:{}};
let radarMarketRegime = {};
let radarCapitalHotspots={official:{},intraday:{}};
let radarThemeLeaderboards={official:{},intraday:{}};
let radarThemeStockNames={};
let radarAllQuotes={official:{},intraday:{}};
let radarRestoreEvents={official:{},intraday:{}};
// V2.44 — lightweight TW market quote cache. This is intentionally separate
// from VCP structure snapshots: only price/change/distance are overlaid.
let serverLiveQuotesTW=new Map();
let serverLiveQuotesMeta={generated_at:'',latest_quote_time:'',data_dates:[],quote_count:0,target_count:0};
let serverLiveQuotePollTimer=null;

let userLiveQuotes=new Map();
let userLiveUpdatedAt='';

let radarFilter = 'all';
/* 多選篩選：radarFilter 是組合字串（'all' 或 'a+b'），沿用既有程式。
   規則：同一組（關注訊號／型態階段／壓縮等級）＝「或」，不同組與其他條件＝「且」。 */
const RADAR_OR_GROUPS = {
  pulse: { hot:r=>r.pulse_signal==='hot', watch:r=>r.pulse_signal==='watch', wait:r=>r.pulse_signal==='wait', extended:r=>r.pulse_signal==='extended' },
  stage: { breakout:r=>r.type==='breakout', postbreakout:r=>r.type==='postbreakout', near:r=>r.type==='near', forming:r=>r.type==='forming' },
  sqz:   { sqz_strong:r=>r.squeeze_level==='strong', sqz_medium:r=>r.squeeze_level==='medium', sqz_weak:r=>r.squeeze_level==='weak',
           sqz_none:r=>!['strong','medium','weak'].includes(r.squeeze_level) }
};
const RADAR_AND_FLAGS = {
  favorites:r=>isFavorite(r), 'new':r=>r.is_new===true, quality:r=>r.structure_quality_good===true,
  combo:r=>!!r.combo, rs80:r=>Number(r.rs_rating)>=80, tt:r=>ttFull(r), fire:r=>sqzFireBull(r)
};
/* 階段 3：數值條件（留空＝不限制）與自訂排序（最多兩層） */
let radarNum = { rs:null, dist:null, score:null, chg:null };
let radarCustomSort = [ {key:'score',dir:'desc'}, {key:'',dir:'desc'} ];
const RADAR_CSORT = {
  score:   {label:'VCP 分數',            val:r=>Number(r.score), def:'desc'},
  rs:      {label:'RS 強度',             val:r=>Number(r.rs_rating), def:'desc'},
  distance:{label:'距 Pivot（絕對值）',   val:r=>Math.abs(Number(r.distance)), def:'asc'},
  change:  {label:'今日漲幅',            val:r=>Number(r.change_pct), def:'desc'},
  tt:      {label:'趨勢模板項數',         val:r=>Number(r.tt_count), def:'desc'},
  squeeze: {label:'壓縮強度（💥最前）',   val:r=>sqzFireBull(r)?4:({strong:3,medium:2,weak:1,none:0}[r.squeeze_level]), def:'desc'},
  sqzdays: {label:'壓縮連續天數',         val:r=>Number(r.squeeze_run_days), def:'desc'},
  momentum:{label:'Momentum 強度',       val:r=>({bull_up:3,bear_up:2,bull_down:1,bear_down:0}[r.momentum_dir]), def:'desc'}
};
function radarNumActive(){ return Object.values(radarNum).some(v=>v!=null); }
function radarNumPass(r){
  const n=radarNum;
  if(n.rs!=null && !(Number(r.rs_rating)>=n.rs)) return false;
  if(n.dist!=null){ const d=Math.abs(Number(r.distance)); if(!(Number.isFinite(d)&&d<=n.dist)) return false; }
  if(n.score!=null && !(Number(r.score)>=n.score)) return false;
  if(n.chg!=null && !(Number(r.change_pct)>=n.chg)) return false;
  return true;
}
function radarCustomCompare(a,b,fallback){
  for(const c of radarCustomSort){
    const d=RADAR_CSORT[c.key]; if(!d) continue;
    let av=d.val(a), bv=d.val(b);
    av=Number.isFinite(av)?av:null; bv=Number.isFinite(bv)?bv:null;
    if(av===null&&bv===null) continue;
    if(av===null) return 1; if(bv===null) return -1;
    if(av!==bv) return c.dir==='asc'?av-bv:bv-av;
  }
  return fallback(a,b);
}
function radarKeys(filter){ return (!filter||filter==='all')?[]:String(filter).split('+').filter(Boolean); }
function radarRowPass(r,filter){
  const keys=radarKeys(filter); if(!keys.length) return true;
  for(const g of Object.values(RADAR_OR_GROUPS)){
    const picked=keys.filter(k=>g[k]); if(picked.length && !picked.some(k=>g[k](r))) return false;
  }
  for(const k of keys){ if(RADAR_AND_FLAGS[k] && !RADAR_AND_FLAGS[k](r)) return false; }
  return true;
}
function syncRadarTabs(){
  const keys=radarKeys(radarFilter);
  document.querySelectorAll('.radar-tab').forEach(b=>{
    const k=b.dataset.radar, on=(k==='all')?keys.length===0:keys.includes(k);
    b.classList.toggle('active',on); b.setAttribute('aria-pressed',on?'true':'false');
  });
  const box=document.getElementById('radarFilterSummary'); if(!box) return;
  const numParts=[];
  if(radarNum.rs!=null) numParts.push('RS ≥ '+radarNum.rs);
  if(radarNum.dist!=null) numParts.push('距 Pivot ≤ '+radarNum.dist+'%');
  if(radarNum.score!=null) numParts.push('VCP ≥ '+radarNum.score+' 星');
  if(radarNum.chg!=null) numParts.push('今日漲幅 ≥ '+radarNum.chg+'%');
  box.hidden=!(keys.length||numParts.length);
  const txt=box.querySelector('.rfs-text');
  if(txt) txt.textContent=keys.map(k=>{const b=document.querySelector('.radar-tab[data-radar="'+k+'"]'); return b?(k==='favorites'?'★ 我的收藏':b.textContent.trim()):k;}).concat(numParts).join(' ＋ ');
  try{ if(typeof syncRadarCustomUI==='function') syncRadarCustomUI(); }catch(e){}
}
function setRadarFilterKeys(keys){
  radarFilter=keys.length?keys.join('+'):'all';
  mobileRadarPage=1; syncRadarTabs(); renderRadar(radarFilter);
}
function clearRadarAllFilters(){
  radarNum={rs:null,dist:null,score:null,chg:null};
  setRadarFilterKeys([]);
}
function toggleRadarKey(k){
  if(k==='all') return clearRadarAllFilters();
  const keys=radarKeys(radarFilter), i=keys.indexOf(k);
  if(i>=0) keys.splice(i,1); else keys.push(k);
  setRadarFilterKeys(keys);
}
let radarSort = 'smart';
let radarChangeSortDir = 'desc'; // desc: 漲最多→跌最多；asc: 跌最多→漲最多
let mobileRadarPage = 1;
const MOBILE_RADAR_PAGE_SIZE = 5;

const RADAR_UI={
  market:{
    TW:'🇹🇼 台股',
    US:'🇺🇸 美股'
  },
  stage:{
    breakout:'🟢 今日帶量突破',
    postbreakout:'🔵 突破後',
    near:'🟡 接近 Pivot',
    forming:'⚪ VCP 成形中'
  },
  squeeze:{
    strong:'🔴 強力壓縮',
    medium:'🟠 中度壓縮',
    weak:'🩷 一般壓縮',
    none:'⚪ 無壓縮'
  },
  momentum:{
    bull_up:'↑ 多方增強',
    bear_up:'↗ 空方減弱',
    bull_down:'↘ 多方減弱',
    bear_down:'↓ 空方增強'
  },
  pulse:{
    hot:'🔥 高關注',
    watch:'👀 觀察',
    wait:'⏳ 等待',
    extended:'⚠️ 過度延伸'
  }
};
function marketLabel(m){ return RADAR_UI.market[m] || m || '—'; }
function stageLabel(r){
  if(r.type==='postbreakout' && Number.isFinite(Number(r.breakout_days))){
    return `🔵 突破後 D+${Number(r.breakout_days)}`;
  }
  return RADAR_UI.stage[r.type] || r.state || '—';
}
function stagePill(r){
  const raw=String(stageLabel(r)); const t=raw.replace(/^[^\p{L}\p{N}]+/u,'')||raw;
  const cls=String(r.type||'').replace(/[^a-z]/g,'');
  return `<span class="st-pill st-${cls}">${t.replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}</span>`;
}
function updateKpiStrip(filter){
  const box=document.getElementById('kpiStrip'); if(!box) return;
  const mk=String(currentMarket||'TW').toUpperCase();
  const rows=(Array.isArray(radarRows)?radarRows:[]).filter(r=>String(r.market||'').toUpperCase()===mk);
  const cnt={breakout:rows.filter(r=>r.type==='breakout').length,hot:rows.filter(r=>r.pulse_signal==='hot').length,near:rows.filter(r=>r.type==='near').length,combo:rows.filter(r=>r.combo).length};
  box.querySelectorAll('[data-kpi]').forEach(b=>{const n=b.querySelector('.kpi-num'); if(n) n.textContent=cnt[b.dataset.kpi]; b.classList.toggle('active',filter===b.dataset.kpi);});
  const fireN=rows.filter(sqzFireBull).length, fe=document.getElementById('kpiFire'), fn=document.getElementById('kpiFireN');
  if(fn) fn.textContent=fireN; if(fe){ fe.hidden=!fireN; fe.classList.toggle('active',filter==='fire'); }
  box.hidden=!rows.length;
}
function kpiGo(k){
  /* KPI 卡片＝單一捷徑：已經只選這一項就取消，否則改成只選這一項 */
  radarNum={rs:null,dist:null,score:null,chg:null};
  setRadarFilterKeys(radarFilter===k?[]:[k]);
  const w=document.querySelector('.radar-table-wrap'), mb=document.getElementById('radarMobile');
  const tg=(w&&w.offsetParent)?w:mb; if(tg) setTimeout(()=>tg.scrollIntoView({behavior:'smooth',block:'start'}),60);
}
function squeezeLabel(r){
 if(r.squeeze_fire){ return `💥 Squeeze ${r.squeeze_fire_dir==='bear'?'向下爆發':'爆發'} ${sqzFireAge(r.squeeze_fire_days)}`; }
 return RADAR_UI.squeeze[r.squeeze_level] || r.squeeze_state || '—';
}
function momentumLabel(r){ return RADAR_UI.momentum[r.momentum_dir] || r.momentum || '—'; }
function attentionReason(r){
 const bits=[`${Number(r.score||0)}★`];
 if(r.type==='breakout') bits.push('今日突破');
 else if(r.type==='postbreakout') bits.push('突破後守 Pivot');
 else if(r.type==='near') bits.push('接近突破');
 const sq={strong:'強力壓縮',medium:'中度壓縮',weak:'一般壓縮'}[r.squeeze_level];
 if(sq) bits.push(sq);
 else if(r.squeeze_fire&&r.squeeze_fire_dir==='bull') bits.push('Squeeze 爆發');
 if(r.sqz_w_fire&&r.sqz_w_fire_dir==='bull') bits.push('週線爆發');
 if(r.momentum_dir==='bull_up') bits.push('多方增強');
 else if(r.momentum_dir==='bear_up') bits.push('空方減弱');
 return bits.slice(0,4).join(' · ');
}
function pulseLabel(r){ return RADAR_UI.pulse[r.pulse_signal] || r.pulse_label || '⏳ 等待'; }
function volumeLabel(r){ return r.volume_dry ? '量縮 ✓' : '一般'; }
function liquidityInfo(r){
 if(String(r?.market||currentMarket||'TW').toUpperCase()!=='TW') return null;
 let lots=Number(r?.avg_volume_20d_lots);
 if(!Number.isFinite(lots)){const raw=Number(r?.avg_volume_20d ?? r?.avgVolume20);if(Number.isFinite(raw)) lots=raw/1000;}
 if(!Number.isFinite(lots)) return null;
 let emoji='🔴',label='極低';
 if(lots>=2000){emoji='🟢';label='高';}else if(lots>=1000){emoji='🟢';label='良好';}else if(lots>=500){emoji='🟡';label='普通';}else if(lots>=300){emoji='🟠';label='偏低';}else if(lots>=100){emoji='⚠️';label='低';}
 return {emoji,label,lots};
}
function fmtLots(v){const n=Number(v);if(!Number.isFinite(n))return '—';return n>=100?Math.round(n).toLocaleString('zh-TW'):n.toFixed(n<10?1:0);}
function fmtMoneyTW(v){const n=Number(v);if(!Number.isFinite(n))return '—';if(n>=1e8)return `${(n/1e8).toFixed(n>=1e9?1:2)} 億`;if(n>=1e4)return `${Math.round(n/1e4).toLocaleString('zh-TW')} 萬`;return Math.round(n).toLocaleString('zh-TW');}
function liquidityCompact(r){const q=liquidityInfo(r);return q?`${q.emoji} ${q.label}`:'';}
function liquidityDesktop(r){const q=liquidityInfo(r);return q?`${q.emoji} ${q.label} · ${fmtLots(q.lots)} 張`:'';}
function updateSingleLiquidity(radarMatch,a){
 const box=$('singleLiquidity');if(!box)return;const src={market:currentMarket,avg_volume_20d_lots:radarMatch?.avg_volume_20d_lots,avg_volume_20d:radarMatch?.avg_volume_20d,avgVolume20:a?.avgVolume20};const q=liquidityInfo(src);if(!q){box.hidden=true;box.innerHTML='';return;}const value=Number(radarMatch?.avg_value_20d ?? a?.avgValue20);box.hidden=false;box.innerHTML=`<b>流動性 ${q.emoji} ${q.label}</b><span>20日均量 ${fmtLots(q.lots)} 張</span>${Number.isFinite(value)?`<span>20日均額 ${fmtMoneyTW(value)}</span>`:''}`;
}
function signedPct(v){ const n=Number(v); if(!Number.isFinite(n)) return '—'; return `${n>0?'+':''}${n.toFixed(1)}%`; }

/* 相對強度（RS）標籤：只做標註，不影響 VCP 分數與篩選；資料由 scanner.py 的 rs_rating（1–99）提供 */
function shChipSym(r){ const x=[r&&(r.symbol||r.code),r&&(r.name||r.stock_name)].filter(Boolean).join(" ").replace(/[&<>"']/g,""); return x; }
function rsChip(r,asBlock){
 const n=Number(r&&r.rs_rating);
 if(!Number.isFinite(n)||n<=0) return '';
 const tier=n>=90?'top':(n>=80?'hi':(n>=70?'mid':'low'));
 const tip=`相對強度 RS ${n}：近 3／6／9／12 個月加權漲幅，在同市場流動性足夠的股票中排名前 ${Math.max(1,100-n)}%（1–99，越高越強；僅供參考，不影響 VCP 分數）`;
 const chip=`<span class="rs-chip rs-${tier} sh-chip" data-sh="rs" data-rs="${n}" data-sym="${shChipSym(r)}" role="button" tabindex="0" title="${tip}">RS ${n}</span>`;
 return asBlock?`<div class="rs-line">${chip}</div>`:chip;
}

/* 趨勢模板（Minervini Trend Template 的價格面 7 項）：只做標註，不影響 VCP 分數與篩選；資料由 scanner.py 的 tt_count / tt_fail 提供 */
const TT_LABELS={1:'股價在 150 與 200 日線之上',2:'150 日線在 200 日線之上',3:'200 日線上彎（比一個月前高）',4:'50 日線在 150 與 200 日線之上',5:'股價在 50 日線之上',6:'距 52 週低點至少 +30%',7:'距 52 週高點不超過 25%'};
function ttFull(r){ return Number(r&&r.tt_count)===7 && Number(r&&r.rs_rating)>=70; }
function ttTipText(count,fail,rs){
 const miss=(Array.isArray(fail)?fail:[]).map(k=>TT_LABELS[k]).filter(Boolean);
 let t=`趨勢模板 ${count}/7（價格面）`;
 if(miss.length) t+=`；未符合：${miss.join('、')}`;
 else t+=Number(rs)>=70?'；7 項全過，且 RS ≥ 70，完整符合':'；7 項全過（經典標準另要求 RS ≥ 70）';
 return t+'。僅供參考，不影響 VCP 分數';
}
function ttChip(r){
 const n=Number(r&&r.tt_count);
 if(r==null||r.tt_count==null||!Number.isFinite(n)) return '';
 const tier=n>=7?'full':(n>=5?'near':'low');
 return `<span class="tt-chip tt-${tier} sh-chip" data-sh="tt" data-tt="${n}" data-fail="${(Array.isArray(r.tt_fail)?r.tt_fail:[]).join(',')}" data-rs="${Number(r.rs_rating)||''}" data-sym="${shChipSym(r)}" role="button" tabindex="0" title="${ttTipText(n,r.tt_fail,r.rs_rating)}">趨勢 ${n}/7</span>`;
}
function rsTtLine(r){
 const a=rsChip(r), b=ttChip(r);
 return (a||b)?`<div class="rs-line">${a}${b}</div>`:'';
}

/* V2.46.0 — Squeeze 爆發（彩色點 → 第一個灰點）與 VCP 波浪品質的顯示輔助 */
function fmtDepth(x){ const v=Math.abs(Number(x)); return Number.isFinite(v)?(v<10?v.toFixed(1):String(Math.round(v)))+'%':'—'; }
function sqzFireAge(n){ return Number(n)===0?'今日':`D+${Number(n)}`; }
function sqzFireBull(r){ return !!(r&&((r.squeeze_fire&&r.squeeze_fire_dir==='bull')||(r.sqz_w_fire&&r.sqz_w_fire_dir==='bull'))); }
function effectiveSqz(a,rm){ return (rm&&Object.prototype.hasOwnProperty.call(rm,'squeeze_fire'))?rm:((a&&a.sqz)||{}); }
function effectiveWave(a,rm){
 if(rm&&Object.prototype.hasOwnProperty.call(rm,'time_shrinking')) return {bars:Array.isArray(rm.contraction_bars)?rm.contraction_bars:[],timeShrinking:!!rm.time_shrinking,lastTight:!!rm.last_tight,seq:Array.isArray(rm.contractions)?rm.contractions.map(Number):[]};
 const w=(a&&a.wave)||{}; return {bars:w.contractionBars||[],timeShrinking:!!w.timeShrinking,lastTight:!!w.lastTight,seq:(a&&a.seq)||[]};
}
function sqzDailyText(p){
 if(!p||!p.squeeze_fire) return '';
 const bear=p.squeeze_fire_dir==='bear', lv=SQZ_LABEL[p.squeeze_fire_prev_level]||'壓縮';
 return `💥 Squeeze ${bear?'向下爆發':'爆發'} ${sqzFireAge(p.squeeze_fire_days)}（前 ${p.squeeze_fire_prev_bars} 日${lv}）`;
}
function sqzWeeklyText(p){
 if(!p||!p.sqz_w_fire) return '';
 const bear=p.sqz_w_fire_dir==='bear', wk=Number(p.sqz_w_fire_weeks)===0?(p.sqz_w_partial?'本週進行中':'本週'):'上週';
 return `📅 週線 Squeeze ${bear?'向下爆發':'爆發'}（${wk}，前 ${p.sqz_w_prev_bars} 週${SQZ_LABEL[p.sqz_w_prev_level]||'壓縮'}）`;
}
/* 精簡模式專用：壓縮燈號（強／中／弱壓縮；無壓縮時不顯示，避免精簡卡片太擠） */
function sqzLampCompact(r){
 const lv=r&&r.squeeze_level; const map={strong:'強壓縮',medium:'中壓縮',weak:'弱壓縮'};
 if(!map[lv]) return '';
 const run=Number(r.squeeze_run_days)>0?`，已連續 ${Number(r.squeeze_run_days)} 日`:'';
 return `<span class="mobile-sqz-lamp lv-${lv}" title="${escHtml(squeezeLabel(r)+run)}"><i></i>${map[lv]}</span>`;
}
function sqzFireMini(r){
 if(!r||(!r.squeeze_fire&&!r.sqz_w_fire)) return '';
 const bits=[]; let bear=false;
 if(r.squeeze_fire){ bits.push((r.squeeze_fire_dir==='bear'?'↓':'')+sqzFireAge(r.squeeze_fire_days)); bear=r.squeeze_fire_dir==='bear'; }
 if(r.sqz_w_fire){ bits.push('週'+(r.sqz_w_fire_dir==='bear'?'↓':'')); if(!r.squeeze_fire) bear=r.sqz_w_fire_dir==='bear'; }
 const tip=[sqzDailyText(r),sqzWeeklyText(r)].filter(Boolean).join('；');
 return ` <span class="sqz-fire-mini${bear?' is-bear':''}" title="${escHtml(tip)}">💥 ${escHtml(bits.join('・'))}</span>`;
}
function sqzWeeklyChip(r){
 if(!r||!r.sqz_w_fire) return '';
 const bear=r.sqz_w_fire_dir==='bear';
 return `<span class="sqz-w-chip${bear?' is-bear':''}" title="${escHtml(sqzWeeklyText(r))}">週 💥${bear?'↓':''}</span>`;
}

const FAVORITES_KEY='vcpulse_favorites_v1';
const FAVORITE_META_KEY='vcpulse_favorite_meta_v2';
function favoriteKey(market,symbol){ return `${String(market||'').toUpperCase()}:${String(symbol||'').toUpperCase()}`; }
function getFavorites(){
 try{ const x=JSON.parse(localStorage.getItem(FAVORITES_KEY)||'[]'); return new Set(Array.isArray(x)?x.map(String):[]); }
 catch(e){ return new Set(); }
}
function getFavoriteMeta(){
 try{ const x=JSON.parse(localStorage.getItem(FAVORITE_META_KEY)||'{}'); return (x&&typeof x==='object'&&!Array.isArray(x))?x:{}; }
 catch(e){ return {}; }
}
function saveFavoriteMeta(meta){ localStorage.setItem(FAVORITE_META_KEY,JSON.stringify(meta||{})); }
function favoriteFallbackRow(key,meta={}){
 const [market='TW',...rest]=String(key||'').split(':');
 const symbol=rest.join(':').toUpperCase();
 return {
   market:market.toUpperCase(),symbol,name:meta.name||symbol,
   score:(meta.score!==null&&meta.score!==''&&Number.isFinite(Number(meta.score)))?Number(meta.score):null,
   pivot:(meta.pivot!==null&&meta.pivot!==''&&Number.isFinite(Number(meta.pivot)))?Number(meta.pivot):null,
   distance:(meta.distance!==null&&meta.distance!==''&&Number.isFinite(Number(meta.distance)))?Number(meta.distance):null,
   change_pct:(meta.change_pct!==null&&meta.change_pct!==''&&Number.isFinite(Number(meta.change_pct)))?Number(meta.change_pct):null,
   volume_dry:typeof meta.volume_dry==='boolean'?meta.volume_dry:null,
   type:meta.type||'favorite',state:meta.state||'⭐ 單股收藏',
   squeeze_level:meta.squeeze_level||'',squeeze_state:meta.squeeze_state||'',
   momentum:meta.momentum||'',momentum_dir:meta.momentum_dir||'',
   combo:!!meta.combo,pulse_signal:meta.pulse_signal||'wait',pulse_label:meta.pulse_label||'⭐ 單股收藏',
   contractions:Array.isArray(meta.contractions)?meta.contractions:[],
   data_date:meta.data_date||'',_favorite_only:true
 };
}
function rememberFavoriteMeta(row){
 if(!row || !row.market || !row.symbol) return;
 const key=favoriteKey(row.market,row.symbol), meta=getFavoriteMeta();
 meta[key]={...favoriteFallbackRow(key,row),...row,market:String(row.market).toUpperCase(),symbol:String(row.symbol).toUpperCase(),_favorite_only:!!row._favorite_only};
 saveFavoriteMeta(meta);
}

// V2.42.3 — 收藏名稱自動補齊。
// 舊版收藏可能只留下代號；進入「我的收藏」時，一次抓股票基本資料補回名稱，
// 不需要再先點進單股分析才能看到完整名稱。
let favoriteNameHydrating=false;
let favoriteNameHydratedMarkets=new Set();
async function hydrateFavoriteNames(market){
 const m=String(market||currentMarket||'TW').toUpperCase();
 if(favoriteNameHydrating || favoriteNameHydratedMarkets.has(m)) return false;
 const favs=[...getFavorites()].filter(k=>String(k).toUpperCase().startsWith(`${m}:`));
 if(!favs.length){ favoriteNameHydratedMarkets.add(m); return false; }
 const meta=getFavoriteMeta();
 const missing=favs.filter(key=>{
   const sym=String(key).split(':').slice(1).join(':').toUpperCase();
   const name=String(meta[key]?.name||'').trim();
   return !name || name.toUpperCase()===sym;
 });
 if(!missing.length){ favoriteNameHydratedMarkets.add(m); return false; }
 favoriteNameHydrating=true;
 try{
   const rows=await fmStockInfo(m);
   const nameMap=new Map(rows.filter(x=>x?.stock_id).map(x=>[String(x.stock_id).toUpperCase(),String(x.stock_name||x.stock_id)]));
   let changed=false;
   for(const key of missing){
     const sym=String(key).split(':').slice(1).join(':').toUpperCase();
     const name=nameMap.get(sym);
     if(name && name!==sym){
       meta[key]={...favoriteFallbackRow(key,meta[key]||{}),...(meta[key]||{}),market:m,symbol:sym,name};
       changed=true;
     }
   }
   if(changed) saveFavoriteMeta(meta);
   favoriteNameHydratedMarkets.add(m);
   return changed;
 }catch(e){
   return false;
 }finally{
   favoriteNameHydrating=false;
 }
}
function saveFavorites(set){ localStorage.setItem(FAVORITES_KEY,JSON.stringify([...set])); updateFavoriteCount(); }
function isFavorite(r){ return getFavorites().has(favoriteKey(r.market,r.symbol)); }
let currentSingleFavorite={market:null,symbol:null};
let currentSingleFavoriteData=null;
function renderSingleFavorite(market,symbol){
 const btn=document.getElementById('singleFavorite');
 if(!btn) return;
 if(!market || !symbol){ btn.hidden=true; currentSingleFavorite={market:null,symbol:null}; currentSingleFavoriteData=null; return; }
 currentSingleFavorite={market:String(market).toUpperCase(),symbol:String(symbol).toUpperCase()};
 const fav=getFavorites().has(favoriteKey(currentSingleFavorite.market,currentSingleFavorite.symbol));
 btn.hidden=false;
 btn.textContent=fav?'★':'☆';
 btn.classList.toggle('is-favorite',fav);
 btn.setAttribute('aria-label',fav?'取消收藏':'收藏股票');
 btn.title=fav?'取消收藏':'收藏股票';
}
function toggleFavorite(market,symbol,row=null){
 market=String(market||'').toUpperCase(); symbol=String(symbol||'').toUpperCase();
 const set=getFavorites(), key=favoriteKey(market,symbol), meta=getFavoriteMeta();
 if(set.has(key)){
   set.delete(key); delete meta[key]; saveFavoriteMeta(meta);
 }else{
   set.add(key);
   const source=row || findAnyRadarMatch(market,symbol) || favoriteFallbackRow(key);
   rememberFavoriteMeta({...source,market,symbol,_favorite_only:!findAnyRadarMatch(market,symbol)});
 }
 saveFavorites(set);
 renderRadar(radarFilter);
 if(currentSingleFavorite.market===market && currentSingleFavorite.symbol===symbol){
   renderSingleFavorite(market,symbol);
 }
}
function updateFavoriteCount(){
 const el=document.getElementById('favoriteCount');
 if(!el) return;
 const market=String(currentMarket||'TW').toUpperCase();
 const count=[...getFavorites()].filter(k=>String(k).toUpperCase().startsWith(`${market}:`)).length;
 el.textContent=count;
}
const singleFavoriteBtn=document.getElementById('singleFavorite');
if(singleFavoriteBtn){
 singleFavoriteBtn.addEventListener('click',()=>{
   const x=currentSingleFavorite;
   if(x.market && x.symbol) toggleFavorite(x.market,x.symbol,currentSingleFavoriteData);
 });
}

let radarReturnState=null;

function rememberRadarPosition(market,symbol,sourceEl){
 radarReturnState={
   market:String(market),
   symbol:String(symbol),
   filter:radarFilter,
   page:mobileRadarPage,
   scrollY:window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0,
   element:sourceEl || null
 };
 const btn=document.getElementById('radarBackFloat');
 if(btn){ btn.hidden=false; btn.textContent='← 返回剛才清單'; btn.setAttribute('onclick','returnToRadarPosition()'); }
}

function returnToRadarPosition(){
 if(!radarReturnState) return;
 const saved=radarReturnState;

 // V2.41.24：手機從第 2 頁之後進入單股分析時，
 // 返回雷達要先恢復原本的頁碼，再重畫該頁，才找得到原本股票卡片。
 if(Number.isFinite(Number(saved.page))){
   mobileRadarPage=Math.max(1,Number(saved.page));
 }
 if(saved.filter){
   radarFilter=saved.filter; syncRadarTabs();
 }
 renderRadar(radarFilter);

 // The radar may have re-rendered after analysis, so re-find the same stock
 // instead of relying only on the old DOM element reference.
 let target=null;
 if(!target){
   const market=String(saved.market||'');
   const symbol=String(saved.symbol||'');
   const nodes=[...document.querySelectorAll('[data-market][data-symbol]')];
   const matches=nodes.filter(el=>String(el.dataset.market)===market && String(el.dataset.symbol)===symbol &&
     (el.matches('.mobile-stock-card') || el.matches('tr[data-symbol]')));
   target=matches.find(el=>el.offsetParent!==null) || matches[0] || null;
 }

 if(target){
   try{ target.scrollIntoView({behavior:'smooth',block:'center'}); }
   catch(e){ target.scrollIntoView(); }

   target.classList.remove('radar-return-highlight-3s');
   void target.offsetWidth;
   target.classList.add('radar-return-highlight-3s');
   setTimeout(()=>{
     if(target && document.documentElement.contains(target)){
       target.classList.remove('radar-return-highlight-3s');
     }
   },3000);
 }else{
   const y=Number(saved.scrollY)||0;
   try{ window.scrollTo({top:y,behavior:'smooth'}); }
   catch(e){ window.scrollTo(0,y); }
   setTimeout(()=>{
     if(Math.abs((window.pageYOffset||0)-y)>80){
       document.documentElement.scrollTop=y;
       document.body.scrollTop=y;
     }
   },350);
 }

 const btn=document.getElementById('radarBackFloat');
 if(btn) setTimeout(()=>btn.hidden=true,650);
}

function changePctClass(v){
 const n=Number(v);
 if(!Number.isFinite(n) || Math.abs(n)<0.005) return 'flat';
 return n>0?'up':'down';
}
function changePctText(v){
 const n=Number(v);
 if(!Number.isFinite(n)) return '—';
 return `${n>0?'+':''}${n.toFixed(1)}%`;
}

function pivotDistanceVisual(distance){
  const d=Number(distance);
  if(!Number.isFinite(d)) return {zone:'near', cls:'near', width:8};
  const abs=Math.abs(d);
  if(abs<=1) return {zone:'near', cls:'near', width:8};
  // Each side represents 0–8% away from Pivot, capped at half of the bar.
  const width=Math.max(7,Math.min(50,(Math.min(abs,8)/8)*50));
  return d<0
    ? {zone:'negative', cls:'negative', width}
    : {zone:'positive', cls:'positive', width};
}


function twTodayYmd(){
 try{
   const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
   const obj=Object.fromEntries(parts.map(x=>[x.type,x.value]));
   return `${obj.year}-${obj.month}-${obj.day}`;
 }catch(e){ return ''; }
}
function serverLiveQuoteFor(market,symbol){
 if(String(market||'').toUpperCase()!=='TW') return null;
 const q=serverLiveQuotesTW.get(String(symbol||'').toUpperCase())||null;
 if(!q) return null;
 // Never paint a previous trading day's quote as today's "live" price.
 const qd=String(q.data_date||'');
 const today=twTodayYmd();
 if(qd && today && qd!==today) return null;
 return q;
}
function liveQuoteBadgeText(r){
 if(!r?._live) return '';
 const t=String(r._quote_time||serverLiveQuotesMeta.latest_quote_time||'').slice(0,5);
 return t?`行情 ${t}`:'行情';
}
async function loadServerLiveQuotesTW(showStatus=false){
 const status=document.getElementById('userLiveRefreshStatus');
 try{
   const res=await fetch(`data/live_quotes_tw.json?t=${Date.now()}`,{cache:'no-store'});
   if(!res.ok) throw new Error(`HTTP ${res.status}`);
   const j=await res.json();
   const quotes=j&&typeof j.quotes==='object'&&j.quotes?j.quotes:{};
   const next=new Map();
   Object.entries(quotes).forEach(([sym,q])=>{
     const price=Number(q?.price), prev=Number(q?.prev_close);
     if(Number.isFinite(price)&&price>0&&Number.isFinite(prev)&&prev>0){
       next.set(String(sym).toUpperCase(),{...q,price,prev_close:prev});
     }
   });
   serverLiveQuotesTW=next;
   serverLiveQuotesMeta={
     generated_at:String(j.generated_at||''),
     latest_quote_time:String(j.latest_quote_time||''),
     data_dates:Array.isArray(j.data_dates)?j.data_dates:[],
     quote_count:Number(j.quote_count)||next.size,
     target_count:Number(j.target_count)||0
   };
   const qt=serverLiveQuotesMeta.latest_quote_time?serverLiveQuotesMeta.latest_quote_time.slice(0,5):'';
   if(status && (showStatus || currentMarket==='TW')){
     status.textContent=next.size
       ? `台股行情快取 ${qt||'—'}｜${next.size} 檔；價格／今日漲跌／距 Pivot 使用行情快取，VCP 結構仍依完整掃描。`
       : '台股行情快取尚未建立；目前保留雷達掃描價格。';
   }
   return next.size;
 }catch(e){
   console.warn('TW live quote cache unavailable',e);
   if(status && showStatus) status.textContent='暫時讀不到盤中行情快取；已保留雷達掃描資料，不會用錯誤行情覆蓋。';
   return 0;
 }
}
function startServerLiveQuotePolling(){
 if(serverLiveQuotePollTimer) return;
 serverLiveQuotePollTimer=setInterval(async()=>{
   if(String(currentMarket||'').toUpperCase()!=='TW' || radarSnapshot!=='intraday') return;
   const before=serverLiveQuotesMeta.generated_at;
   const count=await loadServerLiveQuotesTW(false);
   if(count && serverLiveQuotesMeta.generated_at!==before) renderRadar(radarFilter);
 },60000);
}

function liveQuoteKey(market,symbol){ return `${String(market||'').toUpperCase()}:${String(symbol||'').toUpperCase()}`; }
function effectiveRadarRow(r){
 const manual=userLiveQuotes.get(liveQuoteKey(r.market,r.symbol));
 const cached=(radarSnapshot==='intraday')?serverLiveQuoteFor(r.market,r.symbol):null;
 const q=manual||cached;
 if(!q) return r;
 const price=Number(q.price), prev=Number(q.prev_close), pivot=Number(r.pivot);
 const change=(Number.isFinite(price)&&Number.isFinite(prev)&&prev!==0)?((price/prev)-1)*100:Number(r.change_pct);
 const distance=(Number.isFinite(price)&&Number.isFinite(pivot)&&pivot!==0)?((price/pivot)-1)*100:Number(r.distance);
 return {...r, live_price:price, change_pct:change, distance:distance, _live:true,
   _quote_time:String(q.quote_time||q.fetched_at||serverLiveQuotesMeta.latest_quote_time||''),
   _quote_source:String(q.source||'TW live cache')};
}
async function fetchUserLiveQuote(r){
 const market=String(r.market||'').toUpperCase(), symbol=String(r.symbol||'').toUpperCase();
 const dataset=market==='US'?'USStockPrice':'TaiwanStockPrice';
 const end=new Date(), start=new Date(); start.setDate(end.getDate()-12);
 const f=d=>d.toISOString().slice(0,10);
 const url=`${API}?dataset=${dataset}&data_id=${encodeURIComponent(symbol)}&start_date=${f(start)}&end_date=${f(end)}`;
 const j=await fmFetchJson(url,{ttl:120000,persist:false,retries:0});
  if(!Array.isArray(j.data) || !j.data.length) throw new Error(symbol);
 const d=normalizeData(j.data,market);
 if(!d.length) throw new Error(symbol);
 const last=d[d.length-1], prev=d.length>=2?d[d.length-2]:null;
 return {
   price:Number(last.close),
   prev_close:prev?Number(prev.close):NaN,
   data_date:last.date||'',
   fetched_at:new Date().toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'})
 };
}
async function refreshUserLiveQuotes(){
 const btn=document.getElementById('userLiveRefreshBtn');
 if(String(currentMarket||'TW').toUpperCase()==='TW'){
   const status=document.getElementById('userLiveRefreshStatus');
   if(btn){ btn.disabled=true; btn.textContent='讀取中…'; }
   if(status) status.textContent='正在重新讀取最近一筆台股行情快取…';
   const count=await loadServerLiveQuotesTW(true);
   renderRadar(radarFilter);
   if(btn){ btn.disabled=false; btn.textContent='🔄 重新讀取行情'; }
   return count;
 }
 const status=document.getElementById('userLiveRefreshStatus');
 const targets=radarRows.filter(r=>String(r.market||'').toUpperCase()===String(currentMarket||'TW').toUpperCase());
 if(!targets.length){
   if(status) status.textContent='目前這個市場沒有雷達股票可更新。';
   return;
 }
 if(btn){ btn.disabled=true; btn.textContent='更新中…'; }
 if(status) status.textContent=`正在更新 ${targets.length} 檔即時行情…`;
 let ok=0, fail=0;
 const chunkSize=6;
 for(let i=0;i<targets.length;i+=chunkSize){
   const chunk=targets.slice(i,i+chunkSize);
   const results=await Promise.allSettled(chunk.map(fetchUserLiveQuote));
   results.forEach((x,idx)=>{
     const r=chunk[idx];
     if(x.status==='fulfilled' && Number.isFinite(Number(x.value.price))){
       userLiveQuotes.set(liveQuoteKey(r.market,r.symbol),x.value); ok++;
     }else fail++;
   });
   if(status) status.textContent=`即時行情更新中… ${Math.min(i+chunk.length,targets.length)}/${targets.length}`;
 }
 userLiveUpdatedAt=new Date().toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'});
 renderRadar(radarFilter);
 if(status) status.textContent=`已更新 ${ok} 檔${fail?`，${fail} 檔暫時抓不到`:''}｜${userLiveUpdatedAt}（個股行情即時更新；大盤隨每次雷達完整重掃更新）`;
 if(btn){ btn.disabled=false; btn.textContent='🔄 更新即時行情'; }
}

/* 大盤環境提示：大盤（台股加權／S&P 500）在 50 日線上或下。回測顯示在線下時突破訊號平均報酬明顯較差。 */
function updateRegimeBanner(){
  const box=document.getElementById('regimeBanner'); if(!box) return;
  const r=radarMarketRegime&&radarMarketRegime[currentMarket];
  if(!r||typeof r.above!=='boolean'||!Number.isFinite(Number(r.dist_pct))){ box.hidden=true; return; }
  const d=Number(r.dist_pct), sign=d>0?'+':'', up=r.above;
  box.hidden=false; box.className='regime-banner '+(up?'is-up':'is-down');
  box.innerHTML=(up
    ? `<b>🟢 大盤環境：${escHtml(r.index)}站在 ${r.ma_days} 日線之上（${sign}${d.toFixed(1)}%）</b><span>多頭環境，突破訊號相對較有參考性。</span>`
    : `<b>🟠 大盤環境：${escHtml(r.index)}跌破 ${r.ma_days} 日線（${sign}${d.toFixed(1)}%）</b><span>回測顯示此時突破訊號的平均表現明顯較差，請保守看待，並自行評估風險。</span>`)
    +`<em>資料日 ${escHtml(r.as_of||'')}</em>`;
}
function renderRadar(filter='all'){
  try{ updateRegimeBanner(); }catch(e){}
 updateFavoriteCount();
 try{updateKpiStrip(filter);}catch(e){}
 const body=$('radarBody'), mobile=$('radarMobile');
 // 若收藏是從舊版或單股分析留下、當下只有代號，背景補齊名稱後重畫一次。
 if(radarKeys(filter).includes('favorites')){
   hydrateFavoriteNames(currentMarket).then(changed=>{
     if(changed && radarKeys(radarFilter).includes('favorites')) renderRadar(radarFilter);
   });
 }
 let sourceRows=Array.isArray(radarRows)?radarRows.slice():[];
 // V2.42.2 — 收藏是使用者自己的清單，不應受 VCP 雷達入選名單限制。
 // 單股分析收藏的非 VCP 標的，也要能在「我的收藏」重新找到。
 if(radarKeys(filter).includes('favorites')){
   const favs=getFavorites(), meta=getFavoriteMeta();
   const seen=new Set(sourceRows.map(r=>favoriteKey(r.market,r.symbol)));
   for(const key of favs){
     if(seen.has(key)) continue;
     sourceRows.push(favoriteFallbackRow(key,meta[key]||{}));
     seen.add(key);
   }
 }
 const rows=sourceRows.filter(r=>{
   if(String(r.market||'').toUpperCase()!==String(currentMarket||'TW').toUpperCase()) return false;
   return radarRowPass(r,filter);
  });
 for(let i=0;i<rows.length;i++) rows[i]=effectiveRadarRow(rows[i]);
  if(radarNumActive()){ for(let i=rows.length-1;i>=0;i--) if(!radarNumPass(rows[i])) rows.splice(i,1); }
 const countEl=$('radarCount'); if(countEl) countEl.textContent=rows.length;
 const pulseRank={hot:0,watch:1,wait:2,extended:3};
 const statusRank={breakout:0,postbreakout:1,near:2,forming:3};
 const squeezeRank={strong:0,medium:1,weak:2,none:3};
 const momentumRank={bull_up:0,bear_up:1,bull_down:2,bear_down:3};
 const smartSort=(a,b)=>
   ((pulseRank[a.pulse_signal]??9)-(pulseRank[b.pulse_signal]??9)) ||
   ((statusRank[a.type]??9)-(statusRank[b.type]??9)) ||
   ((b.score??0)-(a.score??0)) ||
   ((squeezeRank[a.squeeze_level]??9)-(squeezeRank[b.squeeze_level]??9)) ||
   ((momentumRank[a.momentum_dir]??9)-(momentumRank[b.momentum_dir]??9)) ||
   (Math.abs(a.distance??999)-Math.abs(b.distance??999));

 rows.sort((a,b)=>{
   if(radarSort==='custom') return radarCustomCompare(a,b,smartSort);
    if(radarSort==='score') return ((b.score??0)-(a.score??0)) || smartSort(a,b);
   if(radarSort==='pivot') return (Math.abs(a.distance??999)-Math.abs(b.distance??999)) || smartSort(a,b);
   if(radarSort==='rs') return ((b.rs_rating??-1)-(a.rs_rating??-1)) || smartSort(a,b);
   if(radarSort==='tt'){ const ttSort=r=>ttFull(r)?0:1; return (ttSort(a)-ttSort(b)) || ((Number(b.tt_count)??0)-(Number(a.tt_count)??0)) || smartSort(a,b); }
   if(radarSort==='squeeze'){ const fr=r=>sqzFireBull(r)?-1:(squeezeRank[r.squeeze_level]??9); return (fr(a)-fr(b)) || smartSort(a,b); }
   if(radarSort==='momentum') return ((momentumRank[a.momentum_dir]??9)-(momentumRank[b.momentum_dir]??9)) || smartSort(a,b);
   if(radarSort==='change'){
     const av=Number(a.change_pct), bv=Number(b.change_pct);
     const af=Number.isFinite(av), bf=Number.isFinite(bv);
     if(af!==bf) return af?-1:1;
     if(af && bf && av!==bv) return radarChangeSortDir==='asc' ? av-bv : bv-av;
     return smartSort(a,b);
   }
   return smartSort(a,b);
 });

 if(!rows.length){
   body.innerHTML='<tr><td colspan="11" class="muted" style="padding:30px;text-align:center">目前這個分類沒有符合條件的股票。</td></tr>';
   if(mobile) mobile.innerHTML='<div class="muted" style="padding:26px 8px;text-align:center">目前這個分類沒有符合條件的股票。</div>';
   const pager=document.getElementById('mobileRadarPager');
   if(pager) pager.hidden=true;
   return;
 }

 const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
 const stars=n=>Number.isFinite(Number(n))?('★'.repeat(Math.max(0,Math.min(5,Number(n))))+'☆'.repeat(Math.max(0,5-Math.min(5,Number(n))))):'—';
 const fmtNum=(v,d=2)=>Number.isFinite(Number(v))?Number(v).toFixed(d):'—';
 const fmtPctRaw=v=>Number.isFinite(Number(v))?`${Number(v).toFixed(1)}%`:'—';
 const contractionText=r=>(r.contractions||[]).map((x,i)=>`C${i+1} ${Math.round(x)}%`).join(' → ')||'—';

 body.innerHTML=rows.map(r=>`<tr data-market="${esc(r.market)}" data-symbol="${esc(r.symbol)}">
   <td>
     <div class="stock-name-line">
       <button type="button" class="favorite-btn ${isFavorite(r)?'is-favorite':''}" data-favorite="1" data-market="${esc(r.market)}" data-symbol="${esc(r.symbol)}" aria-label="${isFavorite(r)?'取消收藏':'收藏股票'}" title="${isFavorite(r)?'取消收藏':'收藏股票'}">${isFavorite(r)?'★':'☆'}</button>
       <div><button type="button" class="stock-link radar-open-analysis" data-market="${esc(r.market)}" data-symbol="${esc(r.symbol)}">${esc(r.name||r.symbol)}${r.is_new?'<span class="new-entry-badge">NEW</span>':''}</button>
       <div class="muted">${esc(r.symbol)}</div></div>
     </div>
   </td>
   <td>${esc(marketLabel(r.market))}</td>
   <td><div>${stars(r.score)}</div>${rsTtLine(r)}${r.structure_quality_good?'<div class="structure-quality-badge structure-quality-compact">💎 結構品質佳</div>':''}</td>
   
   <td>${fmtNum(r.pivot,2)}</td>
   <td>
     <div class="desktop-pivot-distance">
       <b>${fmtPctRaw(r.distance)}</b>
       ${(()=>{
         const pv=pivotDistanceVisual(r.distance);
         return `<div class="pivot-distance-track desktop-pivot-track" data-zone="${pv.zone}" aria-hidden="true">
           <span class="pivot-distance-fill ${pv.cls}" style="width:${pv.width}%"></span>
         </div>`;
       })()}
     </div>
   </td>
   <td><span class="change-pct ${changePctClass(r.change_pct)}">${changePctText(r.change_pct)}</span>${r._live?`<span class="live-quote-badge">${escHtml(liveQuoteBadgeText(r))}</span>`:''}</td>
   <td>${esc(volumeLabel(r))}${liquidityDesktop(r)?`<div class="liquidity-desktop">${esc(liquidityDesktop(r))}</div>`:''}</td>
   <td>${esc(squeezeLabel(r))}${sqzWeeklyChip(r)}</td>
   <td>${esc(momentumLabel(r))}</td>
   <td class="status-dot">${stagePill(r)}${r.type==='postbreakout'?`<div class="muted postbreakout-mini">目前 ${esc(signedPct(r.breakout_return_pct ?? r.distance))} · 最高漲幅 ${esc(signedPct(r.breakout_high_pct ?? r.breakout_return_pct ?? r.distance))}</div>`:''}</td>
   <td><button type="button" class="pulse-badge pulse-${esc(r.pulse_signal||'wait')} pulse-help-trigger" data-pulse="${esc(r.pulse_signal||'wait')}">${esc(pulseLabel(r))}</button>${r.pulse_signal==='hot'?`<div class="attention-summary desktop-attention">${esc(attentionReason(r))}</div>`:''}</td>
 </tr>`).join('');

 const openAnalysis=async (market,symbol,sourceEl)=>{
   // Remember the exact row/card that was tapped.
   rememberRadarPosition(market,symbol,sourceEl);

   // Only switch market when it actually changes: setMarket() re-renders the freshness bar,
   // market overview, hotspots and theme boards, which blocked the main thread on every tap.
   if(String(currentMarket||'').toUpperCase()!==String(market||'').toUpperCase()){
     setMarket(market,{reset:false});
   }
   $('symbol').value=symbol;

   const input=$('symbol');
   const singleSection=input?.closest('.section') || input;
   const isDesktop=window.matchMedia('(min-width:761px)').matches;

   // Scroll to the chart card (keeping the stock title visible below the sticky login bar).
   // minDelta lets the post-analysis pass skip the scroll when we are already in place.
   const landOnChart=(minDelta)=>{
     const chart=$('chart');
     const chartCard=chart?.closest('.card') || chart;
     const el=(chartCard && chartCard.getBoundingClientRect().height>40) ? chartCard : singleSection;
     if(!el) return;
     const stickyBar=document.getElementById('userBar');
     const stickyH=window.__stickyOffset?window.__stickyOffset():((stickyBar && getComputedStyle(stickyBar).display!=='none')?stickyBar.getBoundingClientRect().height:0);
     const cur=window.pageYOffset||document.documentElement.scrollTop||0;
     const y=Math.max(0,cur+el.getBoundingClientRect().top-stickyH-12);
     if(Math.abs(y-cur)<minDelta) return;
     try{ window.scrollTo({top:y,behavior:'smooth'}); }
     catch(e){ window.scrollTo(0,y); }
   };

   // Desktop: land on the section right away. Mobile: start scrolling right away too
   // (it used to wait for the whole analysis request first, which felt like a pause).
   if(isDesktop && singleSection){
     singleSection.scrollIntoView({behavior:'smooth',block:'start'});
   }else if(!isDesktop){
     landOnChart(0);
   }

   await run();

   // Mobile: once the card has its final size, fine-tune only if we are noticeably off.
   if(!isDesktop){
     requestAnimationFrame(()=>landOnChart(24));
   }
 };

 body.querySelectorAll('.favorite-btn').forEach(btn=>{
   btn.addEventListener('click',(e)=>{
     e.preventDefault(); e.stopPropagation();
     toggleFavorite(btn.dataset.market,btn.dataset.symbol);
   });
 });

 body.querySelectorAll('.radar-open-analysis').forEach(btn=>{
   btn.addEventListener('click',(e)=>{
     e.preventDefault();
     e.stopPropagation();
     openAnalysis(btn.dataset.market,btn.dataset.symbol,btn.closest('tr[data-symbol]')||btn);
   });
 });

 // V2.41.30：桌機不再讓整列都可點。
 // 只有有底線的股票名稱（.radar-open-analysis）才會帶入單股分析。

 if(mobile){
   const totalMobileRows=rows.length;
   const totalMobilePages=Math.max(1,Math.ceil(totalMobileRows/MOBILE_RADAR_PAGE_SIZE));
   if(mobileRadarPage>totalMobilePages) mobileRadarPage=totalMobilePages;
   if(mobileRadarPage<1) mobileRadarPage=1;
   const mobileStart=(mobileRadarPage-1)*MOBILE_RADAR_PAGE_SIZE;
   const mobileEnd=Math.min(mobileStart+MOBILE_RADAR_PAGE_SIZE,totalMobileRows);
   const mobileRows=rows.slice(mobileStart,mobileEnd);

   const pager=document.getElementById('mobileRadarPager');
   const pageInfo=document.getElementById('mobilePageInfo');
   const prevBtn=document.getElementById('mobilePrevPage');
   const nextBtn=document.getElementById('mobileNextPage');

   if(pager){
     pager.hidden=totalMobileRows<=MOBILE_RADAR_PAGE_SIZE;
     if(pageInfo){
       pageInfo.innerHTML=totalMobileRows
         ? `共 ${totalMobileRows} 檔<br>第 ${mobileStart+1}–${mobileEnd} 檔`
         : '目前無資料';
     }
     if(prevBtn) prevBtn.disabled=mobileRadarPage<=1;
     if(nextBtn) nextBtn.disabled=mobileRadarPage>=totalMobilePages;
   }

   mobile.innerHTML=mobileRows.map(r=>{
     const reasons=[];
     if(r._favorite_only){
       reasons.push(`<div class="reason-item reason-note">⭐ 由單股分析加入收藏；目前不在 VCP 雷達入選名單</div>`);
       reasons.push(`<div class="reason-item reason-note">點「看 VCP 圖」可重新取得最新單股分析</div>`);
     }else{
       if(r.is_new) reasons.push(`<div class="reason-item reason-new">🆕 ${esc(r.new_reason||'今日新進 VCP 雷達')}</div>`);
       reasons.push(`<div class="reason-item reason-ok"><b>VCP ${r.score}/5</b>，符合本站主要候選門檻</div>`);
     }
     if((r.contractions||[]).length>=2) reasons.push(`<div class="reason-item reason-ok">收縮：${esc(contractionText(r))}</div>`);
if((r.contractions||[]).length>=2 && (r.contraction_bars||[]).length>=2 && typeof r.time_shrinking==='boolean'){
  const bars=(r.contraction_bars||[]).join(' → ');
  reasons.push(`<div class="reason-item ${r.time_shrinking?'reason-ok':'reason-note'}">波浪時間 ${esc(bars)} 日，${r.time_shrinking?'逐步縮短':'沒有逐步縮短'}</div>`);
  const lastC=fmtDepth((r.contractions||[]).slice(-1)[0]).replace('%','');
  reasons.push(`<div class="reason-item ${r.last_tight?'reason-ok':'reason-note'}">最後一次收縮 ${lastC}%，${r.last_tight?'夠緊（≤ 10% 且明顯小於第一次）':'還不夠緊'}</div>`);
}
     if(r.volume_dry) reasons.push(`<div class="reason-item reason-ok">整理期間成交量呈現量縮</div>`);
     if(r.structure_quality_good) reasons.push(`<div class="reason-item reason-ok">💎 VCP 結構品質佳，收斂與量縮條件整體較完整</div>`);
     if(r.squeeze_level && r.squeeze_level!=='none') reasons.push(`<div class="reason-item reason-ok">${esc(squeezeLabel(r))}，波動處於壓縮狀態${Number(r.squeeze_run_days)>0?`（已連續 ${Number(r.squeeze_run_days)} 日）`:''}</div>`);
     else if(!r.squeeze_fire) reasons.push(`<div class="reason-item reason-note">${esc(squeezeLabel(r))}</div>`);
     if(r.squeeze_fire) reasons.push(`<div class="reason-item ${r.squeeze_fire_dir==='bear'?'reason-note':'reason-ok'}">${esc(sqzDailyText(r))}：第一根「無壓縮」，動能${r.squeeze_fire_dir==='bear'?'偏空，不是進場訊號':'偏多'}</div>`);
     if(r.sqz_w_fire) reasons.push(`<div class="reason-item ${r.sqz_w_fire_dir==='bear'?'reason-note':'reason-ok'}">${esc(sqzWeeklyText(r))}，動能${r.sqz_w_fire_dir==='bear'?'偏空':'偏多'}</div>`);
     if(r.momentum) reasons.push(`<div class="reason-item reason-note">Momentum：${esc(momentumLabel(r))}</div>`);
     if(Number.isFinite(Number(r.rs_rating))&&Number(r.rs_rating)>0){ const n=Number(r.rs_rating); reasons.push(`<div class="reason-item ${n>=70?'reason-ok':'reason-note'}">相對強度 <b>RS ${n}</b>，近 3～12 個月漲幅在同市場前 ${Math.max(1,100-n)}%</div>`); }
     if(r.tt_count!=null&&Number.isFinite(Number(r.tt_count))){ const n=Number(r.tt_count), miss=(Array.isArray(r.tt_fail)?r.tt_fail:[]).map(k=>TT_LABELS[k]).filter(Boolean); reasons.push(`<div class="reason-item ${n>=7?'reason-ok':'reason-note'}">趨勢模板 <b>${n}/7</b>${miss.length?`，未過：${esc(miss.join('、'))}`:'，價格面條件全過'}${n>=7&&Number(r.rs_rating)>=70?'（含 RS ≥ 70，完整符合）':''}</div>`); }
     if(r.type==='breakout') reasons.push(`<div class="reason-item reason-ok">最新交易日首次帶量突破 Pivot</div>`);
     else if(r.type==='postbreakout'){
       reasons.push(`<div class="reason-item reason-ok">突破追蹤 D+${Number(r.breakout_days??0)}${r.breakout_date?` · ${esc(r.breakout_date)} 突破`:``}</div>`);
       reasons.push(`<div class="reason-item reason-ok">目前相對 Pivot ${signedPct(r.breakout_return_pct ?? r.distance)} · 突破後最高 ${signedPct(r.breakout_high_pct)}</div>`);
       reasons.push(`<div class="reason-item reason-ok">${r.holding_pivot?'仍守住 Pivot ✓':'需留意跌回 Pivot'}</div>`);
     }
     else if(!r._favorite_only && r.type==='near') reasons.push(`<div class="reason-item reason-ok">距 Pivot ${fmtPctRaw(r.distance)}，已進入接近區</div>`);
     else if(!r._favorite_only) reasons.push(`<div class="reason-item reason-note">型態仍在成形，距 Pivot ${fmtPctRaw(r.distance)}</div>`);

     return `<div class="mobile-stock-card${ttChip(r)?' has-tt':''}" data-market="${esc(r.market)}" data-symbol="${esc(r.symbol)}">
       <div class="mobile-stock-top">
         <div>
           <div class="mobile-stock-name"><button type="button" class="mobile-stock-name-btn" data-market="${esc(r.market)}" data-symbol="${esc(r.symbol)}" aria-label="查看 ${esc(r.name||r.symbol)} VCP 圖">${esc(r.name||r.symbol)}${r.is_new?'<span class="new-entry-badge">NEW</span>':''}</button>${Number(r.score)>=1?`<span class="star-badge" data-score="${Math.min(5,Math.round(Number(r.score)))}" title="VCP ${Math.min(5,Math.round(Number(r.score)))}/5" aria-label="VCP ${Math.min(5,Math.round(Number(r.score)))} 顆星">★${Math.min(5,Math.round(Number(r.score)))}</span>`:''}${sqzFireMini(r)}</div>
           <div class="mobile-stock-code">${esc(r.symbol)}<span class="mobile-code-market"> · ${r.market==='TW'?'台股':'美股'}</span>${(rsChip(r)||ttChip(r))?' <span class="chip-group">'+rsChip(r)+ttChip(r)+'</span>':''}</div>
         </div>
         <div class="mobile-top-actions">
           <div class="mobile-action-head">
             <button type="button" class="favorite-btn mobile-favorite ${isFavorite(r)?'is-favorite':''}" data-favorite="1" data-market="${esc(r.market)}" data-symbol="${esc(r.symbol)}" aria-label="${isFavorite(r)?'取消收藏':'收藏股票'}">${isFavorite(r)?'★ 已收藏':'☆ 收藏'}</button>
             <div class="mobile-score">${stars(r.score)}</div>
           </div>
           <button type="button" class="mobile-cta mobile-analysis-btn" data-market="${esc(r.market)}" data-symbol="${esc(r.symbol)}">📈 看 VCP 圖 →</button>
         </div>
       </div>
       <div class="mobile-state">${stagePill(r)}</div>
       ${r.structure_quality_good?'<div class="structure-quality-badge mobile-structure-quality">💎 結構品質佳</div>':''}
       ${r.type==='postbreakout'?`<div class="mobile-postbreakout-performance" aria-label="突破後績效">
         <span>突破後 ${esc(signedPct(r.breakout_return_pct ?? r.distance))}</span>
         <span class="high">最高漲幅 ${esc(signedPct(r.breakout_high_pct ?? r.breakout_return_pct ?? r.distance))}</span>
       </div>`:''}
       <div class="mobile-pulse-row">
         <button type="button"
           class="pulse-badge pulse-${esc(r.pulse_signal||'wait')} pulse-help-trigger"
           data-pulse="${esc(r.pulse_signal||'wait')}">${esc(pulseLabel(r))}</button>
         ${sqzLampCompact(r)}
       </div>
       
       ${r.pulse_signal==='hot'?`<div class="attention-summary">${esc(attentionReason(r))}</div>`:''}
       <div class="mobile-metrics">
         <div class="mobile-metric">Pivot（突破價）<b>${fmtNum(r.pivot,2)}</b></div>
         <div class="mobile-metric">距 Pivot<b>${fmtPctRaw(r.distance)}</b>
          ${(()=>{
            const pv=pivotDistanceVisual(r.distance);
            return `<div class="pivot-distance-track" data-zone="${pv.zone}" aria-hidden="true">
              <span class="pivot-distance-fill ${pv.cls}" style="width:${pv.width}%"></span>
            </div>`;
          })()}
         </div>
         <div class="mobile-metric">今日漲跌<b class="change-pct ${changePctClass(r.change_pct)}">${changePctText(r.change_pct)}${r._live?` <span class="live-quote-badge">${escHtml(liveQuoteBadgeText(r))}</span>`:''}</b></div>
         <div class="mobile-metric">量能<b>${esc(volumeLabel(r))}</b></div>
       </div>
       <div class="mobile-signal-row">
         <span class="mobile-signal${r.squeeze_fire?' mobile-signal-fire':''}">${esc(squeezeLabel(r))}</span>
          ${r.sqz_w_fire?`<span class="mobile-signal mobile-signal-fire">${esc('📅 週線爆發'+(r.sqz_w_fire_dir==='bear'?'（偏空）':''))}</span>`:''}
         <span class="mobile-signal">${esc(momentumLabel(r))}</span>
         ${liquidityCompact(r)?`<span class="mobile-signal">${esc(liquidityCompact(r))}</span>`:''}
         ${r.combo?'<span class="mobile-signal">⚡ VCP＋Squeeze</span>':''}
       </div>
       <div class="mobile-why">
         <div class="mobile-why-head">
           <div class="mobile-why-title">為什麼入選？</div>
           ${reasons.length>2?`<button type="button" class="reason-toggle" aria-expanded="false">展開理由 ＋</button>`:''}
         </div>
         <div class="reason-list reason-preview">${reasons.slice(0,2).join('')}</div>
         ${reasons.length>2?`<div class="reason-list reason-more" hidden>${reasons.slice(2).join('')}</div>`:''}
         <div class="pulse-explain reason-more-detail" ${reasons.length>2?'hidden':''}><b>VCPulse 訊號：</b>${esc(pulseLabel(r))} · ${esc((r.pulse_reasons||[]).join('、')||'依目前結構持續觀察')}</div>
       </div>
     </div>`;
   }).join('');

   mobile.querySelectorAll('.favorite-btn').forEach(btn=>{
     btn.addEventListener('click',(e)=>{
       e.preventDefault(); e.stopPropagation();
       toggleFavorite(btn.dataset.market,btn.dataset.symbol);
     });
   });

   mobile.querySelectorAll('.reason-toggle').forEach(btn=>{
     btn.addEventListener('click',(e)=>{
       e.preventDefault();
       e.stopPropagation();
       const why=btn.closest('.mobile-why');
       const more=why?.querySelector('.reason-more');
       const detail=why?.querySelector('.reason-more-detail');
       const expanded=btn.getAttribute('aria-expanded')==='true';
       btn.setAttribute('aria-expanded',String(!expanded));
       if(more) more.hidden=expanded;
       if(detail) detail.hidden=expanded;
       btn.textContent=expanded?'展開理由 ＋':'收合理由 －';
     });
   });

   mobile.querySelectorAll('.mobile-stock-name-btn').forEach(btn=>{
     btn.addEventListener('click',(e)=>{
       e.preventDefault();
       e.stopPropagation();
       openAnalysis(btn.dataset.market,btn.dataset.symbol,btn.closest('.mobile-stock-card')||btn);
     });
   });

   mobile.querySelectorAll('.mobile-analysis-btn').forEach(btn=>{
     btn.addEventListener('click',(e)=>{
       e.preventDefault();
       e.stopPropagation();
       openAnalysis(btn.dataset.market,btn.dataset.symbol,btn.closest('.mobile-stock-card')||btn);
     });
   });

   // V2.41.30：手機卡片本身不再整張可點，
   // 「看 VCP 圖」按鈕與股票名稱都可進入單股分析；卡片本身仍不可點，避免誤觸。
 }
}

updateFavoriteCount();

function escHtml(s){
  return String(s??'').replace(/[&<>"']/g,m=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[m]));
}


function formatMarketDate(v){
 const s=String(v??'').trim();
 if(/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
 return s;
}

function marketNumber(v,digits=2){
 const n=Number(v);
 return Number.isFinite(n)?n.toLocaleString('zh-TW',{minimumFractionDigits:digits,maximumFractionDigits:digits}):'—';
}

const LIVE_INDEX_SYMBOLS={
  TW:{
    TWSE:{symbol:'^TWII',label:'上市｜加權指數'},
  },
  US:{
    SOX:{symbol:'^SOX',label:'費城半導體'},
    SP500:{symbol:'^GSPC',label:'S&P 500'},
    NASDAQ:{symbol:'^IXIC',label:'NASDAQ'},
    RUSSELL2000:{symbol:'^RUT',label:'Russell 2000'}
  }
};

async function fetchYahooIndexQuote(symbol,label){
  try{
    const u=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`;
    const r=await fetch(u,{cache:'no-store'});
    if(!r.ok) return null;
    const j=await r.json();
    const result=j?.chart?.result?.[0];
    const meta=result?.meta||{};
    const closes=result?.indicators?.quote?.[0]?.close||[];
    const valid=closes.map(Number).filter(Number.isFinite);
    const close=Number.isFinite(Number(meta.regularMarketPrice))?Number(meta.regularMarketPrice):(valid.length?valid[valid.length-1]:NaN);
    const prev=Number(meta.chartPreviousClose ?? meta.previousClose);
    if(!Number.isFinite(close)) return null;
    const changePct=Number.isFinite(prev)&&prev!==0?((close/prev)-1)*100:NaN;
    return {
      label,
      close,
      change_points:Number.isFinite(prev)?close-prev:NaN,
      change_pct:changePct,
      data_time:new Date().toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'}),
      live:true
    };
  }catch(e){ return null; }
}


function parseNumLoose(v){
  const n=Number(String(v??'').replace(/,/g,'').replace(/%/g,'').trim());
  return Number.isFinite(n)?n:NaN;
}
function pickField(obj,names){
  for(const n of names){
    if(obj && Object.prototype.hasOwnProperty.call(obj,n) && obj[n]!=='' && obj[n]!=null) return obj[n];
  }
  return null;
}
async function fetchTpexIndexLatest(){
  try{
    const urls=[
      'https://www.tpex.org.tw/openapi/v1/tpex_daily_trading_index',
      'https://www.tpex.org.tw/openapi/v1/tpex_index'
    ];
    for(const u of urls){
      try{
        const ctl=new AbortController();
        const timer=setTimeout(()=>ctl.abort(),7000);
        let r;
        try{
          r=await fetch(u,{cache:'no-store',signal:ctl.signal});
        }finally{ clearTimeout(timer); }
        if(!r?.ok) continue;
        const j=await r.json().catch(()=>null);
        if(!Array.isArray(j) || !j.length) continue;

        // Latest row: official TPEx OpenAPI commonly returns newest-first, but sort by date when possible.
        const rows=j.slice();
        const dateOf=x=>String(pickField(x,['Date','date','日期','資料日期','TradeDate'])||'');
        rows.sort((a,b)=>dateOf(a).localeCompare(dateOf(b)));
        const x=rows[rows.length-1]||{};

        const close=parseNumLoose(pickField(x,[
          'Close','close','Index','index','IndexValue','indexValue',
          '收市指數','收盤指數','指數','TPExIndex'
        ]));
        const changePoints=parseNumLoose(pickField(x,[
          'Change','change','ChangePoint','change_points','漲跌','漲跌點數'
        ]));
        let changePct=parseNumLoose(pickField(x,[
          'ChangePercent','changePercent','ChangeRate','change_pct','漲跌幅度(%)','漲跌幅(%)','漲跌幅'
        ]));

        // If the API does not expose percentage directly, derive it from point change.
        if(!Number.isFinite(changePct) && Number.isFinite(close) && Number.isFinite(changePoints)){
          const prev=close-changePoints;
          if(prev!==0) changePct=(changePoints/prev)*100;
        }
        if(!Number.isFinite(close)) continue;

        return {
          label:'上櫃｜櫃買指數',
          close,
          change_points:Number.isFinite(changePoints)?changePoints:NaN,
          change_pct:Number.isFinite(changePct)?changePct:NaN,
          data_time:dateOf(x)||new Date().toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'}),
          live:true,
          source:'TPEx OpenAPI'
        };
      }catch(e){
        console.warn('TPEx index endpoint failed',u,e);
      }
    }
  }catch(e){
    console.warn('TPEx index refresh failed',e);
  }
  return null;
}

async function refreshLiveMarketOverview(){
  const market=String(currentMarket||'TW').toUpperCase();
  const bucket=(radarBenchmarkData[radarSnapshot] ||= {});
  bucket[market] ||= {};

  if(market==='TW'){
    // TWSE: Yahoo chart remains a useful best-effort source.
    // TPEx: Yahoo's ^TWOII is not reliable here, so use TPEx official OpenAPI instead.
    const [twseRes,tpexRes]=await Promise.allSettled([
      fetchYahooIndexQuote('^TWII','上市｜加權指數'),
      fetchTpexIndexLatest()
    ]);
    let ok=0;
    if(twseRes.status==='fulfilled' && twseRes.value){
      bucket.TW.TWSE=twseRes.value; ok++;
    }
    if(tpexRes.status==='fulfilled' && tpexRes.value){
      bucket.TW.TPEX=tpexRes.value; ok++;
    }
    renderMarketOverview();
    return {ok,total:2};
  }

  const specs=LIVE_INDEX_SYMBOLS[market]||{};
  const entries=Object.entries(specs);
  if(!entries.length) return {ok:0,total:0};
  const results=await Promise.allSettled(
    entries.map(async ([key,x])=>[key,await fetchYahooIndexQuote(x.symbol,x.label)])
  );
  let ok=0;
  results.forEach(res=>{
    if(res.status!=='fulfilled') return;
    const [key,val]=res.value;
    if(val){ bucket[market][key]=val; ok++; }
  });
  renderMarketOverview();
  return {ok,total:entries.length};
}
function renderMarketOverview(){
 const box=document.getElementById('marketOverview');
 if(!box) return;
 const all=(radarBenchmarkData[radarSnapshot]||{});
 const isUS=currentMarket==='US';
 const data=isUS?(all.US||{}):(all.TW||{});
 const specs=isUS?[
   ['SOX','費城半導體'],
   ['SP500','S&P 500'],
   ['NASDAQ','NASDAQ'],
   ['RUSSELL2000','Russell 2000']
 ]:[
   ['TWSE','上市｜加權指數'],
   ['TPEX','上櫃｜櫃買指數']
 ];
 const cards=specs.map(([key,fallback])=>{
   const x=data[key];
   if(!x) return '';
   const p=Number(x.change_pct), pts=Number(x.change_points);
   const cls=!Number.isFinite(p)||p===0?'flat':(p>0?'up':'down');
   const sign=Number.isFinite(pts)&&pts>0?'+':'';
   const psign=Number.isFinite(p)&&p>0?'+':'';
   return `<div class="market-index-card">
     <div>
       <div class="market-index-name">${escHtml(x.label||fallback)}</div>
       <div class="market-index-value">${marketNumber(x.close)}</div>
       ${x.data_time?`<div class="market-index-time">${escHtml(formatMarketDate(x.data_time))}${x.source?` · 資料更新`:''}</div>`:''}
     </div>
     <div class="market-index-change ${cls}">
       ${Number.isFinite(pts)?`${sign}${marketNumber(pts)} 點`:'—'}<br>
       ${Number.isFinite(p)?`${psign}${p.toFixed(2)}%`:'—'}
     </div>
   </div>`;
 }).filter(Boolean);
 box.innerHTML=cards.join('');
 box.classList.toggle('us-market',isUS);
 box.hidden=!cards.length;
}

function renderFreshness(){
 const box=document.getElementById('radarFreshness');
 if(!box) return;
 const meta=radarSnapshotMeta[radarSnapshot]||{};
 const pieces=[];

 const dateWithWeekday=(s)=>{
   const str=String(s||'').trim();
   const m=str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
   if(!m) return str;
   const d=new Date(Number(m[1]),Number(m[2])-1,Number(m[3]));
   const w=['日','一','二','三','四','五','六'][d.getDay()];
   return `${str} (${w})`;
 };
 const scanTime=(s)=>{
   const str=String(s||'').trim();
   const m=str.match(/^\d{4}-\d{2}-\d{2}\s+(\d{1,2}):(\d{2})/);
   return m ? `${m[1].padStart(2,'0')}:${m[2]}` : str;
 };

 ['TW','US'].forEach(market=>{
   const m=meta[market];
   if(!m?.data_date) return;
   const intraday=radarSnapshot==='intraday' || m.snapshot_type==='intraday';

   let title='', sub='';
   if(intraday){
     title=market==='TW'?'台股・盤中即時':'美股・盤中即時';
     sub=market==='US'?'盤中每 1 小時自動更新':'盤中每 30 分鐘自動更新';
   }else if(market==='TW'){
     title='台股・收盤更新';
     sub='每日 18:10 起更新';
   }else{
     title='美股・前一交易日收盤';
     sub='07:10 起更新（台灣時間）';
   }

   pieces.push(`<div class="freshness-item ${intraday?'intraday':''}">
     <div class="freshness-status">
       <span class="freshness-dot"></span>
       <div>
         <div class="freshness-title">${escHtml(title)}</div>
         <div class="freshness-sub">${escHtml(sub)}</div>
       </div>
     </div>
     <div class="freshness-date">
       <span class="freshness-icon">▣</span>
       <div><b>${escHtml(dateWithWeekday(m.data_date))}</b><small>資料日期</small></div>
     </div>
     <div class="freshness-scan">
       <span class="freshness-icon">◷</span>
       <div><b>${m.scanned_at?escHtml(scanTime(m.scanned_at)):'—'}</b><small>掃描時間</small></div>
     </div>
   </div>`);
 });
 box.innerHTML=pieces.join('');
 box.hidden=!pieces.length;
 const status=document.getElementById('snapshotStatus');
 if(status){
   const m=String(currentMarket||'TW').toUpperCase();
   const info=radarSnapshotMeta?.[radarSnapshot]?.[m]||{};
   const scanned=String(info.scanned_at||'').trim();
   const date=String(info.data_date||'').trim();
   const today=taiwanMarketClock().date;
   const label=radarSnapshot==='intraday'?'盤中即時':'正式收盤';
   status.textContent=`目前顯示：${m==='TW'?'台股':'美股'} ${label}｜資料日期 ${date||'尚未更新'}｜掃描時間 ${scanned||'尚未更新'}${m==='TW' && radarSnapshot==='intraday' && isIntradayLockedAfterOfficial('TW')?'｜今日已收盤，此為盤中快照':''}${m==='TW' && date && date!==today?'｜這不是今天的資料':''}。`;
 }
}

function forceRadarAllRender(){
 radarFilter='all'; syncRadarTabs();
 // Render now, then once more after the browser has finished the click/layout cycle.
 renderRadar('all');
 requestAnimationFrame(()=>renderRadar('all'));
 setTimeout(()=>renderRadar('all'),60);
}

function isIntradayLockedAfterOfficial(market=currentMarket){
 // Only TW is locked after today's official close has actually completed.
 if(String(market||'').toUpperCase()!=='TW') return false;

 const meta=radarSnapshotMeta?.official?.TW||{};
 const dataDate=String(meta.data_date||'');
 const scannedAt=String(meta.scanned_at||'');
 if(!dataDate || !scannedAt) return false;

 // Browser-local date is Asia/Taipei for the intended deployment/user context.
 const today=taiwanMarketClock().date;

 // Yesterday's official snapshot must never lock today's intraday tab.
 if(dataDate!==today) return false;

 const mm=scannedAt.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})/);
 if(!mm || mm[1]!==dataDate) return false;

 const mins=(+mm[2])*60+(+mm[3]);
 return mins>=18*60+10;
}
function taiwanMarketClock(){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
 return {date:`${parts.year}-${parts.month}-${parts.day}`,weekday:parts.weekday,minutes:Number(parts.hour)*60+Number(parts.minute)};
}
function shouldDefaultToTwIntraday(){
 const now=taiwanMarketClock();
 const info=radarSnapshotMeta?.intraday?.TW||{};
 return currentMarket==='TW' && ['Mon','Tue','Wed','Thu','Fri'].includes(now.weekday)
   && now.minutes>=9*60 && now.minutes<13*60+30
   && String(info.data_date||'')===now.date
   && String(info.scanned_at||'').startsWith(now.date)
   && radarSnapshotData.intraday.some(x=>String(x.market||'').toUpperCase()==='TW')
   && !isIntradayLockedAfterOfficial('TW');
}
function updateSnapshotAvailability(){
 const intradayBtn=document.querySelector('.snapshot-btn[data-snapshot="intraday"]');
 if(!intradayBtn) return;
 const m=String(currentMarket||'TW').toUpperCase();
 const ic=(radarSnapshotData.intraday||[]).filter(x=>String(x.market||'').toUpperCase()===m).length;
 intradayBtn.disabled=!ic;
 intradayBtn.title=ic?'可查看最近一次盤中掃描資料；請留意上方的資料日期與掃描時間':'';
}
function setRadarSnapshot(kind){
 mobileRadarPage=1;
 const rows=Array.isArray(radarSnapshotData[kind]) ? radarSnapshotData[kind] : [];
 if(kind==='intraday' && rows.length===0) return;
 radarSnapshotManuallyChosen=true;

 radarSnapshot=kind;
 radarRows=rows.slice();
 userLiveQuotes.clear();
 userLiveUpdatedAt='';

 document.querySelectorAll('.snapshot-btn').forEach(
   b=>b.classList.toggle('active',b.dataset.snapshot===kind)
 );

 renderFreshness();
 renderMarketOverview();
 renderCapitalHotspots();
 renderThemeLeaderboards();
 forceRadarAllRender();
}


async function loadMarketStructure(){
 const body=document.getElementById('msBody'), updated=document.getElementById('msUpdated'); if(!body)return;
 const icon={EXPANSION:'🌱',MATURE_BULL:'🌿',DETERIORATION:'⚠️',CONTRACTION:'🍂',NEUTRAL_TRANSITION:'↔️',OVERHEATED:'🌡️',INSUFFICIENT_HISTORY:'⏳'};
 const fmtDelta=v=>(v===null||v===undefined||v==='')?'—':(Number.isFinite(Number(v))?`${Number(v)>0?'+':''}${Number(v).toFixed(1)}`:'—');
 try{
  const r=await fetch(`data/market_structure_latest.json?t=${Date.now()}`,{cache:'no-store'}); if(!r.ok)throw new Error('市場結構資料尚未建立'); const x=await r.json();
  if(x.status!=='ok'){
    body.innerHTML=`<div class="ms-state-wrap"><div class="ms-icon">⏳</div><div><div class="ms-state">資料累積中</div><div class="ms-code">至少需要前一個正式收盤 Breadth 才能判斷方向</div></div></div>`;
  }else{
    body.innerHTML=`<div class="ms-body"><div class="ms-state-wrap"><div class="ms-icon">${icon[x.state]||'🧭'}</div><div><div class="ms-state">${escHtml(x.label||'—')}</div><div class="ms-code">${escHtml(x.state||'—')}</div></div></div><div class="ms-metrics"><div class="ms-chip">市場廣度 <b>${Number(x.breadth_score).toFixed(1)}</b></div><div class="ms-chip">1日變化 <b>${fmtDelta(x.delta_1d)}</b></div><div class="ms-chip">5日變化 <b>${fmtDelta(x.delta_5d)}</b></div><div class="ms-chip">延伸比 <b>${(Number(x.extension_ratio)*100).toFixed(1)}%</b></div></div></div><div class="ms-note">研究規則已於 2026/09/17 凍結；顯示市場內部結構，不代表未來報酬。</div>`;
  }
  updated.textContent=x.data_date?`正式收盤｜${String(x.data_date).slice(5).replace('-','/')}`:'等待資料';
 }catch(e){body.innerHTML=`<div class="ms-wait">市場結構暫時無法讀取：${escHtml(e.message||String(e))}</div>`;updated.textContent='讀取失敗';}
}

async function loadMarketPulse(){
 const body=document.getElementById('mpBody'), updated=document.getElementById('mpUpdated'); if(!body)return;
 const fmt=(v,unit='%')=>{const n=Number(v);return Number.isFinite(n)?`${n>0?'+':''}${n.toFixed(2)}${unit}`:'—'};
 const cls=(v)=>Number(v)>0?'mp-up':(Number(v)<0?'mp-down':'mp-flat');
 try{
  const r=await fetch(`market_pulse.json?t=${Date.now()}`,{cache:'no-store'}); if(!r.ok)throw new Error('market_pulse.json 尚未建立'); const x=await r.json();
  if(x.status!=='ok'){body.innerHTML='<div class="mp-wait">Market Pulse 尚未產生，請先執行 Market Pulse Daily。</div>';updated.textContent='等待首次更新';return;}
  const s=x.signals||{}; const items=[['台指夜盤',s.tx_night,'%'],['費半',s.sox,'%'],['Nasdaq',s.nasdaq,'%'],['美債10Y',s.us10y,' bp'],['Brent',s.brent,'%'],['USD/TWD',s.usdtwd,'%']];
  body.innerHTML=`<div class="mp-scoreline"><div><div class="mp-score">${Number(x.score).toFixed(0)}<span style="font-size:16px;color:#72706f"> / 100</span></div><div class="mp-state">${x.emoji||''} ${escHtml(x.state||'—')}</div></div><div style="text-align:right"><div class="muted">訊號一致度</div><b>${escHtml(x.consistency||'—')}</b></div></div><div class="mp-signals">${items.map(([n,o,u])=>`<div class="mp-signal"><span>${n}${o&&o.carried_forward?'（沿用 '+escHtml(String(o.date||'').slice(5).replace('-','/'))+' 夜盤）':''}</span><b class="${cls(o&&o.value)}">${fmt(o&&o.value,u)}</b></div>`).join('')}</div><div class="mp-reason">${escHtml(x.reason||'')}</div><div class="mp-meta">${s.tx_night&&s.tx_night.carried_forward?'台指夜盤沿用較早交易日資料 · ':''}實驗性市場環境指標 · 30 以下偏空／70 以上偏多 · 不代表未來報酬或投資建議</div>`;
  const basis=String(x.target_date||x.as_of_date||'').trim(); const dt=x.generated_at?new Date(x.generated_at):null; const md=basis&&/^\d{4}-\d{2}-\d{2}$/.test(basis)?basis.slice(5).replace('-','/'):(dt&&!isNaN(dt)?dt.toLocaleDateString('zh-TW',{month:'2-digit',day:'2-digit'}):''); updated.textContent=md?`市場快照｜${md} 07:00`:'市場快照｜07:00';
 }catch(e){body.innerHTML=`<div class="mp-wait">Market Pulse 暫時無法讀取：${escHtml(e.message||String(e))}</div>`;updated.textContent='讀取失敗';}
}

(function(){
 const btn=document.getElementById('mpHelpBtn'), box=document.getElementById('mpHelpBox');
 if(!btn||!box)return;
 btn.addEventListener('click',()=>{const open=box.classList.toggle('open');btn.setAttribute('aria-expanded',open?'true':'false');btn.textContent=open?'收起說明':'？ Market Pulse 說明';});
})();

(function(){
 const btn=document.getElementById('msHelpBtn'), box=document.getElementById('msHelpBox');
 if(!btn||!box)return;
 btn.addEventListener('click',()=>{const open=box.classList.toggle('open');btn.setAttribute('aria-expanded',open?'true':'false');btn.textContent=open?'收起說明':'？ 市場結構說明';});
})();

async function loadRadar(){
 const updated=document.getElementById('radarUpdated'), empty=document.getElementById('radarEmpty');
 try{
   const r=await fetch(`screening.json?t=${Date.now()}`,{cache:'no-store'});
   if(!r.ok) throw new Error('screening.json 尚未建立');
   const j=await r.json();
   radarSnapshotData={
     official:Array.isArray(j.official_results)?j.official_results:(Array.isArray(j.results)?j.results:[]),
     intraday:Array.isArray(j.intraday_results)?j.intraday_results:[]
   };
   radarSnapshotMeta={
     official:j.official_markets||j.markets||{},
     intraday:j.intraday_markets||{}
   };
   radarMarketRegime=j.market_regime||{};
    radarBenchmarkData={
     official:j.official_benchmarks||{},
     intraday:j.intraday_benchmarks||{}
   };
   radarCapitalHotspots={
     official:j.official_capital_hotspots||{},
     intraday:j.intraday_capital_hotspots||{}
   };
   radarThemeLeaderboards={
     official:j.official_theme_leaderboards||{},
     intraday:j.intraday_theme_leaderboards||{}
   };
   radarThemeStockNames=j.theme_stock_names||{};
   radarAllQuotes={
     official:j.official_quotes||{},
     intraday:j.intraday_quotes||{}
   };
   radarRestoreEvents={
     official:j.official_restore_events||{},
     intraday:j.intraday_restore_events||{}
   };
   await loadServerLiveQuotesTW(false);
   startServerLiveQuotePolling();
   if(!radarSnapshotManuallyChosen && isIntradayLockedAfterOfficial(currentMarket)){
     radarSnapshot='official';
   }else if(!radarSnapshotManuallyChosen && shouldDefaultToTwIntraday()){
     radarSnapshot='intraday';
   }
   radarRows=radarSnapshotData[radarSnapshot];
   document.querySelectorAll('.snapshot-btn').forEach(b=>b.classList.toggle('active',b.dataset.snapshot===radarSnapshot));

   const officialCount=document.getElementById('officialCount');
   const marketCount=(arr,m)=>arr.filter(x=>String(x.market||'').toUpperCase()===String(m||'TW').toUpperCase()).length;
   const oc=marketCount(radarSnapshotData.official,currentMarket);
   if(officialCount) officialCount.textContent=oc?`(${oc})`:'';

   const intradayBtn=document.querySelector('.snapshot-btn[data-snapshot="intraday"]');
   const intradayCount=document.getElementById('intradayCount');
   const ic=marketCount(radarSnapshotData.intraday,currentMarket);
   if(intradayBtn) intradayBtn.disabled=!ic;
   if(intradayCount) intradayCount.textContent=ic?`(${ic})`:'';
   updateSnapshotAvailability();

   const tw=radarSnapshotMeta.official?.TW, us=radarSnapshotMeta.official?.US;
   const bits=[];
   if(tw?.data_date) bits.push(`台股 ${tw.data_date}`);
   if(us?.data_date) bits.push(`美股 ${us.data_date}`);
   updated.textContent=(bits.length?`正式資料截至：${bits.join('｜')}`:'尚無正式收盤資料')+(j.generated_at?`　檔案更新 ${j.generated_at}`:'');
   renderFreshness();
   renderMarketOverview();
   renderCapitalHotspots();
   renderThemeLeaderboards();
   renderRadar(radarFilter);
   if(!radarSnapshotData.official.length && radarSnapshotData.intraday.length){
     const body=document.getElementById('radarBody');
     const mobile=document.getElementById('radarMobile');
     const msg='正式收盤名單正在恢復中；請手動執行一次 VCP screening Action。盤中即時資料仍可正常查看。';
     if(body) body.innerHTML=`<tr><td colspan="11" style="padding:28px;text-align:center;color:#737270">${msg}</td></tr>`;
     if(mobile) mobile.innerHTML=`<div class="note">${msg}</div>`;
   }
 }catch(e){
   radarRows=[];
   const fresh=document.getElementById('radarFreshness'); if(fresh) fresh.hidden=true;
   const marketBox=document.getElementById('marketOverview'); if(marketBox) marketBox.hidden=true;
   if(updated) updated.textContent='每日篩選資料尚未產生';
   if(empty){
     empty.style.display='block';
     empty.textContent='第一次請到 GitHub → Actions → Daily VCP Screener → Run workflow 執行一次。';
   }
 }
}

document.querySelectorAll('.radar-tab').forEach(btn=>{
 btn.addEventListener('click',()=>toggleRadarKey(btn.dataset.radar));
});
const radarFilterClear=document.getElementById('radarFilterClear');
if(radarFilterClear) radarFilterClear.addEventListener('click',clearRadarAllFilters);
const radarSortSelect=document.getElementById('radarSort');
const changeSortDirBtn=document.getElementById('changeSortDirBtn');

function syncChangeSortDirectionUI(){
  if(!changeSortDirBtn) return;
  const active=radarSort==='change';
  changeSortDirBtn.classList.toggle('show',active);
  changeSortDirBtn.textContent=radarChangeSortDir==='asc'?'↑':'↓';
  changeSortDirBtn.title=radarChangeSortDir==='asc'
    ? '目前：跌最多 → 漲最多；點一下切換'
    : '目前：漲最多 → 跌最多；點一下切換';
  changeSortDirBtn.setAttribute('aria-label',changeSortDirBtn.title);
}

if(radarSortSelect){
  radarSortSelect.value=radarSort;
  radarSortSelect.addEventListener('change',()=>{
    const next=radarSortSelect.value;
    const enteringChange=next==='change' && radarSort!=='change';
    radarSort=next;
    if(enteringChange) radarChangeSortDir='desc';
    mobileRadarPage=1;
    syncChangeSortDirectionUI();
    renderRadar(radarFilter);
  });
}

if(changeSortDirBtn){
  changeSortDirBtn.addEventListener('click',(e)=>{
    e.preventDefault();
    e.stopPropagation();
    if(radarSort!=='change') return;
    radarChangeSortDir=radarChangeSortDir==='desc'?'asc':'desc';
    mobileRadarPage=1;
    syncChangeSortDirectionUI();
    renderRadar(radarFilter);
  });
}

syncChangeSortDirectionUI();


const userLiveRefreshBtn=document.getElementById('userLiveRefreshBtn');
if(userLiveRefreshBtn) userLiveRefreshBtn.addEventListener('click',refreshUserLiveQuotes);

const mobilePrevPage=document.getElementById('mobilePrevPage');
const mobileNextPage=document.getElementById('mobileNextPage');

function goMobileRadarPage(delta){
 const marketRows=radarRows.filter(r=>{
   if(String(r.market||'').toUpperCase()!==String(currentMarket||'TW').toUpperCase()) return false;
   return radarRowPass(r,radarFilter) && (!radarNumActive() || radarNumPass(effectiveRadarRow(r)));
  });
 const totalPages=Math.max(1,Math.ceil(marketRows.length/MOBILE_RADAR_PAGE_SIZE));
 mobileRadarPage=Math.max(1,Math.min(totalPages,mobileRadarPage+delta));
 renderRadar(radarFilter);

 const mobile=document.getElementById('radarMobile');
 if(mobile){
   const y=mobile.getBoundingClientRect().top+window.pageYOffset-86;
   window.scrollTo({top:Math.max(0,y),behavior:'smooth'});
 }
}
if(mobilePrevPage) mobilePrevPage.addEventListener('click',()=>goMobileRadarPage(-1));
if(mobileNextPage) mobileNextPage.addEventListener('click',()=>goMobileRadarPage(1));

let backToTopBtn=null;
function updateBackToTopVisibility(){
 if(!backToTopBtn) return;
 backToTopBtn.classList.toggle('show',(window.pageYOffset||document.documentElement.scrollTop||0)>700);
}
function initBackToTop(){
 backToTopBtn=document.getElementById('backToTopBtn');
 if(!backToTopBtn) return;
 window.addEventListener('scroll',updateBackToTopVisibility,{passive:true});
 backToTopBtn.addEventListener('click',()=>window.scrollTo({top:0,behavior:'smooth'}));
 updateBackToTopVisibility();
}
if(document.readyState==='loading'){
 document.addEventListener('DOMContentLoaded',initBackToTop,{once:true});
}else{
 initBackToTop();
}

const helpBtn=document.getElementById('helpBtn'), helpBox=document.getElementById('helpBox'), helpCloseBtn=document.getElementById('helpCloseBtn');
if(helpBtn&&helpBox){
  let helpBackdrop=null;
  const closeHelp=()=>{
    helpBox.classList.remove('open');
    document.body.classList.remove('help-modal-open');
    if(helpBackdrop){ helpBackdrop.remove(); helpBackdrop=null; }
  };
  const openHelp=()=>{
    helpBox.classList.add('open');
    helpBox.scrollTop=0;
    document.body.classList.add('help-modal-open');
    helpBackdrop=document.createElement('div');
    helpBackdrop.className='help-modal-backdrop';
    helpBackdrop.setAttribute('aria-hidden','true');
    helpBackdrop.addEventListener('click',closeHelp);
    document.body.appendChild(helpBackdrop);
  };
  helpBtn.onclick=()=>helpBox.classList.contains('open')?closeHelp():openHelp();
  if(helpCloseBtn) helpCloseBtn.onclick=closeHelp;
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&helpBox.classList.contains('open')) closeHelp();});
}
loadMarketStructure();
loadMarketPulse();
// Initial single-stock analysis waits until radar snapshots are loaded, so the default 2330 can reuse the same scanner data as manual selections.
loadRadar().finally(()=>run());
// Refresh during trading and after the official scan is expected to start.
setInterval(()=>{
 const now=taiwanMarketClock();
 if(!document.hidden && currentMarket==='TW' && ['Mon','Tue','Wed','Thu','Fri'].includes(now.weekday)
   && ((now.minutes>=9*60 && now.minutes<13*60+35) || (now.minutes>=18*60+10 && !isIntradayLockedAfterOfficial('TW')))) loadRadar();
},120000);
document.addEventListener('visibilitychange',()=>{
 if(!document.hidden && currentMarket==='TW') loadRadar();
});



/* ===== 階段 3：自訂篩選面板（數值條件、自訂排序、我的篩選） ===== */
(function(){
  const $i=id=>document.getElementById(id);
  const PRESET_KEY='vcpulse_filter_presets_v1';
  const loadPresets=()=>{ try{ const x=JSON.parse(localStorage.getItem(PRESET_KEY)||'[]'); return Array.isArray(x)?x:[]; }catch(e){ return []; } };
  const savePresets=a=>{ try{ localStorage.setItem(PRESET_KEY,JSON.stringify(a)); }catch(e){} };
  const currentState=()=>({keys:radarKeys(radarFilter),nums:Object.assign({},radarNum),
    sort:{mode:radarSort,changeDir:radarChangeSortDir,custom:radarCustomSort.map(x=>Object.assign({},x))}});
  const sig=st=>JSON.stringify([[...st.keys].sort(),st.nums.rs,st.nums.dist,st.nums.score,st.nums.chg,st.sort.mode,
    st.sort.mode==='change'?st.sort.changeDir:'',st.sort.mode==='custom'?st.sort.custom:'']);
  const dirText=d=>d==='asc'?'小→大':'大→小';
  function fillSortSelects(){
    const opts=Object.entries(RADAR_CSORT).map(([k,v])=>`<option value="${k}">${v.label}</option>`).join('');
    const a=$i('radarCs1Key'), b=$i('radarCs2Key');
    if(a) a.innerHTML='<option value="">（不用）</option>'+opts; if(b) b.innerHTML='<option value="">（不用）</option>'+opts;
  }
  function renderPresets(){
    const list=loadPresets(), cur=sig(currentState());
    const chips=$i('radarPresetChips'), grp=$i('radarPresetGroup'), box=$i('radarPresetList');
    if(grp) grp.hidden=!list.length;
    if(chips) chips.innerHTML=list.map(p=>`<button type="button" class="radar-preset-chip${sig(Object.assign({keys:[],nums:{},sort:{}},p,{nums:Object.assign({rs:null,dist:null,score:null,chg:null},p.nums),sort:Object.assign({mode:'smart',changeDir:'desc',custom:[]},p.sort)}))===cur?' active':''}" data-preset="${escHtml(p.id)}">${escHtml(p.name)}</button>`).join('');
    if(box) box.innerHTML=list.length?list.map(p=>`<div class="rc-preset-row"><span>${escHtml(p.name)}</span><button type="button" data-preset-apply="${escHtml(p.id)}">套用</button><button type="button" class="rc-del" data-preset-del="${escHtml(p.id)}" aria-label="刪除 ${escHtml(p.name)}">刪除</button></div>`).join(''):'<div class="rc-note">還沒有儲存的篩選。</div>';
  }
  window.syncRadarCustomUI=function(){
    const setv=(id,v)=>{ const e=$i(id); if(e && document.activeElement!==e) e.value=(v==null?'':v); };
    setv('radarNumRs',radarNum.rs); setv('radarNumDist',radarNum.dist); setv('radarNumScore',radarNum.score); setv('radarNumChg',radarNum.chg);
    const c1=radarCustomSort[0]||{key:'score',dir:'desc'}, c2=radarCustomSort[1]||{key:'',dir:'desc'};
    const k1=$i('radarCs1Key'), k2=$i('radarCs2Key'), d1=$i('radarCs1Dir'), d2=$i('radarCs2Dir');
    const on=(radarSort==='custom')&&!!c1.key;   // 第 1 層「不用」＝沒有啟用自訂排序
    if(k1) k1.value=on?c1.key:''; if(k2){ k2.value=on?(c2.key||''):''; k2.disabled=!on; }
    if(d1){ d1.textContent=dirText(c1.dir); d1.disabled=!on; } if(d2){ d2.textContent=dirText(c2.dir); d2.disabled=!on||!c2.key; }
    const sel=$i('radarSort'); if(sel && sel.value!==radarSort) sel.value=radarSort;
    const n=Object.values(radarNum).filter(v=>v!=null).length+(radarSort==='custom'?1:0), bd=$i('radarCustomBadge');
    if(bd){ bd.hidden=!n; bd.textContent=n; }
    renderPresets();
  };
  function numFrom(id,int){ const e=$i(id); if(!e||e.value==='') return null; const v=Number(e.value); return Number.isFinite(v)?(int?Math.round(v):v):null; }
  let t=null;
  function onNumInput(){
    radarNum={rs:numFrom('radarNumRs',true),dist:numFrom('radarNumDist'),score:numFrom('radarNumScore',true),chg:numFrom('radarNumChg')};
    if(radarNum.dist!=null && radarNum.dist<0) radarNum.dist=null;
    clearTimeout(t); t=setTimeout(()=>{ mobileRadarPage=1; syncRadarTabs(); renderRadar(radarFilter); },250);
  }
  ['radarNumRs','radarNumDist','radarNumScore','radarNumChg'].forEach(id=>{ const e=$i(id); if(e){ e.addEventListener('input',onNumInput); e.addEventListener('change',onNumInput); } });
  function onSortChange(){
    mobileRadarPage=1;
    const wasCustom=(radarSort==='custom');
    const k1=$i('radarCs1Key').value, k2=wasCustom?$i('radarCs2Key').value:((radarCustomSort[1]&&radarCustomSort[1].key)||'');
    if(!k1){ radarSort='smart'; syncChangeSortDirectionUI(); syncRadarTabs(); renderRadar(radarFilter); return; }   // 第 1 層選「不用」→ 回到智慧排序（設定保留）
    radarSort='custom';
    const old=radarCustomSort;
    radarCustomSort=[
      {key:k1,dir:(old[0]&&old[0].key===k1)?old[0].dir:RADAR_CSORT[k1].def},
      {key:k2,dir:(old[1]&&old[1].key===k2)?old[1].dir:(k2?RADAR_CSORT[k2].def:'desc')}
    ];
    syncChangeSortDirectionUI(); syncRadarTabs(); renderRadar(radarFilter);
  }
  ['radarCs1Key','radarCs2Key'].forEach(id=>{ const e=$i(id); if(e) e.addEventListener('change',onSortChange); });
  [['radarCs1Dir',0],['radarCs2Dir',1]].forEach(([id,i])=>{ const e=$i(id); if(e) e.addEventListener('click',()=>{
    if(!radarCustomSort[i]||!radarCustomSort[i].key||radarSort!=='custom') return;
    radarCustomSort[i].dir=radarCustomSort[i].dir==='asc'?'desc':'asc';
    radarSort='custom'; mobileRadarPage=1; syncChangeSortDirectionUI(); syncRadarTabs(); renderRadar(radarFilter);
  }); });
  function applyPreset(p){
    radarNum=Object.assign({rs:null,dist:null,score:null,chg:null},p.nums||{});
    const so=p.sort||{};
    radarSort=so.mode||'smart'; radarChangeSortDir=so.changeDir||'desc';
    radarCustomSort=(Array.isArray(so.custom)&&so.custom.length?so.custom:[{key:'score',dir:'desc'},{key:'',dir:'desc'}]).map(x=>Object.assign({},x));
    while(radarCustomSort.length<2) radarCustomSort.push({key:'',dir:'desc'});
    syncChangeSortDirectionUI(); setRadarFilterKeys(Array.isArray(p.keys)?p.keys:[]);
  }
  function onPresetClick(e){
    const a=e.target.closest('[data-preset],[data-preset-apply],[data-preset-del]'); if(!a) return;
    const list=loadPresets();
    const del=a.dataset.presetDel;
    if(del){ savePresets(list.filter(p=>p.id!==del)); renderPresets(); return; }
    const id=a.dataset.preset||a.dataset.presetApply, p=list.find(x=>x.id===id); if(p) applyPreset(p);
  }
  const chips=$i('radarPresetChips'), box=$i('radarPresetList');
  if(chips) chips.addEventListener('click',onPresetClick);
  if(box) box.addEventListener('click',onPresetClick);
  const saveBtn=$i('radarPresetSave'), nameEl=$i('radarPresetName');
  if(saveBtn) saveBtn.addEventListener('click',()=>{
    const st=currentState();
    if(!st.keys.length && !radarNumActive() && st.sort.mode==='smart'){ if(nameEl){ nameEl.placeholder='請先設定條件或排序'; nameEl.focus(); } return; }
    const list=loadPresets();
    if(list.length>=12){ if(nameEl){ nameEl.value=''; nameEl.placeholder='最多存 12 組，請先刪除'; } return; }
    const name=((nameEl&&nameEl.value)||'').trim().slice(0,12)||('我的篩選 '+(list.length+1));
    list.push({id:'p'+Date.now().toString(36),name,keys:st.keys,nums:st.nums,sort:st.sort});
    savePresets(list); if(nameEl){ nameEl.value=''; nameEl.placeholder='幫它取個名字'; } renderPresets();
  });
  fillSortSelects(); window.syncRadarCustomUI();
})();
