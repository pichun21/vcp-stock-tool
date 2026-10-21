/* VCPulse 題材證據標註 v1（2026-10-21）
 * 只做標註，不改變 VCP 分數、題材熱度或排名。
 * 1. 題材雷達：題材名稱下加「證據成熟度」，代表股按鈕加證據等級。
 * 2. 個股分析：在 News Impact 上方加「題材證據」卡片。
 * 資料：data/theme-evidence.json（由 export_themes.py 從題材資料庫 Excel 產生）
 */
(function () {
  'use strict';

  // 雷達題材（既有題材資料庫的名稱）→ 證據表題材。前綴以「：」結尾代表整個大題材。
  var RADAR_MAP = {
    'AI伺服器': ['AI 伺服器：伺服器組裝代工', 'AI 伺服器：機構件（滑軌、機殼）', 'AI 伺服器：散熱與液冷'],
    '液冷': ['AI 伺服器：散熱與液冷'],
    'AI電力基建': ['AI 伺服器：電源與 BBU', 'AI 伺服器：資料中心電力設備（變壓器、GIS）'],
    'CPO/矽光子': ['矽光子／CPO：CPO 封裝與光學引擎', '矽光子／CPO：雷射光源', '矽光子／CPO：光纖耦合／FAU、配線', '矽光子／CPO：光電測試設備', '矽光子／CPO：封裝耦合設備'],
    '高速光通訊': ['矽光子／CPO：高速光通訊模組與元件', '矽光子／CPO：雷射光源', '矽光子／CPO：光纖耦合／FAU、配線'],
    '機器人': ['AI 機器人：'],
    '機器人關鍵零組件': ['AI 機器人：'],
    '先進封裝': ['先進封裝：'],
    '先進封裝供應鏈': ['先進封裝：'],
    'IC載板': ['先進封裝：封裝基板'],
    '低軌衛星': ['次世代通訊：低軌衛星地面設備', '次世代通訊：低軌衛星零組件（PCB、材料、RF、線束）'],
    'AI PCB': ['AI PCB：'],
    '重電/強韌電網': ['重電／電網：電網重電設備（台電強韌電網與海外電力公司）']
  };
  var GRADE_ORDER = ['A', 'B', 'C', 'D', '待核'];

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  function parseLooseDate(s) {
    var m = String(s || '').match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
    if (!m) return null;
    var y = +m[1], mo = m[2] ? +m[2] : 12;
    var d = m[3] ? +m[3] : new Date(y, mo, 0).getDate();
    return new Date(y, mo - 1, d);
  }

  var DATA = null, loading = null;

  function load() {
    if (DATA) return Promise.resolve(DATA);
    if (loading) return loading;
    loading = fetch('data/theme-evidence.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { DATA = j; return j; })
      .catch(function (e) { console.warn('theme evidence unavailable', e); loading = null; return null; });
    return loading;
  }

  function isStale(tag) {
    var d = parseLooseDate(tag && tag.source && tag.source.date);
    if (!d) return true;
    return (Date.now() - d.getTime()) / 86400000 > DATA.rules.staleDays;
  }

  function matchTheme(themeId, patterns) {
    return patterns.some(function (p) { return p.slice(-1) === '：' ? themeId.indexOf(p) === 0 : themeId === p; });
  }

  // 某雷達題材對應到的所有證據列
  function mappedRows(radarTheme) {
    var pats = RADAR_MAP[radarTheme];
    if (!pats || !DATA) return null;
    var out = [];
    Object.keys(DATA.stocks).forEach(function (code) {
      DATA.stocks[code].tags.forEach(function (t) {
        if (matchTheme(t.theme, pats)) out.push({ code: code, tag: t });
      });
    });
    return out;
  }

  function maturity(rows) {
    var formal = DATA.rules.membership.formal, watch = DATA.rules.membership.watch;
    var fCodes = {}, aCodes = {}, wCodes = {};
    rows.forEach(function (r) {
      if (formal.indexOf(r.tag.grade) >= 0) fCodes[r.code] = 1;
      if (r.tag.grade === 'A') aCodes[r.code] = 1;
      if (watch.indexOf(r.tag.grade) >= 0) wCodes[r.code] = 1;
    });
    var f = Object.keys(fCodes).length, a = Object.keys(aCodes).length;
    var L = DATA.rules.maturity.labels, key = 'watching';
    if (f) key = a / f >= DATA.rules.maturity.revenueThreshold ? 'revenue' : 'building';
    return { key: key, label: L[key], formal: f, aCount: a };
  }

  function bestTag(code, rows) {
    var mine = rows.filter(function (r) { return r.code === code; }).map(function (r) { return r.tag; });
    mine.sort(function (a, b) { return GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade); });
    return mine[0] || null;
  }

  var gradeClass = function (g) { return g === 'A' ? 'te-a' : g === 'B' ? 'te-b' : g === 'C' ? 'te-c' : 'te-x'; };

  // ── 1. 題材雷達標註 ──
  function decorateBoard(list) {
    if (!DATA || !list) return;
    list.querySelectorAll('.theme-row').forEach(function (row) {
      if (row.dataset.teDone) return;
      row.dataset.teDone = '1';
      var nameEl = row.querySelector('.theme-name');
      var rows = mappedRows(nameEl ? nameEl.textContent.trim() : '');
      if (!rows) return;  // 這個題材還沒建證據表，不標註
      var m = maturity(rows);
      var sub = row.querySelector('.theme-sub');
      if (sub) {
        sub.insertAdjacentHTML('beforeend',
          '<span class="te-mat te-mat-' + m.key + '" title="證據表：正式成員 ' + m.formal + ' 檔，其中 A 級 ' + m.aCount + ' 檔">' + esc(m.label) + '</span>');
      }
      row.querySelectorAll('.theme-stock-link').forEach(function (btn) {
        var t = bestTag(String(btn.dataset.themeStock || '').toUpperCase(), rows);
        if (t) {
          btn.insertAdjacentHTML('beforeend', '<span class="te-badge ' + gradeClass(t.grade) + '">' + esc(t.grade) + '</span>');
          btn.title = btn.title + '\n證據 ' + t.grade + '｜曝險 ' + t.exposure + '｜' + t.theme.split('：').pop();
        } else {
          btn.insertAdjacentHTML('beforeend', '<span class="te-badge te-none">未查證</span>');
        }
      });
    });
  }

  function watchBoards() {
    ['themeTop5List', 'setupTop5List'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      decorateBoard(el);
      new MutationObserver(function () { decorateBoard(el); }).observe(el, { childList: true });
    });
  }

  // ── 2. 個股題材證據卡 ──
  function ensureCard() {
    var card = document.getElementById('themeEvidenceCard');
    if (card) return card;
    var news = document.getElementById('newsImpactCard');
    if (!news) return null;
    news.insertAdjacentHTML('beforebegin',
      '<div class="card te-card" id="themeEvidenceCard">' +
      '<div class="te-card-head"><div><div class="te-card-title">🧭 題材證據｜這檔為什麼屬於這個題材</div>' +
      '<div class="muted" id="themeEvidenceMeta">台股｜依法說、公告與官網資料整理</div></div></div>' +
      '<div id="themeEvidenceContent"><div class="te-empty">輸入台股代號後，查看題材歸屬的證據與受惠程度。</div></div>' +
      '<div class="te-foot">題材證據是資訊層，不納入 VCP 星等、題材熱度或雷達排名。A＝已量產且營收可驗證；B＝有明確產品；C＝研發或驗證中。</div>' +
      '</div>');
    return document.getElementById('themeEvidenceCard');
  }

  function renderStock(market, symbol) {
    var card = ensureCard();
    if (!card) return;
    var box = document.getElementById('themeEvidenceContent');
    var meta = document.getElementById('themeEvidenceMeta');
    if (String(market || '').toUpperCase() !== 'TW') {
      box.innerHTML = '<div class="te-empty">題材證據目前只整理台股。</div>';
      return;
    }
    var code = String(symbol || '').toUpperCase();
    load().then(function (d) {
      if (!d) { box.innerHTML = '<div class="te-empty">題材證據資料暫時讀取不到。</div>'; return; }
      if (meta) meta.textContent = '台股｜資料版本 ' + d.version + '（' + d.generated + '）';
      var s = d.stocks[code];
      if (!s) {
        box.innerHTML = '<div class="te-empty">這檔還沒建立題材證據。目前已查證 ' + Object.keys(d.stocks).length + ' 檔。</div>';
        return;
      }
      var tags = s.tags.slice().sort(function (a, b) { return GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade); });
      box.innerHTML = tags.map(function (t) {
        var dim = d.rules.membership.excluded.indexOf(t.grade) >= 0;
        var stale = isStale(t);
        var src = t.source.url
          ? '<a href="' + esc(t.source.url) + '" target="_blank" rel="noopener">' + esc(t.source.title) + '</a>'
          : esc(t.source.title || '');
        return '<div class="te-item' + (dim ? ' te-dim' : '') + '">' +
          '<div class="te-item-head"><span class="te-badge ' + gradeClass(t.grade) + '">' + esc(t.grade) + '</span>' +
          '<span class="te-theme">' + esc(t.theme) + '</span>' +
          '<span class="te-expo">曝險 ' + esc(t.exposure) + '</span></div>' +
          '<div class="te-role">' + esc(t.role) + '</div>' +
          '<div class="te-ev">' + esc(t.evidence) + '</div>' +
          (t.exposureNote ? '<div class="te-note">' + esc(t.exposureNote) + '</div>' : '') +
          '<div class="te-src">' + src + '｜' + esc(t.source.date || '日期不明') +
          (stale ? ' <span class="te-stale">資料超過半年，需更新</span>' : '') + '</div>' +
          (dim ? '<div class="te-note">此等級不算族群成員，不會在雷達上標示。</div>' : '') +
          '</div>';
      }).join('');
    });
  }

  // 每次個股分析都會呼叫 renderNewsImpact，借這個時機一起更新
  if (typeof window.renderNewsImpact === 'function') {
    var orig = window.renderNewsImpact;
    window.renderNewsImpact = function (market, symbol) {
      try { renderStock(market, symbol); } catch (e) { console.warn('theme evidence render failed', e); }
      return orig.apply(this, arguments);
    };
  }

  function init() {
    ensureCard();
    load().then(function (d) { if (d) watchBoards(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
