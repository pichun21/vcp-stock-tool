/* VCPulse 均線雷達（盤中）— 掃描整個台股（上市＋上櫃），和 VCP 完全無關
 * 資料：data/ma_closes_TW.json（每日正式收盤掃描產生，全市場歷史收盤）＋ data/live_quotes_all_tw.json（全市場盤中行情，極簡格式）
 *       找不到全市場行情時，退回 data/live_quotes_tw.json（雷達 200 檔）
 * 在瀏覽器裡用「昨日以前的收盤價＋目前價」計算 MA／EMA，不使用任何外部 API，也不消耗 FinMind 額度。
 * 以「今天這根 K 棒」和均線的位置關係分成 6 種狀態（盤中狀態，收盤才算數）：
 *   站上：現價在均線上方，且今日最低價也在均線上方（整根在上面）
 *   突破：昨收在均線下方、現價在均線上方（K 棒穿過去；低點在均線上或下都算，例如跳空）
 *   回測：現價在均線上方，但今日低點碰到／跌到均線
 *   跌破：昨收在均線上方、現價在均線下方（K 棒穿下去）
 *   均線下：現價在均線下方，且今日最高價也在均線下方（整根在下面）
 *   測壓：現價在均線下方，但今日高點碰到／漲到均線 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  if (!$('maRadarSection')) return;

  var KEY = 'vcpMaRadarV1';
  var PAGE_FULL = 20, PAGE_COMPACT = 30;
  var AV_OPTIONS = [0, 1000, 3000, 10000, 30000];   // 近 20 日平均成交值（萬元）
  var DEFAULT_PERIODS = { MA: [20, 60, 240], EMA: [23, 67, 240] };
  var STATES = {
    above:  { txt: '站上',   cls: 'st-above',  cross: '',          up: true  },
    'break': { txt: '突破',   cls: 'st-above',  cross: '今天穿過去', up: true  },
    retest: { txt: '回測',   cls: 'st-retest', cross: '',          up: true  },
    fall:   { txt: '跌破',   cls: 'st-below',  cross: '今天穿下去', up: false },
    below:  { txt: '均線下', cls: 'st-below',  cross: '',          up: false },
    probe:  { txt: '測壓',   cls: 'st-probe',  cross: '',          up: false }
  };
  var COND_LABEL = { '': '不限', above: '站上', 'break': '突破', retest: '回測', fall: '跌破', below: '均線下', probe: '測壓' };
  var OLD_COND = { up: 'break', down: 'fall' };   // 舊版設定轉換
  var SORT_LABEL = { above: '現價在均線上的條數（多→少）', chg: '今日漲幅（高→低）', bias1: '離第 1 條線最近' };

  var st = loadState();
  var closesHasAv = true, closes = null, quotes = null, quotesRadar = null, qmap = {}, radarSet = {}, loadError = '', page = 0, timer = null, started = false;
  function pageSize() { return st.view === 'full' ? PAGE_FULL : PAGE_COMPACT; }

  function loadState() {
    var base = { type: 'MA', periods: { MA: DEFAULT_PERIODS.MA.slice(), EMA: DEFAULT_PERIODS.EMA.slice() }, conds: ['', '', ''], sort: 'above', view: 'compact', scope: 'all', minAv: 3000 };
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && (s.type === 'MA' || s.type === 'EMA')) {
        base.type = s.type;
        ['MA', 'EMA'].forEach(function (t) {
          if (s.periods && Array.isArray(s.periods[t]) && s.periods[t].length === 3) {
            base.periods[t] = s.periods[t].map(function (n, i) { return cleanPeriod(n, DEFAULT_PERIODS[t][i]); });
          }
        });
        if (Array.isArray(s.conds) && s.conds.length === 3) base.conds = s.conds.map(function (c) { c = OLD_COND[c] || c; return COND_LABEL.hasOwnProperty(c) ? c : ''; });
        if (SORT_LABEL[s.sort]) base.sort = s.sort;
        if (s.view === 'full' || s.view === 'compact') base.view = s.view;
        if (s.scope === 'all' || s.scope === 'radar') base.scope = s.scope;
        if (AV_OPTIONS.indexOf(Number(s.minAv)) >= 0) base.minAv = Number(s.minAv);
      }
    } catch (e) { /* 忽略 */ }
    return base;
  }
  function saveState() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* 忽略 */ } }
  function cleanPeriod(n, fallback) {
    n = Math.round(Number(n));
    return (isFinite(n) && n >= 2 && n <= 300) ? n : fallback;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* ---------- 計算 ---------- */
  var NAMED = { 5: '週線', 10: '雙週線', 20: '月線', 60: '季線', 120: '半年線', 240: '年線' };
  function lineName(type, n) { return (type === 'MA' && NAMED[n]) ? NAMED[n] + ' MA' + n : type + n; }

  /* 今日高低價：優先用盤中行情（high／low）；沒有時，若均線檔最後一根就是今天（收盤後），用掃描存的最後一根高低；
   * 都沒有就回傳 known=false，狀態只能用現價判斷（站上／均線下會顯示「≈」）。 */
  function dayHL(item, q, price) {
    var hi = null, lo = null;
    if (q && isFinite(q.high) && isFinite(q.low) && q.high > 0 && q.low > 0) { hi = Number(q.high); lo = Number(q.low); }
    else if (item.hl && item.hl.length === 2 && (!q || !q.data_date || q.data_date === item.last || q.data_date === (closes && closes.data_date))) {
      hi = Number(item.hl[0]); lo = Number(item.hl[1]);
    }
    if (hi === null || lo === null || !isFinite(hi) || !isFinite(lo)) return { hi: price, lo: price, known: false };
    return { hi: Math.max(hi, price), lo: Math.min(lo, price), known: true };
  }

  /* 上一個「平日」（不含國定假日判斷）；均線檔的資料日若比它還舊，代表缺了至少一根收盤 */
  function prevWeekday(ds) {
    var t = new Date(ds + 'T00:00:00Z'); if (isNaN(t)) return '';
    do { t = new Date(t.getTime() - 86400000); } while (t.getUTCDay() === 0 || t.getUTCDay() === 6);
    return t.toISOString().slice(0, 10);
  }
  function gapMissing(q) {
    var qd = q && q.data_date, cd = closes && closes.data_date;
    if (!qd || !cd) return false;
    return cd < prevWeekday(qd);
  }

  /* 回傳 null 代表資料不足。closes 陣列的最後一筆可能已包含「今天」，用昨收對齊後再算。 */
  function calc(type, N, item, q) {
    var c = item.c, L = c.length, price, prev, prevCloses, stale = false, filled = false;
    if (q && isFinite(q.price) && isFinite(q.prev_close) && q.prev_close > 0) {
      price = Number(q.price); prev = Number(q.prev_close);
      var near = function (a, b) { return Math.abs(a - b) / b < 0.0005; };
      if (near(c[L - 1], prev)) prevCloses = c;
      else if (L >= 2 && near(c[L - 2], prev)) prevCloses = c.slice(0, L - 1);
      else if (gapMissing(q)) { prevCloses = c.concat([prev]); filled = true; }   // 均線檔缺了昨天的收盤：用行情的昨收補一根
      else { prevCloses = c; stale = true; }
    } else {
      if (L < 3) return null;
      price = c[L - 1]; prev = c[L - 2]; prevCloses = c.slice(0, L - 1);
    }
    var P = prevCloses.length;
    if (P < N) return null;
    var prevMa, nowMa;
    if (type === 'MA') {
      var s = 0, i;
      for (i = P - N + 1; i < P; i++) s += prevCloses[i];          // 最近 N-1 個「昨日以前」收盤
      nowMa = (s + price) / N;
      prevMa = (s + prevCloses[P - N]) / N;                        // 到昨收為止的 N 日均線
    } else {
      var a = 2 / (N + 1), e = prevCloses[0];
      for (i = 1; i < P; i++) e = a * prevCloses[i] + (1 - a) * e;
      prevMa = e; nowMa = a * price + (1 - a) * e;
    }
    var prevAbove = prevCloses[P - 1] > prevMa, above = price > nowMa;
    var hl = dayHL(item, q, price), state;
    if (above) state = !prevAbove ? 'break' : (hl.lo > nowMa ? 'above' : 'retest');
    else state = prevAbove ? 'fall' : (hl.hi < nowMa ? 'below' : 'probe');
    return {
      ma: nowMa, bias: (price / nowMa - 1) * 100, state: state, up: STATES[state].up,
      cross: state === 'break' || state === 'fall', hlKnown: hl.known,
      approx: type === 'EMA' && P < 3 * N, stale: stale, filled: filled, price: price, prev: prev
    };
  }

  /* 把兩種行情檔整理成 qmap[代號] = {price, prev_close, high, low, data_date, name} */
  function buildQuoteMap() {
    qmap = {}; radarSet = {};
    if (quotes && quotes.quotes) {
      var date = (quotes.data_dates && quotes.data_dates.length) ? quotes.data_dates[quotes.data_dates.length - 1] : '';
      Object.keys(quotes.quotes).forEach(function (sym) {
        var v = quotes.quotes[sym];
        if (Array.isArray(v)) qmap[sym] = { price: v[0], prev_close: v[1], high: v[2], low: v[3], data_date: date };
        else if (v) qmap[sym] = v;
      });
    }
    if (quotesRadar && quotesRadar.quotes) {
      Object.keys(quotesRadar.quotes).forEach(function (sym) {
        radarSet[sym] = true;
        var v = quotesRadar.quotes[sym];
        if (v && (!qmap[sym] || !isFinite(qmap[sym].price))) qmap[sym] = v;
        else if (v && qmap[sym] && v.name) qmap[sym].name = v.name;
      });
    }
  }

  function buildRows() {
    var out = [], periods = st.periods[st.type], syms = closes && closes.symbols ? closes.symbols : {};
    Object.keys(syms).forEach(function (sym) {
      var item = syms[sym], q = qmap[sym] || null;
      if (!item || !item.c || item.c.length < 30) return;
      if (st.scope === 'radar' && !radarSet[sym]) return;
      if (st.minAv > 0 && closesHasAv && !(Number(item.av) >= st.minAv)) return;
      var lines = periods.map(function (N) { return calc(st.type, N, item, q); });
      var base = lines.find(function (x) { return x; });
      if (!base) return;
      out.push({
        sym: sym, name: (q && q.name) || item.name || '', ind: item.ind || '', price: base.price,
        chg: base.prev > 0 ? (base.price / base.prev - 1) * 100 : 0, lines: lines, live: !!q
      });
    });
    return out;
  }

  function passes(row) {
    for (var i = 0; i < 3; i++) {
      var cond = st.conds[i]; if (!cond) continue;
      var l = row.lines[i]; if (!l || l.state !== cond) return false;
    }
    return true;
  }
  function sortRows(rows) {
    var cnt = function (r) { return r.lines.filter(function (l) { return l && l.up; }).length; };
    rows.sort(function (a, b) {
      if (st.sort === 'chg') return b.chg - a.chg;
      if (st.sort === 'bias1') {
        var x = a.lines[0] ? Math.abs(a.lines[0].bias) : 1e9, y = b.lines[0] ? Math.abs(b.lines[0].bias) : 1e9;
        return x - y;
      }
      return (cnt(b) - cnt(a)) || (b.chg - a.chg);
    });
    return rows;
  }

  /* ---------- 畫面 ---------- */
  function fmtPct(v) { return (v > 0 ? '+' : '') + v.toFixed(1) + '%'; }
  function fmtPrice(v) { return v >= 1000 ? v.toFixed(0) : v.toFixed(2); }
  /* ---------- 卡片視覺設定（只影響畫面，不回寫任何訊號判斷）----------
     strongPct：站上乖離 ≥ 此值顯示「強勢站上」配色
     barCapPct：強度線滿格對應的乖離；超過一律畫滿，原始百分比照常完整顯示 */
  var UI_LEVELS = { strongPct: 30, barCapPct: 60 };
  function barPct(l) { return Math.max(4, Math.min(100, Math.abs(l.bias) / UI_LEVELS.barCapPct * 100)).toFixed(0); }
  function toneCls(l) {
    if (!l) return 'tn-na';
    if (l.state === 'break') return 'tn-break';
    if (l.state === 'above') return Math.abs(l.bias) >= UI_LEVELS.strongPct ? 'tn-strong' : 'tn-above';
    return 'tn-' + l.state;   // retest／fall／below／probe
  }
  /* 左側狀態線：沿用第 1 條均線（月線，也是排序「離第 1 條線最近」的基準線）的狀態，不另訂優先規則 */
  function edgeCls(r) {
    var l = r.lines[0]; if (!l) return 'ed-na';
    if (l.state === 'above') return 'ed-above';
    if (l.state === 'break') return 'ed-break';
    if (l.state === 'retest') return 'ed-retest';
    return 'ed-other';
  }
  function isFav(sym) {
    try { return typeof getFavorites === 'function' && getFavorites().has('TW:' + String(sym).toUpperCase()); } catch (e) { return false; }
  }
  function favBtn(r) {
    var on = isFav(r.sym);
    return '<button type="button" class="ma-fav' + (on ? ' is-on' : '') + '" data-ma-fav="' + esc(r.sym) + '" aria-pressed="' + on + '" aria-label="' + (on ? '取消收藏 ' : '收藏 ') + esc(r.name || r.sym) + '" title="' + (on ? '取消收藏' : '收藏') + '">' + (on ? '★' : '☆') + '</button>';
  }
  function tagHtml(l, label, full) {
    if (!l) return '<div class="ma-tag tn-na"><span class="ma-tl">' + esc(label) + '</span><span class="ma-ts">資料不足</span></div>';
    var S = STATES[l.state], approx = !l.hlKnown && (l.state === 'above' || l.state === 'below') ? '≈' : '';
    var star = l.cross && l.up ? '★ ' : '';
    var title = label + ' ' + S.txt + ' ' + fmtPct(l.bias) + '｜均線 ' + fmtPrice(l.ma) + (l.cross ? '｜' + S.cross : '');
    var bar = (l.state === 'above' || l.state === 'retest') ? '<i class="ma-bar"><i style="width:' + barPct(l) + '%"></i></i>' : '';
    return '<div class="ma-tag ' + toneCls(l) + '" title="' + esc(title) + '">' +
      '<span class="ma-tl">' + star + esc(label) + (l.approx ? '≈' : '') + '</span>' +
      '<span class="ma-ts">' + S.txt + approx + '</span>' +
      '<b class="ma-tv">' + Math.abs(l.bias).toFixed(1) + '%</b>' + bar +
      (full ? '<em class="ma-tm">均線 ' + fmtPrice(l.ma) + (l.cross ? '｜' + S.cross : '') + '</em>' : '') + '</div>';
  }
  function cardHtml(r, labels, full) {
    var dir = r.chg > 0 ? 'up' : (r.chg < 0 ? 'down' : 'flat'), last = r.sym === lastSym;
    return '<div class="ma-card ' + edgeCls(r) + (last ? ' ma-last' : '') + '" data-ma-sym="' + esc(r.sym) + '">' +
      '<div class="ma-top"><div class="ma-who"><button type="button" class="ma-open" data-ma-open="' + esc(r.sym) + '">' + esc(r.name || r.sym) + '</button>' +
      '<span class="ma-code">' + esc(r.sym) + '</span>' + (last ? '<span class="ma-last-tag">剛剛看過</span>' : '') + '</div>' +
      '<div class="ma-quote"><b>' + fmtPrice(r.price) + '</b><span class="chg ' + dir + '">' + fmtPct(r.chg) + '</span></div>' + favBtn(r) + '</div>' +
      '<div class="ma-tags">' + r.lines.map(function (l, i) { return tagHtml(l, labels[i], full); }).join('') + '</div></div>';
  }

  var SHORT = { 5: '週', 10: '雙週', 20: '月', 60: '季', 120: '半年', 240: '年' };
  function shortName(type, n) { return (type === 'MA' && SHORT[n]) ? SHORT[n] : type + n; }

  /* 各均線的狀態分布（全部 200 檔，不受篩選影響）：用來判斷「突破很少」是正常還是資料有問題 */
  function renderDist(all, names) {
    var box = $('maDist'); if (!box) return;
    var order = ['above', 'break', 'retest', 'fall', 'below', 'probe'];
    var rows = names.map(function (nm, i) {
      var cnt = { above: 0, 'break': 0, retest: 0, fall: 0, below: 0, probe: 0 }, n = 0;
      all.forEach(function (r) { var l = r.lines[i]; if (l) { cnt[l.state]++; n++; } });
      return '<tr><th>' + esc(nm) + '</th>' + order.map(function (k) { return '<td' + (k === 'break' || k === 'fall' ? ' class="hl"' : '') + '>' + cnt[k] + '</td>'; }).join('') + '<td>' + n + '</td></tr>';
    }).join('');
    box.innerHTML = '<details><summary>各均線的狀態分布（共 ' + all.length + ' 檔，不受篩選影響）</summary>' +
      '<div class="ma-dist-wrap"><table><thead><tr><th></th>' + order.map(function (k) { return '<th>' + STATES[k].txt + '</th>'; }).join('') + '<th>合計</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (st.scope === 'radar' ? '<p>目前只看 VCP 雷達那 200 檔，這些是趨勢向上的股票，大多早就在均線上方，所以「突破」本來就不會多。想掃全市場，請把「範圍」改成「全台股」。</p>' : '<p>範圍是全台股（依你設定的成交值門檻過濾）。</p>') + '</details>';
  }

  /* ---------- 資料健康檢查：盤中時一眼確認資料是否正常 ---------- */
  function taipeiNow() {
    var p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()), o = {};
    p.forEach(function (x) { o[x.type] = x.value; });
    return { wd: o.weekday, date: o.year + '-' + o.month + '-' + o.day, min: (+o.hour % 24) * 60 + (+o.minute) };
  }
  function healthHtml(all, known, liveN) {
    var n = taipeiNow(), total = all.length || 1;
    var inSession = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].indexOf(n.wd) >= 0 && n.min >= 540 && n.min <= 815;
    var gen = quotes && quotes.generated_at || '', delay = null, qDate = '';
    var m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(gen);
    if (m) { qDate = m[1]; if (m[1] === n.date) delay = n.min - (+m[2] * 60 + +m[3]); }
    var livePct = liveN / total * 100, hlPct = known / total * 100;
    var items = [], bad = false;
    function add(ok, txt) { items.push((ok ? '✅ ' : '⚠️ ') + txt); if (!ok) bad = true; }
    var cd = closes && closes.data_date || '', qd2 = quotes && quotes.data_dates && quotes.data_dates.length ? quotes.data_dates[quotes.data_dates.length - 1] : (m ? m[1] : '');
    if (cd && qd2) {
      var need = prevWeekday(qd2), okc = cd >= need;
      if (!okc || inSession) add(okc, okc ? '均線資料日 ' + esc(cd) + '（已含上一個交易日收盤）' : '均線資料日 ' + esc(cd) + ' 比應有的 ' + esc(need) + ' 舊，缺收盤資料（已暫用昨收補一根；請到 Actions 檢查「正式收盤掃描」）');
    }
    if (!quotes) { items.push('⚠️ 沒有盤中行情檔，目前以最近收盤計算'); bad = inSession; }
    else if (inSession) {
      add(delay !== null && delay <= 25, delay === null ? '行情是舊的（' + esc(gen || '無時間') + '，不是今天）' : '行情約 ' + Math.max(delay, 0) + ' 分鐘前更新（正常 ≤ 25 分）');
      add(livePct >= 85, '有盤中價 ' + liveN + '/' + all.length + '（' + livePct.toFixed(0) + '%，正常 ≥ 85%）');
      add(hlPct >= 80, '有今日高低價 ' + known + '/' + all.length + '（' + hlPct.toFixed(0) + '%，正常 ≥ 80%）');
    } else {
      items.push('ℹ️ 非盤中時段（週一至週五 09:00–13:35 才會更新）；目前行情時間 ' + esc(gen || '—') + '，以最近一次資料計算');
    }
    return '<div class="ma-health' + (bad ? ' is-bad' : '') + '"><b>資料健康檢查</b>' + items.map(function (t) { return '<span>' + t + '</span>'; }).join('') + '</div>';
  }

  function render() {
    var list = $('maList'), summary = $('maSummary'), pager = $('maPager');
    var periods = st.periods[st.type];
    if (loadError) {
      list.innerHTML = '<div class="ma-empty">' + esc(loadError) + '</div>'; summary.textContent = ''; pager.hidden = true; return;
    }
    if (!closes) { list.innerHTML = '<div class="ma-empty">載入中…</div>'; pager.hidden = true; return; }
    var all = buildRows(), rows = sortRows(all.filter(passes));
    var names = periods.map(function (n) { return lineName(st.type, n); });
    var shorts = periods.map(function (n) { return shortName(st.type, n); });
    list.className = 'ma-list' + (st.view === 'full' ? '' : ' is-compact');
    renderDist(all, names);
    var asOf = closes.data_date || '', qTime = quotes && (quotes.latest_quote_time || quotes.generated_at) || '';
    var known = all.filter(function (r) { return r.lines.some(function (l) { return l && l.hlKnown; }); }).length;
    var liveN = all.filter(function (r) { return r.live; }).length;
    var hb = $('maHealth'); if (hb) hb.innerHTML = healthHtml(all, known, liveN);
    var oldFile = !closesHasAv || (closes.scope && closes.scope !== 'all') || (closes.count && closes.count < 500);
    summary.innerHTML = '<div>符合 <b>' + rows.length + '</b> / ' + all.length + ' 檔' + (st.scope === 'radar' ? '（僅 VCP 雷達）' : '（全台股）') + '</div>' +
      '<span>均線資料日 ' + esc(asOf) + (qTime ? '｜行情 ' + esc(qTime) + '（' + liveN + ' 檔有盤中價）' : '｜無盤中行情，以最近收盤計算') + '</span>' +
      (oldFile ? '<span class="ma-warn">⚠ 目前的均線資料檔還是舊版（只含 VCP 雷達約 ' + (closes.count || '200') + ' 檔、沒有成交值），請重新跑一次「正式收盤掃描」產生全台股資料檔；在那之前成交值門檻不會套用。</span>' : '') +
      (all.length && known < all.length * 0.5 ? '<span class="ma-warn">⚠ 尚無今日高低價資料，「站上／均線下」暫以現價判斷（標 ≈），「回測／測壓」暫時無法判斷。</span>' : '');
    if (!rows.length) { list.innerHTML = '<div class="ma-empty">目前沒有符合條件的股票。可以放寬條件，或按「清除條件」。</div>'; pager.hidden = true; return; }
    var html = '';
    var size = pageSize(), totalPages = Math.max(1, Math.ceil(rows.length / size));
    if (page >= totalPages) page = totalPages - 1;
    if (page < 0) page = 0;
    rows.slice(page * size, (page + 1) * size).forEach(function (r) {
      html += cardHtml(r, st.view === 'full' ? names : shorts, st.view === 'full');
    });
    list.innerHTML = html;
    pager.hidden = false;
    $('maPageInfo').textContent = '第 ' + (page + 1) + ' / ' + totalPages + ' 頁（共 ' + rows.length + ' 檔）';
    $('maPrev').disabled = page <= 0;
    $('maNext').disabled = page >= totalPages - 1;
  }

  function syncControls() {
    var periods = st.periods[st.type];
    document.querySelectorAll('[data-matype]').forEach(function (b) {
      var on = b.getAttribute('data-matype') === st.type; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    for (var i = 0; i < 3; i++) {
      var inp = $('maP' + i); if (inp && document.activeElement !== inp) inp.value = periods[i];
      var sel = $('maC' + i);
      if (sel) {
        var nm = lineName(st.type, periods[i]);
        sel.innerHTML = Object.keys(COND_LABEL).map(function (k) { return '<option value="' + k + '">' + COND_LABEL[k] + '</option>'; }).join('');
        sel.value = st.conds[i]; sel.setAttribute('aria-label', nm + ' 條件');
      }
      var lab = $('maL' + i); if (lab) lab.textContent = '第 ' + (i + 1) + ' 線 ' + lineName(st.type, periods[i]);
    }
    var so = $('maSort'); if (so) so.value = st.sort;
    var av = $('maAv'); if (av) av.value = String(st.minAv);
    document.querySelectorAll('[data-mascope]').forEach(function (b) {
      var on = b.getAttribute('data-mascope') === st.scope; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.querySelectorAll('[data-maview]').forEach(function (b) {
      var on = b.getAttribute('data-maview') === st.view; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var names = periods.map(function (n) { return lineName(st.type, n); });
    var pr = {
      all: document.querySelector('[data-mapreset="all"]'), up1: document.querySelector('[data-mapreset="up1"]'),
      up2: document.querySelector('[data-mapreset="up2"]'), up3: document.querySelector('[data-mapreset="up3"]'),
      down1: document.querySelector('[data-mapreset="down1"]')
    };
    if (pr.all) pr.all.textContent = '三線都站上';
    if (pr.up1) pr.up1.textContent = '突破' + names[0];
    if (pr.up2) pr.up2.textContent = '突破' + names[1];
    if (pr.up3) pr.up3.textContent = '突破' + names[2];
    if (pr.down1) pr.down1.textContent = '跌破' + names[0];
  }

  function changed() { page = 0; saveState(); syncControls(); render(); }

  /* ---------- 事件 ---------- */
  document.querySelectorAll('[data-matype]').forEach(function (b) {
    b.addEventListener('click', function () { st.type = b.getAttribute('data-matype'); changed(); });
  });
  [0, 1, 2].forEach(function (i) {
    var inp = $('maP' + i);
    if (inp) inp.addEventListener('change', function () {
      st.periods[st.type][i] = cleanPeriod(inp.value, st.periods[st.type][i]); changed();
    });
    var sel = $('maC' + i);
    if (sel) sel.addEventListener('change', function () { st.conds[i] = sel.value; changed(); });
  });
  document.querySelectorAll('[data-maview]').forEach(function (b) {
    b.addEventListener('click', function () { st.view = b.getAttribute('data-maview'); changed(); });
  });
  document.querySelectorAll('[data-mascope]').forEach(function (b) {
    b.addEventListener('click', function () { st.scope = b.getAttribute('data-mascope'); changed(); });
  });
  var avSel = $('maAv'); if (avSel) avSel.addEventListener('change', function () { st.minAv = Number(avSel.value) || 0; changed(); });
  var sortSel = $('maSort'); if (sortSel) sortSel.addEventListener('change', function () { st.sort = sortSel.value; changed(); });
  var resetP = $('maPReset'); if (resetP) resetP.addEventListener('click', function () { st.periods[st.type] = DEFAULT_PERIODS[st.type].slice(); changed(); });
  var presets = { all: ['above', 'above', 'above'], up1: ['break', '', ''], up2: ['', 'break', ''], up3: ['', '', 'break'], down1: ['fall', '', ''], clear: ['', '', ''] };
  document.querySelectorAll('[data-mapreset]').forEach(function (b) {
    b.addEventListener('click', function () { var p = presets[b.getAttribute('data-mapreset')]; if (p) { st.conds = p.slice(); changed(); } });
  });
  function scrollToEl(id) {
    var el = $(id); if (!el) return;
    var off = (window.__stickyOffset ? window.__stickyOffset() : 0) + 10;
    var y = el.getBoundingClientRect().top + (window.pageYOffset || document.documentElement.scrollTop || 0) - off;
    window.scrollTo(0, Math.max(0, y));
  }
  /* ---------- 點股票名稱 → 單股查詢；返回時回到原本頁碼並標示剛剛那一檔 ---------- */
  var lastSym = '', returnState = null;
  var listEl = $('maList');
  if (listEl) listEl.addEventListener('click', function (e) {
    var f = e.target.closest && e.target.closest('[data-ma-fav]');
    if (f) { e.preventDefault(); e.stopPropagation(); toggleFav(f); return; }
    var b = e.target.closest && e.target.closest('[data-ma-open]');
    if (b) openStock(b.getAttribute('data-ma-open'));
  });
  /* 收藏：直接沿用網站既有的 toggleFavorite（同一份本機收藏＋登入後的雲端同步），不另建資料 */
  function toggleFav(btn) {
    if (typeof toggleFavorite !== 'function') return;
    var sym = btn.getAttribute('data-ma-fav'), row = null;
    buildRows().some(function (r) { if (r.sym === sym) { row = r; return true; } return false; });
    try { toggleFavorite('TW', sym, row ? { market: 'TW', symbol: sym, name: row.name, _fav_src: 'ma' } : { market: 'TW', symbol: sym, _fav_src: 'ma' }); }
    catch (e) { console.warn('收藏失敗', e); }
    render();   // 依實際儲存結果重畫星號
    var nb = listEl && listEl.querySelector('[data-ma-fav="' + sym + '"]');
    if (nb) { nb.classList.add('pop'); nb.focus({ preventScroll: true }); }
  }
  // 雲端同步把其他裝置的收藏拉下來時，網站會呼叫 renderRadar；順便重畫均線雷達的星號
  if (typeof renderRadar === 'function') {
    var origRR = renderRadar;
    window.renderRadar = renderRadar = function () { var out = origRR.apply(this, arguments); if (closes) { try { render(); } catch (e) { /* 忽略 */ } } return out; };
  }
  function openStock(sym) {
    if (!sym || typeof run !== 'function') return;
    lastSym = sym;
    returnState = { sym: sym, page: page, scrollY: window.pageYOffset || document.documentElement.scrollTop || 0 };
    render();
    var back = $('radarBackFloat');
    if (back) { back.hidden = false; back.textContent = '← 返回均線雷達'; back.setAttribute('onclick', 'VCPMaRadar.back()'); }
    try { if (String(currentMarket || '').toUpperCase() !== 'TW') setMarket('TW', { reset: false }); } catch (err) { /* 忽略 */ }
    var input = $('symbol'); if (!input) return;
    input.value = sym;
    var sec = input.closest('.section') || input;
    try { sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (err) { sec.scrollIntoView(); }
    run();
  }
  function goBack() {
    var back = $('radarBackFloat'); if (back) back.hidden = true;
    if (!returnState) return;
    var saved = returnState;
    // 資料每 2 分鐘會更新，排序可能變動：優先找出這檔目前所在的頁
    var rows = sortRows(buildRows().filter(passes)), size = pageSize();
    var idx = rows.findIndex(function (r) { return r.sym === saved.sym; });
    page = idx >= 0 ? Math.floor(idx / size) : saved.page;
    render();
    var target = listEl && listEl.querySelector('[data-ma-sym="' + saved.sym.replace(/"/g, '') + '"]');
    if (target) {
      try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (err) { target.scrollIntoView(); }
      target.classList.remove('radar-return-highlight-3s'); void target.offsetWidth;
      target.classList.add('radar-return-highlight-3s');
      setTimeout(function () { target.classList.remove('radar-return-highlight-3s'); }, 3000);
    } else {
      try { window.scrollTo({ top: saved.scrollY, behavior: 'smooth' }); } catch (err) { window.scrollTo(0, saved.scrollY); }
    }
  }

  var prevBtn = $('maPrev'), nextBtn = $('maNext'), topBtn = $('maToTop');
  if (prevBtn) prevBtn.addEventListener('click', function () { page -= 1; render(); scrollToEl('maSummary'); });
  if (nextBtn) nextBtn.addEventListener('click', function () { page += 1; render(); scrollToEl('maSummary'); });
  if (topBtn) topBtn.addEventListener('click', function () { scrollToEl('maRadarSection'); });

  /* ---------- 載入（捲到這個區塊附近才開始載入，避免拖慢首頁） ---------- */
  function getJson(url) {
    return fetch(url + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status); return r.json();
    });
  }
  function load() {
    var p1 = closes ? Promise.resolve(closes) : getJson('data/ma_closes_TW.json').catch(function () { return null; });
    var p2 = getJson('data/live_quotes_all_tw.json').catch(function () { return null; });
    var p3 = getJson('data/live_quotes_tw.json').catch(function () { return null; });
    return Promise.all([p1, p2, p3]).then(function (res) {
      if (res[0] && res[0].symbols) {
        closes = res[0]; loadError = '';
        closesHasAv = Object.keys(closes.symbols).some(function (k) { return closes.symbols[k] && closes.symbols[k].av != null; });
      }
      else if (!closes) loadError = '尚無均線資料：需要等下一次「正式收盤掃描」跑完，才會產生 data/ma_closes_TW.json。';
      if (res[1] && res[1].quotes) quotes = res[1];
      if (res[2] && res[2].quotes) quotesRadar = res[2];
      buildQuoteMap();
      render();
    });
  }
  function begin() {
    if (started) return; started = true;
    load();
    timer = setInterval(function () { if (!document.hidden) load(); }, 120000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && started) load(); });
  }
  function start() {
    syncControls(); render();
    var sec = $('maRadarSection');
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) {
        if (es.some(function (e) { return e.isIntersecting; })) { io.disconnect(); begin(); }
      }, { rootMargin: '800px 0px' });
      io.observe(sec);
    } else begin();
    window.addEventListener('hashchange', begin);
    document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('[data-guide="ma"]')) begin(); });
  }

  window.VCPMaRadar = { calc: calc, lineName: lineName, back: goBack };   // 供測試使用
  start();
})();
