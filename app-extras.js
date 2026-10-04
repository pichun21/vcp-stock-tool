/* VCPulse 附加腳本：依原順序串接（emoji 圖示轉換、走勢圖重繪與互動、閱讀順序導覽、區塊導覽列與手機清單切換等） */
/* ---- extra 1 ---- */
(()=>{const C={hot:["🔥 高關注","VCP 結構佳，而且位置、壓縮或動能有多項條件同時配合，屬於雷達中優先留意的型態。","留意是否接近或突破 Pivot、突破時量能是否配合，以及突破後是否能守住關鍵位置。"],watch:["👀 觀察","VCP 已具一定品質，且 Pivot 位置、PowerSqueeze 或 Momentum 已有進一步配合，值得提高注意力。","觀察距離 Pivot 是否持續縮短、壓縮是否增強，以及 Momentum 是否往較有利的方向改善。"],wait:["⏳ 等待","已符合 VCP 雷達基本條件，但目前位置、壓縮或動能的配合仍不足，先等待條件進一步改善。","持續看是否更接近 Pivot、PowerSqueeze 是否出現或增強，以及 Momentum 是否改善。"],extended:["⚠️ 過度延伸","突破後距離 Pivot 已超過 8%，代表目前位置不像剛突破時那麼接近關鍵價位。","先留意是否出現整理或回測，以及價格與 Pivot 的距離是否回到較容易觀察的位置。"],quality:["💎 結構品質佳","代表這檔股票的 VCP 結構在趨勢、整體價格收斂、量縮、波動收斂與 Pivot 等條件上整體表現較完整。它不等同 5/5 星；品質標籤看的是整體結構，而星等是五項條件的符合數，因此即使部分單項未通過，仍可能被標示為結構品質佳。","可搭配星等、距 Pivot、PowerSqueeze 與 Momentum 一起看。星等較低時，可再查看是哪幾個單項未通過；💎 代表整體結構仍符合品質條件。"]};const close=()=>{const p=document.getElementById("pulseHelpPopover");if(p){p.hidden=true;document.body.style.overflow=""}};document.addEventListener("click",e=>{
  const t=e.target.closest(".pulse-help-trigger,.structure-quality-badge");
  if(!t)return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  const i=t.classList.contains("structure-quality-badge")?C.quality:(C[t.dataset.pulse]||C.wait);
  const p=document.getElementById("pulseHelpPopover");
  document.getElementById("pulseHelpTitle").textContent=i[0];
  document.getElementById("pulseHelpDesc").textContent=i[1];
  document.getElementById("pulseHelpWatch").textContent=i[2];
  p.hidden=false;
  document.body.style.overflow="hidden";
},true);
document.addEventListener("click",e=>{
  if(e.target.closest("[data-pulse-help-close]")){
    e.preventDefault();
    e.stopPropagation();
    close();
  }
});document.addEventListener("keydown",e=>{if(e.key==="Escape")close()})})();
document.getElementById('themeHelpBtn')?.addEventListener('click',()=>{
 const box=document.getElementById('themeHelpBox');
 if(box) box.hidden=!box.hidden;
});

document.addEventListener('click',(e)=>{
 const btn=e.target.closest?.('#capitalHelpBtn');
 if(!btn) return;
 const box=document.getElementById('capitalHelpBox');
 if(!box) return;
 const willOpen=box.hidden;
 box.hidden=!willOpen;
 btn.setAttribute('aria-expanded',String(willOpen));
});
;
/* ---- extra 2 ---- */
function auxPct(v,d=1){return Number.isFinite(v)?`${v>0?'+':''}${v.toFixed(d)}%`:'—'}
function auxSet(id,text,v=null,mode='direction'){const e=document.getElementById(id);if(!e)return;e.textContent=text;if(mode==='neutral'){e.className='neutral';return}e.className=Number.isFinite(v)?(v>0?'up':v<0?'down':'neutral'):'neutral'}
function resetAuxMarketAndForeign(){
 const p=document.getElementById('auxMarketPanel');if(p)p.hidden=true; try{resetStrengthPanel()}catch(e){}
 ['auxRet5','auxRet20','auxYearHigh','auxTodayVolRatio','auxVolRatio','foreignToday','foreign5','foreign20','foreignStreak','foreignHolding','foreignHolding5','whale400','whale1w','whale4w','whaleStreak'].forEach(id=>auxSet(id,'—'));
 const as=document.getElementById('foreignAsOf');if(as)as.textContent='正式收盤資料'; const wa=document.getElementById('whaleAsOf');if(wa)wa.textContent='每週更新'; const ma=document.getElementById('momentumAsOf');if(ma)ma.textContent='正式收盤資料'; const fl=document.getElementById('foreignDayLabel');if(fl)fl.textContent='前一交易日';
}
function updateMarketMomentum(d,isIntraday=false){
 if(!Array.isArray(d)||d.length<21)return;
 const closes=d.map(x=>Number(x.close)).filter(Number.isFinite), vols=d.map(x=>Number(x.Trading_Volume??x.volume)).filter(Number.isFinite);
 if(closes.length<21)return;
 const last=closes.at(-1), r5=(last/closes.at(-6)-1)*100, r20=(last/closes.at(-21)-1)*100;
 const year=closes.slice(-252), hi=Math.max(...year), distHi=(last/hi-1)*100;
 const avg=a=>a.reduce((x,y)=>x+y,0)/a.length; let vr=NaN,todayVr=NaN;
 if(vols.length>=21){
   const prior20=vols.slice(-21,-1), avg20prior=avg(prior20), todayVol=vols.at(-1);
   if(avg20prior>0 && Number.isFinite(todayVol)){
     if(isIntraday){
       const now=new Date(), mins=now.getHours()*60+now.getMinutes(), open=9*60, close=13*60+30;
       const frac=Math.max(0.05,Math.min(1,(mins-open)/(close-open)));
       todayVr=(todayVol/frac)/avg20prior;
     }else todayVr=todayVol/avg20prior;
   }
 }
 if(vols.length>=20){const a5=avg(vols.slice(-5)),a20=avg(vols.slice(-20));if(a20>0)vr=a5/a20}
 auxSet('auxRet5',auxPct(r5),r5);auxSet('auxRet20',auxPct(r20),r20);auxSet('auxYearHigh',Number.isFinite(distHi)?`${distHi.toFixed(1)}%`:'—',distHi,'neutral');
 auxSet('auxTodayVolRatio',Number.isFinite(todayVr)?`${todayVr.toFixed(2)} 倍`:'—',null,'neutral');
 auxSet('auxVolRatio',Number.isFinite(vr)?`${vr.toFixed(2)} 倍`:'—',null,'neutral');
 const lastRow=d.at(-1)||{}; const dataDate=String(lastRow.date||lastRow.Date||'').slice(0,10); const ma=document.getElementById('momentumAsOf');if(ma)ma.textContent=dataDate?`截至 ${dataDate} ${isIntraday?'盤中':'收盤'}`:'正式收盤資料';
}
async function fetchFinMindRows(dataset,symbol,start,end){
 const u=`${API}?dataset=${dataset}&data_id=${encodeURIComponent(symbol)}&start_date=${start}&end_date=${end}`;
 const r=await fetch(u,{cache:'no-store'}); if(!r.ok)throw new Error(`${dataset} HTTP ${r.status}`); const j=await r.json(); return Array.isArray(j?.data)?j.data:[];
}
function foreignNetRows(rows){
 const m=new Map();
 rows.filter(x=>String(x.name)==='Foreign_Investor').forEach(x=>{const d=String(x.date||''),net=(Number(x.buy)||0)-(Number(x.sell)||0);m.set(d,(m.get(d)||0)+net)});
 return [...m.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,net])=>({date,net}));
}
function foreignStreakText(a){
 if(!a.length)return '—';let sign=Math.sign(a.at(-1).net);if(!sign)return '當日持平';let n=0;for(let i=a.length-1;i>=0&&Math.sign(a[i].net)===sign;i--)n++;return `連${sign>0?'買':'賣'} ${n} 日`;
}
async function updateForeign(symbol){
 const end=new Date(),start=new Date();start.setDate(end.getDate()-55);const f=d=>d.toISOString().slice(0,10);
 try{
  const [inst,hold]=await Promise.all([fetchFinMindRows('TaiwanStockInstitutionalInvestorsBuySell',symbol,f(start),f(end)),fetchFinMindRows('TaiwanStockShareholding',symbol,f(start),f(end))]);
  const a=foreignNetRows(inst); const sum=n=>a.slice(-n).reduce((z,x)=>z+x.net,0)/1000; const today=a.length?a.at(-1).net/1000:NaN;
  auxSet('foreignToday',Number.isFinite(today)?`${today>0?'+':''}${Math.round(today).toLocaleString()} 張`:'—',today); const v5=a.length?sum(5):NaN,v20=a.length?sum(20):NaN;
  auxSet('foreign5',Number.isFinite(v5)?`${v5>0?'+':''}${Math.round(v5).toLocaleString()} 張`:'—',v5);auxSet('foreign20',Number.isFinite(v20)?`${v20>0?'+':''}${Math.round(v20).toLocaleString()} 張`:'—',v20);const streak=foreignStreakText(a);auxSet('foreignStreak',streak,a.length?Math.sign(a.at(-1).net):null);
  const h=hold.filter(x=>Number.isFinite(Number(x.ForeignInvestmentSharesRatio))).sort((x,y)=>String(x.date).localeCompare(String(y.date)));
  if(h.length){const cur=Number(h.at(-1).ForeignInvestmentSharesRatio),old=Number(h[Math.max(0,h.length-6)].ForeignInvestmentSharesRatio),chg=cur-old;auxSet('foreignHolding',`${cur.toFixed(2)}%`,null,'neutral');auxSet('foreignHolding5',`${chg>0?'+':''}${chg.toFixed(2)} pp`,chg)} const flowDate=a.length?a.at(-1).date:'';const as=document.getElementById('foreignAsOf');if(as)as.textContent=flowDate?`截至 ${flowDate} 收盤`:'正式收盤資料';const fl=document.getElementById('foreignDayLabel');if(fl)fl.textContent=flowDate?`${flowDate.slice(5).replace('-','/')} 買賣超`:'前一交易日';
 }catch(e){console.warn('Foreign flow unavailable',e);const as=document.getElementById('foreignAsOf');if(as)as.textContent='外資資料暫時無法取得'}
}
let tdccWhaleCache=null;
async function loadTdccWhales(){
 if(tdccWhaleCache)return tdccWhaleCache;
 try{const r=await fetch(`tdcc_whales.json?t=${Date.now()}`,{cache:'no-store'});if(!r.ok)throw new Error(`TDCC HTTP ${r.status}`);tdccWhaleCache=await r.json();return tdccWhaleCache}catch(e){console.warn('TDCC whale data unavailable',e);return null}
}
function whaleStreakText(rows){
 if(!Array.isArray(rows)||rows.length<2)return '—';let last=rows.length-1,d=Number(rows[last].big400)-Number(rows[last-1].big400),sign=Math.sign(d);if(!sign)return '本週持平';let n=1;for(let i=last-1;i>=1;i--){let x=Number(rows[i].big400)-Number(rows[i-1].big400);if(Math.sign(x)!==sign)break;n++}return `連${sign>0?'增':'減'} ${n} 週`;
}
async function updateWhales(symbol){
 const wa=document.getElementById('whaleAsOf');
 try{const all=await loadTdccWhales(),rows=all?.symbols?.[String(symbol)]||[];if(!rows.length){if(wa)wa.textContent='暫無集保資料';return}
  const cur=rows.at(-1),prev=rows.length>=2?rows.at(-2):null,old4=rows.length>=5?rows.at(-5):null;
  const v=Number(cur.big400),w1=prev?v-Number(prev.big400):NaN,w4=old4?v-Number(old4.big400):NaN;
  auxSet('whale400',Number.isFinite(v)?`${v.toFixed(2)}%`:'—',null,'neutral');
  auxSet('whale1w',Number.isFinite(w1)?`${w1>0?'+':''}${w1.toFixed(2)} pp`:'—',w1);
  auxSet('whale4w',Number.isFinite(w4)?`${w4>0?'+':''}${w4.toFixed(2)} pp`:'—',w4);
  const st=whaleStreakText(rows);let sv=rows.length>=2?Number(rows.at(-1).big400)-Number(rows.at(-2).big400):NaN;auxSet('whaleStreak',st,sv);
  if(wa)wa.textContent=`截至 ${String(cur.date).slice(0,10)}（週資料）`;
 }catch(e){console.warn('Whale trend unavailable',e);if(wa)wa.textContent='集保資料暫時無法取得'}
}
function rsRatingFor(market,symbol){
 try{
  const m=String(market||'').toUpperCase(), s=String(symbol||'').toUpperCase();
  const q=(typeof radarAllQuotes!=='undefined'&&radarAllQuotes)||{};
  const order=(typeof radarSnapshot!=='undefined'&&radarSnapshot==='intraday')?['intraday','official']:['official','intraday'];
  for(let i=0;i<order.length;i++){
   const e=((q[order[i]]||{})[m]||{})[s]; const v=Number(e&&e.rs_rating);
   if(Number.isFinite(v)&&v>0) return v;
  }
 }catch(e){}
 return null;
}
function resetStrengthPanel(){
 const set=(id,fn)=>{const e=document.getElementById(id); if(e) fn(e);};
 set('rsCard',e=>e.dataset.tier='none'); set('ttCard',e=>{e.dataset.tier='none';e.dataset.has='';e.dataset.fail='';});
 set('auxRs',e=>{e.textContent='—';e.className='';e.title='';}); set('auxRsSub',e=>e.textContent='近 3～12 個月漲幅排名');
 set('auxTt',e=>{e.textContent='—';e.className='';e.title='';}); set('auxTtSub',e=>e.textContent='價格面 7 項條件');
 set('auxTtPips',e=>e.innerHTML='');
}
function updateRsTile(symbol,market){
 const e=document.getElementById('auxRs'); if(!e) return;
 const n=rsRatingFor(market,symbol), card=document.getElementById('rsCard'), sub=document.getElementById('auxRsSub');
 if(n===null){ e.textContent='—'; e.title='尚無相對強度資料（要等下一次掃描更新，或該股不在排名範圍內：流動性不足、上市未滿約 9 個月）'; if(card) card.dataset.tier='none'; if(sub) sub.textContent='尚無資料'; return; }
 e.textContent=String(n);
 e.title=`相對強度 RS ${n}：近 3／6／9／12 個月加權漲幅，在同市場流動性足夠的股票中的排名（1–99，越高越強）；僅供參考，不影響 VCP 分數`;
 if(card) card.dataset.tier=n>=90?'top':(n>=80?'hi':(n>=70?'mid':'low'));
 if(sub) sub.textContent=`前 ${Math.max(1,100-n)}% · 近 3～12 個月漲幅排名`;
}
function ttDataFor(market,symbol){
 try{
  const m=String(market||'').toUpperCase(), s=String(symbol||'').toUpperCase();
  const q=(typeof radarAllQuotes!=='undefined'&&radarAllQuotes)||{};
  const order=(typeof radarSnapshot!=='undefined'&&radarSnapshot==='intraday')?['intraday','official']:['official','intraday'];
  for(let i=0;i<order.length;i++){
   const e=((q[order[i]]||{})[m]||{})[s];
   if(e&&e.tt_count!=null&&Number.isFinite(Number(e.tt_count))) return e;
  }
 }catch(e){}
 return null;
}
function updateTtTile(symbol,market){
 const box=document.getElementById('auxTt'); if(!box) return;
 const card=document.getElementById('ttCard'), sub=document.getElementById('auxTtSub'), pips=document.getElementById('auxTtPips');
 const e=ttDataFor(market,symbol);
 if(!e){ if(card){card.dataset.has='';card.dataset.fail='';} box.textContent='—'; box.title='尚無趨勢模板資料（要等下一次掃描更新，或上市未滿約 10 個月）'; if(card) card.dataset.tier='none'; if(sub) sub.textContent='尚無資料'; if(pips) pips.innerHTML=''; return; }
 const n=Number(e.tt_count), fail=Array.isArray(e.tt_fail)?e.tt_fail.map(Number):[];
 const rs=rsRatingFor(market,symbol), miss=fail.map(k=>TT_LABELS[k]).filter(Boolean);
 box.textContent=`${n}/7`; box.title=ttTipText(n,fail,rs); if(card){card.dataset.fail=fail.join(',');card.dataset.has='1';}
 if(card) card.dataset.tier=n>=7?'top':(n>=5?'mid':'low');
 if(pips) pips.innerHTML=[1,2,3,4,5,6,7].map(k=>`<i class="${fail.includes(k)?'no':'ok'}" title="${String(TT_LABELS[k]).replace(/"/g,'&quot;')}：${fail.includes(k)?'未通過':'通過'}"></i>`).join('');
 if(sub) sub.textContent=miss.length?`未過：${miss.join('、')}`:(Number(rs)>=70?'價格面全過，且 RS ≥ 70：完整符合':'價格面 7 項全過');
}
/* ---- 強度評級：點卡片開說明彈窗 ---- */
function shEsc(x){return String(x==null?"":x).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));}
function closeStrengthHelp(){
 const b=document.getElementById('shBackdrop'); if(!b) return;
 b.classList.remove('open'); document.documentElement.style.overflow=b.dataset.prevOverflow||'';
 setTimeout(()=>{ if(b.parentNode) b.parentNode.removeChild(b); },180);
 if(window.__shLastFocus&&window.__shLastFocus.focus) try{window.__shLastFocus.focus();}catch(e){}
}
function strengthHelpHtml(kind){
 if(kind==='rs'){
  const v=(document.getElementById('auxRs')||{}).textContent||'—', sub=(document.getElementById('auxRsSub')||{}).textContent||'';
  const now=(v&&v!=='—')?`這檔目前：RS ${v}（${sub.split(' · ')[0]}）`:'這檔目前：尚無 RS 資料（流動性不足、上市未滿約 9 個月，或要等下一次掃描）';
  return {title:'相對強度 RS',body:`
   <div class="sh-now">${shEsc(now)}</div>
   <p><b>一句話：</b>這檔股票近 3～12 個月的漲幅，在同市場排第幾。範圍 1～99，越高越強；畫面上的「前 N%」＝ 100 − RS。例如 RS 90 代表贏過約 9 成的股票。</p>
   <p><b>怎麼算：</b>取近 3、6、9 個月與近一年的漲幅，依 40%／20%／20%／20% 加權（越近期權重越高），再和同市場、成交值足夠的股票比名次。</p>
   <div class="sh-tiers"><span class="rs-chip rs-top">90 以上 深綠</span><span class="rs-chip rs-hi">80～89 淺綠</span><span class="rs-chip rs-mid">70～79 米色</span><span class="rs-chip rs-low">70 以下 虛線</span></div>
   <p><b>為什麼看它：</b>VCP 常見做法是在市場上相對強勢的領導股裡找，偏好 RS 70 以上、越高越好；同樣是 5 星時，RS 能分辨誰本來就強。</p>
   <p class="sh-note">只是標註，不影響 VCP 星數、入選與排序。反映的是過去漲幅，不代表未來，也不是買賣建議。</p>`};
 }
 const card=document.getElementById('ttCard')||{dataset:{}}, has=!!card.dataset.has;
 const fail=(card.dataset.fail||'').split(',').filter(Boolean).map(Number);
 const tv=(document.getElementById('auxTt')||{}).textContent||'—';
 const rows=[1,2,3,4,5,6,7].map(k=>`<li class="${has?(fail.includes(k)?'no':'ok'):''}"><i></i><span>${shEsc(TT_LABELS[k])}${has?(fail.includes(k)?'（未通過）':''):''}</span></li>`).join('');
 const now=has?`這檔目前：${tv} 項通過${fail.length?'，標示「未通過」的是缺少的條件':'，價格面 7 項全過'}`:'這檔目前：尚無趨勢模板資料（上市未滿約 10 個月，或要等下一次掃描）';
 return {title:'趨勢模板（價格面 7 項）',body:`
  <div class="sh-now">${shEsc(now)}</div>
  <p><b>一句話：</b>檢查這檔股票是不是處在健康的上升趨勢，源自 Mark Minervini 的選股條件。VCP 是在上升趨勢中整理後再突破，趨勢沒過的整理，可能只是長期下跌後的小反彈。</p>
  <ul class="sh-list">${rows}</ul>
  <p><b>第 8 項：</b>經典標準還要求 RS ≥ 70，這項直接看左邊的相對強度。篩選「趨勢模板 ✓」＝ 7 項全過且 RS ≥ 70。</p>
  <p class="sh-note">以收盤價計算（52 週高低點也用收盤價），需約 10 個月資料。沒過不代表看空，要看是哪一項沒過；只是標註，不影響 VCP 星數、入選與排序，也不是買賣建議。</p>`};
}
function openStrengthHelp(kind){
 closeStrengthHelp();
 const c=strengthHelpHtml(kind);
 const b=document.createElement('div'); b.id='shBackdrop'; b.className='sh-backdrop';
 b.dataset.prevOverflow=document.documentElement.style.overflow||'';
 b.innerHTML=`<div class="sh-sheet" role="dialog" aria-modal="true" aria-label="${shEsc(c.title)}說明"><div class="sh-top"><h4>${shEsc(c.title)}</h4><button type="button" class="sh-close" aria-label="關閉">×</button></div>${c.body}</div>`;
 b.addEventListener('click',e=>{ if(e.target===b||e.target.closest('.sh-close')) closeStrengthHelp(); });
 window.__shLastFocus=document.activeElement;
 document.body.appendChild(b); document.documentElement.style.overflow='hidden';
 requestAnimationFrame(()=>b.classList.add('open'));
 const cb=b.querySelector('.sh-close'); if(cb) cb.focus();
}
document.addEventListener('click',e=>{
 const c=e.target.closest&&e.target.closest('#strengthPanel .strength-card[data-help]'); if(!c) return;
 openStrengthHelp(c.dataset.help);
});
document.addEventListener('keydown',e=>{
 if(e.key==='Escape'&&document.getElementById('shBackdrop')){ closeStrengthHelp(); return; }
 if((e.key==='Enter'||e.key===' ')&&e.target&&e.target.matches&&e.target.matches('#strengthPanel .strength-card[data-help]')){ e.preventDefault(); openStrengthHelp(e.target.dataset.help); }
});
function updateAuxMarketAndForeign(symbol,d,market,liveQuote=null){
 const p=document.getElementById('auxMarketPanel');if(!p)return;p.hidden=false;
 const today=new Date();const td=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
 const liveDate=String(liveQuote?.data_date||'').slice(0,10);
 const intraday=String(market).toUpperCase()==='TW' && liveDate===td && !isIntradayLockedAfterOfficial('TW');
 updateMarketMomentum(d,intraday);
 try{ updateRsTile(symbol,market); }catch(e){} try{ updateTtTile(symbol,market); }catch(e){}
 const isTW=String(market).toUpperCase()==='TW';const fb=document.getElementById('foreignBlock');if(fb)fb.hidden=!isTW;const wb=document.getElementById('whaleBlock');if(wb)wb.hidden=!isTW;if(isTW){updateForeign(symbol);updateWhales(symbol)}
}
;
/* ---- extra 3 ---- */
/* 把常見彩色 emoji 換成統一的線條圖示／色點（含動態產生的內容） */
(function(){
 try{
  const I=d=>'<svg class="eic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+d+'</svg>';
  const D=c=>'<i class="edot" style="--c:'+c+'"></i>';
  const MAP={
   '🔥':I('<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z"/>'),
   '👀':I('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
   '⏳':I('<path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9"/>'),
   '⚠':I('<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4.5M12 17.5v.5"/>'),
   '💎':I('<path d="M6 3h12l4 6-10 12L2 9z"/><path d="M2 9h20"/>'),
   '⚡':I('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
   '📈':I('<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>'),
   '📡':I('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
   '🔄':I('<path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 12a9 9 0 0 1 15-6.7L21 8M3 21v-5h5M21 3v5h-5"/>'),
   '✅':I('<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>'),
   '⭐':I('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'),
   '🟢':D('#2f8a58'),'🔵':D('#4f8a7e'),'🟡':D('#d9a825'),'⚪':D('#cfc6b6'),
   '🔴':D('#d64545'),'🟠':D('#e08a2e'),'🩷':D('#e68aa8'),
   '🆕':'<span class="new-tag">NEW</span>',
   '🇹🇼':'<span class="mkt-tag">TW</span>','🇺🇸':'<span class="mkt-tag">US</span>'
  };
  const keys=Object.keys(MAP).sort((a,b)=>b.length-a.length);
  const src='(?:'+keys.join('|')+')\uFE0F?';
  const reG=new RegExp(src,'g'), reT=new RegExp(src);
  const SKIP={SCRIPT:1,STYLE:1,TEXTAREA:1,INPUT:1,OPTION:1,SELECT:1,TITLE:1,NOSCRIPT:1};
  const esc=t=>t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  function conv(n){
   const par=n.parentNode; if(!par||SKIP[par.nodeName]) return;
   const v=n.nodeValue; if(!v||!reT.test(v)) return;
   const html=esc(v).replace(reG,m=>MAP[m.replace('\uFE0F','')]||m);
   const t=document.createElement('template'); t.innerHTML=html;
   par.replaceChild(t.content,n);
  }
  function walk(root){
   if(!root) return;
   if(root.nodeType===3){conv(root);return;}
   if(root.nodeType!==1||SKIP[root.nodeName]) return;
   const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT), list=[];
   while(w.nextNode()) list.push(w.currentNode);
   list.forEach(conv);
  }
  walk(document.body);
  new MutationObserver(ms=>{
   for(const m of ms){
    if(m.type==='characterData') conv(m.target);
    else m.addedNodes.forEach(walk);
   }
  }).observe(document.body,{childList:true,subtree:true,characterData:true});
 }catch(e){console.warn('emoji polish skipped',e);}
})();
;
/* ---- extra 4 ---- */
/* 走勢圖：畫布顯示寬度改變時（版面重排、視窗縮放、區塊展開）自動以新寬度重繪，避免被 CSS 拉伸而模糊 */
(function(){
 try{
  const c=document.getElementById('chart');
  if(!c||!window.ResizeObserver) return;
  let t=0;
  const redraw=function(){
   const a=window.__chartA; if(!a) return;
   const w=Math.round(c.getBoundingClientRect().width);
   if(!w||Math.abs(w-(window.__chartDrawnW||0))<2) return;
   clearTimeout(t);
   t=setTimeout(function(){try{draw(a);}catch(e){}},100);
  };
  new ResizeObserver(redraw).observe(c);
  window.addEventListener('resize',redraw);
 }catch(e){}
})();
;
/* ---- extra 5 ---- */
/* 走勢圖：滑鼠移到 C1～C4 區間上（手機點一下）才顯示完整標籤，其餘區間淡化 */
(function(){
 try{
  const c=document.getElementById('chart'); if(!c) return;
  let raf=0;
  const hit=function(e){
   const segs=window.__chartSegs||[]; if(!segs.length) return null;
   const r=c.getBoundingClientRect(); const sc=(window.__chartDrawnW||r.width)/Math.max(r.width,1);
   const px=(e.clientX-r.left)*sc, py=(e.clientY-r.top)*sc;
   let best=null,bd=1e9;
   segs.forEach(function(g){
    const dx=g.x2-g.x1,dy=g.y2-g.y1,l2=(dx*dx+dy*dy)||1;
    let t=((px-g.x1)*dx+(py-g.y1)*dy)/l2; t=Math.max(0,Math.min(1,t));
    const dl=Math.hypot(px-(g.x1+t*dx),py-(g.y1+t*dy));
    const db=Math.hypot(px-g.cx,py-g.cy)-g.cr;
    const d=Math.min(dl-1,db);
    if(d<=12&&d<bd){bd=d;best=g.k;}
   });
   return best;
  };
  const set=function(k){
   const cur=(typeof window.__chartHover==='number')?window.__chartHover:null;
   if(cur===k) return;
   window.__chartHover=k;
   c.style.cursor=(k===null?'':'pointer');
   cancelAnimationFrame(raf);
   raf=requestAnimationFrame(function(){try{if(window.__chartA) draw(window.__chartA);}catch(err){}});
  };
  c.addEventListener('pointermove',function(e){ if(e.pointerType==='touch') return; set(hit(e)); });
  c.addEventListener('pointerleave',function(e){ if(e.pointerType!=='touch') set(null); });
  c.addEventListener('pointerdown',function(e){
   if(e.pointerType!=='touch') return;
   const k=hit(e), cur=(typeof window.__chartHover==='number')?window.__chartHover:null;
   set(k!==null&&cur===k?null:k);
  });
 }catch(e){}
})();
;
/* ---- extra 6 ---- */
/* 建議閱讀順序：點擊直接捲動到對應區塊（避開上方固定的登入列） */
(function(){
 try{
  const MAP={
   pulse:['#marketPulseCard'],
   structure:['#marketStructureCard','#marketPulseCard'],
   theme:['#capitalHotspots','#themeLeaderboards','#marketOverview','.radar-card'],
   radar:['.radar-card','.radar-section'],
   single:['#singleStockAnalysis']
  };
  const visible=function(el){return !!el && !el.hidden && el.offsetParent!==null && el.getBoundingClientRect().height>0;};
  function go(key){
   const list=MAP[key]||[]; let el=null;
   for(let i=0;i<list.length;i++){const c=document.querySelector(list[i]); if(visible(c)){el=c;break;}}
   if(!el) return;
   const bar=document.getElementById('userBar');
   const barH=window.__stickyOffset?window.__stickyOffset():0;
   const y=Math.max(0,(window.pageYOffset||document.documentElement.scrollTop||0)+el.getBoundingClientRect().top-barH-12);
   try{ window.scrollTo({top:y,behavior:'smooth'}); }catch(e){ window.scrollTo(0,y); }
   el.classList.remove('guide-flash'); void el.offsetWidth; el.classList.add('guide-flash');
   setTimeout(function(){el.classList.remove('guide-flash');},1700);
  }
  document.addEventListener('click',function(e){
   const t=e.target.closest&&e.target.closest('[data-guide]');
   if(t){e.preventDefault();go(t.getAttribute('data-guide'));}
  });
  document.addEventListener('keydown',function(e){
   if((e.key==='Enter'||e.key===' ') && e.target.matches && e.target.matches('.guide-step[data-guide]')){
    e.preventDefault();go(e.target.getAttribute('data-guide'));
   }
  });
 }catch(e){}
})();
;
/* ---- extra 7 ---- */
/* 固定導覽列：計算固定元素高度、標示目前所在區塊；手機清單：精簡／詳細切換與點擊展開 */
(function(){
 try{
  const root=document.documentElement;
  const nav=document.getElementById('sectionNav');
  const ub=document.getElementById('userBar');
  const vis=function(el){return !!el && el.offsetParent!==null && getComputedStyle(el).display!=='none';};
  const ubH=function(){return (ub && getComputedStyle(ub).display!=='none')?ub.getBoundingClientRect().height:0;};
  const navH=function(){return vis(nav)?nav.getBoundingClientRect().height:0;};
  const syncVars=function(){root.style.setProperty('--ub-h',ubH()+'px');root.style.setProperty('--nav-h',navH()+'px');};
  window.__stickyOffset=function(){return ubH()+navH();};
  syncVars();
  if(window.ResizeObserver){
   const ro=new ResizeObserver(syncVars);
   if(ub) ro.observe(ub);
   if(nav) ro.observe(nav);
  }
  window.addEventListener('resize',syncVars);
  window.addEventListener('load',syncVars);

  // 目前所在區塊
  const SEL={pulse:['#marketPulseCard'],structure:['#marketStructureCard'],single:['#singleStockAnalysis'],theme:['#capitalHotspots','#themeLeaderboards'],radar:['.radar-card']};
  const pick=function(list){for(let i=0;i<list.length;i++){const e=document.querySelector(list[i]);if(e && !e.hidden && e.offsetParent!==null && e.getBoundingClientRect().height>0) return e;}return null;};
  let ticking=false, lastKey=null;
  const update=function(){
   ticking=false;
   if(!vis(nav)) return;
   const line=window.__stickyOffset()+28;
   let cur=null;
   Object.keys(SEL).forEach(function(k){const e=pick(SEL[k]); if(e && e.getBoundingClientRect().top<=line) cur=k;});
   if(cur===lastKey) return;
   lastKey=cur;
   nav.querySelectorAll('.snav-btn').forEach(function(b){
    const on=(b.getAttribute('data-snav')===cur);
    b.classList.toggle('active',on);
    if(on){ try{nav.scrollTo({left:Math.max(0,b.offsetLeft-(nav.clientWidth-b.offsetWidth)/2),behavior:'smooth'});}catch(e){} }
   });
  };
  window.addEventListener('scroll',function(){ if(!ticking){ticking=true;requestAnimationFrame(update);} },{passive:true});
  window.addEventListener('resize',update);
  setTimeout(update,400);

  // 手機清單：精簡／詳細
  const mob=document.getElementById('radarMobile');
  const KEY='vcpRadarView';
  let view='compact';
  try{ const v=localStorage.getItem(KEY); if(v==='full'||v==='compact') view=v; }catch(e){}
  const apply=function(v){
   view=v;
   if(mob) mob.classList.toggle('compact',v==='compact');
   document.querySelectorAll('.rvt-btn').forEach(function(b){b.classList.toggle('active',b.getAttribute('data-view')===v);});
   try{localStorage.setItem(KEY,v);}catch(e){}
  };
  document.querySelectorAll('.rvt-btn').forEach(function(b){b.addEventListener('click',function(){apply(b.getAttribute('data-view'));});});
  apply(view);
  if(mob){
   mob.addEventListener('click',function(e){
    if(!mob.classList.contains('compact')) return;
    const card=e.target.closest('.mobile-stock-card'); if(!card) return;
    if(e.target.closest('button,a,input,select,textarea,.reason-list')) return;
    card.classList.toggle('expanded');
   });
  }
 }catch(err){ console.warn('nav/compact init skipped',err); }
})();
;
/* ---- extra 8: 建議閱讀順序 收合／展開 ---- */
(function(){
 try{
  const g=document.getElementById('vcpReadingGuide'); if(!g) return;
  const t=g.querySelector('.guide-title'); if(!t) return;
  const set=function(open){ g.classList.toggle('open',open); t.setAttribute('aria-expanded',open?'true':'false'); };
  set(false);
  t.addEventListener('click',function(){ set(!g.classList.contains('open')); });
  t.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); set(!g.classList.contains('open')); } });
 }catch(e){}
})();
;
/* ---- extra 9: 精簡卡片的星等（複製一份放到代號旁；只在精簡且未展開時由 CSS 顯示） ---- */
(function(){
 try{
  const mob=document.getElementById('radarMobile'); if(!mob) return;
  const decorate=function(){
   mob.querySelectorAll('.mobile-stock-card').forEach(function(card){
    const sc=card.querySelector('.mobile-score'), code=card.querySelector('.mobile-stock-code');
    if(!sc||!code||code.querySelector('.mobile-score-inline')) return;
    const s=document.createElement('span'); s.className='mobile-score-inline'; s.setAttribute('aria-hidden','true');
    s.textContent=sc.textContent.trim(); code.appendChild(s);
   });
  };
  decorate();
  new MutationObserver(decorate).observe(mob,{childList:true});
 }catch(e){}
})();
;
/* ---- extra 10: 收藏雲端同步（Firestore: userFavorites/{uid}；未開權限或離線時自動退回只存本機） ---- */
(function(){
 try{
  const SYNC_UID_KEY='vcpulse_fav_synced_uid', DIRTY_KEY='vcpulse_fav_dirty';
  let pushTimer=null, pulling=false, lastPull=0, disabled=false;
  const setStatus=function(t,warn){ const e=document.getElementById('favSyncStatus'); if(!e) return; e.textContent=t||''; e.style.color=warn?'#b45309':'#777674'; };
  const readLocal=function(){ return {items:[...getFavorites()].sort(), meta:getFavoriteMeta()}; };
  const applyLocal=function(items,meta){
   localStorage.setItem(FAVORITES_KEY,JSON.stringify(items));
   localStorage.setItem(FAVORITE_META_KEY,JSON.stringify(meta||{}));
   try{ updateFavoriteCount(); }catch(e){}
   try{ renderRadar(radarFilter); }catch(e){}
   try{ if(currentSingleFavorite && currentSingleFavorite.market) renderSingleFavorite(currentSingleFavorite.market,currentSingleFavorite.symbol); }catch(e){}
  };
  const onError=function(e){
   console.warn('收藏同步失敗',e);
   const code=String((e&&e.code)||'');
   if(code==='permission-denied'){ disabled=true; setStatus('⚠ 收藏尚未同步（雲端權限未開）',true); }
   else setStatus('⚠ 收藏同步失敗，稍後重試',true);
  };
  async function pushNow(){
   const cloud=window.vcpCloud; if(!cloud||disabled) return;
   const local=readLocal(), meta={};
   local.items.forEach(function(k){ if(local.meta[k]) meta[k]=local.meta[k]; });
   try{
    setStatus('☁ 同步中…');
    await cloud.save({items:local.items,meta:meta,updatedAt:Date.now()});
    localStorage.removeItem(DIRTY_KEY); localStorage.setItem(SYNC_UID_KEY,cloud.uid);
    setStatus('☁ 收藏已同步');
   }catch(e){ onError(e); }
  }
  function schedulePush(){ localStorage.setItem(DIRTY_KEY,'1'); clearTimeout(pushTimer); pushTimer=setTimeout(pushNow,800); }
  async function pullAndMerge(force){
   const cloud=window.vcpCloud; if(!cloud||pulling||disabled) return;
   const now=Date.now(); if(!force && now-lastPull<30000) return; lastPull=now;
   pulling=true;
   try{
    setStatus('☁ 同步中…');
    const remote=await cloud.load();
    const remoteItems=(remote&&Array.isArray(remote.items))?remote.items.map(String).sort():[];
    const remoteMeta=(remote&&remote.meta&&typeof remote.meta==='object')?remote.meta:{};
    const storedUid=localStorage.getItem(SYNC_UID_KEY);
    const local=readLocal();
    if(storedUid && storedUid!==cloud.uid){
     // 這個瀏覽器上一次是別的帳號：不把對方的本機收藏併進來，直接改用目前帳號的雲端收藏
     applyLocal(remoteItems,remoteMeta);
     localStorage.removeItem(DIRTY_KEY); localStorage.setItem(SYNC_UID_KEY,cloud.uid);
     setStatus('☁ 收藏已同步');
    }else if(localStorage.getItem(DIRTY_KEY)==='1'){
     await pushNow();                                   // 本機有尚未上傳的變更：以本機為準
    }else if(remote && storedUid===cloud.uid){
     if(JSON.stringify(remoteItems)!==JSON.stringify(local.items)) applyLocal(remoteItems,remoteMeta);   // 已同步過：以雲端為準（其他裝置的新增／刪除）
     setStatus('☁ 收藏已同步');
    }else{
     const items=[...new Set([...remoteItems,...local.items])].sort();   // 第一次同步：兩邊聯集後上傳
     applyLocal(items,Object.assign({},remoteMeta,local.meta));
     await pushNow();
    }
   }catch(e){ onError(e); }
   finally{ pulling=false; }
  }
  // 收藏有增減時（toggleFavorite 會呼叫 saveFavorites）→ 稍後上傳
  if(typeof saveFavorites==='function'){
   const orig=saveFavorites;
   saveFavorites=function(set){ const r=orig(set); schedulePush(); return r; };
  }
  window.addEventListener('vcp-signed-in',function(){ pullAndMerge(true); });
  if(window.vcpCloud) pullAndMerge(true);
  document.addEventListener('visibilitychange',function(){ if(!document.hidden) pullAndMerge(false); });
  window.addEventListener('online',function(){ if(localStorage.getItem(DIRTY_KEY)==='1'){ disabled=false; schedulePush(); } });
 }catch(e){ console.warn('收藏同步初始化略過',e); }
})();
