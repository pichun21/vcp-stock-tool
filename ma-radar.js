/* VCPulse 均線雷達（盤中）
 * 資料：data/ma_closes_TW.json（每日正式收盤掃描產生，雷達 200 檔的歷史收盤）＋ data/live_quotes_tw.json（盤中行情快取）
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
  var closes = null, quotes = null, loadError = '', page = 0, timer = null;
  function pageSize() { return st.view === 'full' ? PAGE_FULL : PAGE_COMPACT; }

  function loadState() {
    var base = { type: 'MA', periods: { MA: DEFAULT_PERIODS.MA.slice(), EMA: DEFAULT_PERIODS.EMA.slice() }, conds: ['', '', ''], sort: 'above', view: 'compact' };
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

  /* 回傳 null 代表資料不足。closes 陣列的最後一筆可能已包含「今天」，用昨收對齊後再算。 */
  function calc(type, N, item, q) {
    var c = item.c, L = c.length, price, prev, prevCloses, stale = false;
    if (q && isFinite(q.price) && isFinite(q.prev_close) && q.prev_close > 0) {
      price = Number(q.price); prev = Number(q.prev_close);
      var near = function (a, b) { return Math.abs(a - b) / b < 0.0005; };
      if (near(c[L - 1], prev)) prevCloses = c;
      else if (L >= 2 && near(c[L - 2], prev)) prevCloses = c.slice(0, L - 1);
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
      approx: type === 'EMA' && P < 3 * N, stale: stale, price: price, prev: prev
    };
  }

  function buildRows() {
    var out = [], periods = st.periods[st.type], syms = closes && closes.symbols ? closes.symbols : {};
    Object.keys(syms).forEach(function (sym) {
      var item = syms[sym], q = quotes && quotes.quotes ? quotes.quotes[sym] : null;
      if (!item || !item.c || item.c.length < 30) return;
      var lines = periods.map(function (N) { return calc(st.type, N, item, q); });
      var base = lines.find(function (x) { return x; });
      if (!base) return;
      out.push({
        sym: sym, name: (q && q.name) || item.name || '', price: base.price,
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
  function chipHtml(l, name) {
    if (!l) return '<div class="ma-chip st-na"><span class="ma-n">' + esc(name) + '</span><b>資料不足</b></div>';
    var S = STATES[l.state], approx = !l.hlKnown && (l.state === 'above' || l.state === 'below') ? ' ≈' : '';
    return '<div class="ma-chip ' + S.cls + (l.cross ? ' is-cross' : '') + '"><span class="ma-n">' + esc(name) + (l.approx ? ' ≈' : '') + '</span><b>' +
      S.txt + approx + ' ' + fmtPct(l.bias) + '</b>' + (l.cross ? '<i class="ma-x">★ ' + S.cross + '</i>' : '') + '<em>均線 ' + fmtPrice(l.ma) + '</em></div>';
  }

  var SHORT = { 5: '週', 10: '雙週', 20: '月', 60: '季', 120: '半年', 240: '年' };
  function shortName(type, n) { return (type === 'MA' && SHORT[n]) ? SHORT[n] : type + n; }
  function miniHtml(l, name) {
    if (!l) return '<span class="ma-mini-chip st-na">' + esc(name) + ' —</span>';
    var S = STATES[l.state];
    return '<span class="ma-mini-chip ' + S.cls + (l.cross ? ' is-cross' : '') + '">' + (l.cross ? '★' : '') +
      esc(name) + (l.approx ? '≈' : '') + ' ' + S.txt + Math.abs(l.bias).toFixed(1) + '%</span>';
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
    var asOf = closes.data_date || '', qTime = quotes && (quotes.latest_quote_time || quotes.generated_at) || '';
    var known = all.filter(function (r) { return r.lines.some(function (l) { return l && l.hlKnown; }); }).length;
    summary.innerHTML = '<div>符合 <b>' + rows.length + '</b> / ' + all.length + ' 檔</div>' +
      '<span>均線資料日 ' + esc(asOf) + (qTime ? '｜行情 ' + esc(qTime) : '｜無盤中行情，以最近收盤計算') + '</span>' +
      (all.length && known < all.length * 0.5 ? '<span class="ma-warn">⚠ 尚無今日高低價資料，「站上／均線下」暫以現價判斷（標 ≈），「回測／測壓」暫時無法判斷。</span>' : '');
    if (!rows.length) { list.innerHTML = '<div class="ma-empty">目前沒有符合條件的股票。可以放寬條件，或按「清除條件」。</div>'; pager.hidden = true; return; }
    var html = '';
    var size = pageSize(), totalPages = Math.max(1, Math.ceil(rows.length / size));
    if (page >= totalPages) page = totalPages - 1;
    if (page < 0) page = 0;
    rows.slice(page * size, (page + 1) * size).forEach(function (r) {
      var dir = r.chg > 0 ? 'up' : (r.chg < 0 ? 'down' : 'flat');
      if (st.view === 'full') {
        html += '<div class="ma-row"><div class="ma-id"><b>' + esc(r.name || r.sym) + '</b><span>' + esc(r.sym) + '</span></div>' +
          '<div class="ma-px"><b>' + fmtPrice(r.price) + '</b><span class="chg ' + dir + '">' + fmtPct(r.chg) + '</span></div>' +
          '<div class="ma-lines">' + r.lines.map(function (l, i) { return chipHtml(l, names[i]); }).join('') + '</div></div>';
      } else {
        html += '<div class="ma-crow"><div class="ma-ctop"><span class="ma-cname"><b>' + esc(r.name || r.sym) + '</b><i>' + esc(r.sym) + '</i></span>' +
          '<span class="ma-cpx"><b>' + fmtPrice(r.price) + '</b><span class="chg ' + dir + '">' + fmtPct(r.chg) + '</span></span></div>' +
          '<div class="ma-cchips">' + r.lines.map(function (l, i) { return miniHtml(l, shorts[i]); }).join('') + '</div></div>';
      }
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
  var prevBtn = $('maPrev'), nextBtn = $('maNext'), topBtn = $('maToTop');
  if (prevBtn) prevBtn.addEventListener('click', function () { page -= 1; render(); scrollToEl('maSummary'); });
  if (nextBtn) nextBtn.addEventListener('click', function () { page += 1; render(); scrollToEl('maSummary'); });
  if (topBtn) topBtn.addEventListener('click', function () { scrollToEl('maRadarSection'); });

  /* ---------- 載入 ---------- */
  function getJson(url) {
    return fetch(url + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status); return r.json();
    });
  }
  function load() {
    var p1 = closes ? Promise.resolve(closes) : getJson('data/ma_closes_TW.json').catch(function () { return null; });
    var p2 = getJson('data/live_quotes_tw.json').catch(function () { return null; });
    return Promise.all([p1, p2]).then(function (res) {
      if (res[0] && res[0].symbols) { closes = res[0]; loadError = ''; }
      else if (!closes) loadError = '尚無均線資料：需要等下一次「正式收盤掃描」跑完，才會產生 data/ma_closes_TW.json。';
      if (res[1] && res[1].quotes) quotes = res[1];
      render();
    });
  }
  function start() {
    syncControls(); render(); load();
    if (timer) clearInterval(timer);
    timer = setInterval(function () { if (!document.hidden) load(); }, 120000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }

  window.VCPMaRadar = { calc: calc, lineName: lineName };   // 供測試使用
  start();
})();
