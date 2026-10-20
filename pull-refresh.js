/* VCPulse 手機版「下拉重新整理」
   只在「加入主畫面」的 App 模式（standalone）啟用：一般 Safari／Chrome 本來就有內建下拉重新整理，
   這裡不重複處理，避免兩個一起觸發。 */
(function () {
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  var touch = 'ontouchstart' in window;
  if (!standalone || !touch) return;

  var TRIGGER = 70;      // 下拉超過這個距離（px）放開才重新整理
  var MAX = 110;         // 指示圖示最多跟著往下移動的距離
  var startY = 0, startX = 0, dist = 0, pulling = false, armed = false, busy = false;

  var css = document.createElement('style');
  css.textContent =
    '.ptr{position:fixed;left:50%;top:0;z-index:9999;width:40px;height:40px;margin-left:-20px;border-radius:50%;' +
    'background:#fff;border:1px solid #E6DCCB;box-shadow:0 4px 14px rgba(80,64,40,.15);display:grid;place-items:center;' +
    'transform:translateY(-60px);opacity:0;pointer-events:none;transition:transform .2s ease,opacity .2s ease}' +
    '.ptr.dragging{transition:none}' +
    '.ptr svg{width:20px;height:20px;color:#C77B59;transition:transform .15s ease}' +
    '.ptr.ready svg{transform:rotate(180deg)}' +
    '.ptr.loading svg{animation:ptrSpin .8s linear infinite}' +
    '@keyframes ptrSpin{to{transform:rotate(360deg)}}';
  document.head.appendChild(css);

  var el = document.createElement('div');
  el.className = 'ptr';
  el.setAttribute('aria-hidden', 'true');
  var ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
  var SPIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>';
  el.innerHTML = ARROW;
  document.body.appendChild(el);

  function atTop() { return (window.pageYOffset || document.documentElement.scrollTop || 0) <= 0; }
  // 在可以自己捲動的區塊（表格、橫向清單、展開的視窗）裡拖曳時不觸發
  function inScroller(t) {
    for (var n = t; n && n !== document.body; n = n.parentElement) {
      if (n.scrollTop > 0) return true;
      var tag = n.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    }
    return false;
  }
  function show(d) {
    var y = Math.min(MAX, d) - 50;
    el.style.transform = 'translateY(' + y + 'px)';
    el.style.opacity = String(Math.min(1, d / 40));
  }
  function reset() {
    el.classList.remove('dragging', 'ready');
    el.style.transform = ''; el.style.opacity = '';
  }

  document.addEventListener('touchstart', function (e) {
    if (busy || e.touches.length !== 1 || !atTop() || inScroller(e.target)) { pulling = false; return; }
    startY = e.touches[0].clientY; startX = e.touches[0].clientX; dist = 0; pulling = true; armed = false;
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (!pulling) return;
    var dy = e.touches[0].clientY - startY, dx = Math.abs(e.touches[0].clientX - startX);
    if (dy <= 0 || dx > dy || !atTop()) { if (dist) reset(); pulling = dist > 0 && dy > 0; dist = 0; return; }
    dist = dy * 0.5;                      // 阻尼：手指拉 2 單位，圖示動 1 單位
    if (e.cancelable) e.preventDefault(); // 避免整頁一起被拉動
    el.classList.add('dragging');
    show(dist);
    armed = dist >= TRIGGER;
    el.classList.toggle('ready', armed);
  }, { passive: false });

  function end() {
    if (!pulling) return;
    pulling = false;
    if (armed && !busy) {
      busy = true;
      el.classList.remove('dragging', 'ready');
      el.classList.add('loading');
      el.innerHTML = SPIN;
      el.style.transform = 'translateY(' + (TRIGGER - 40) + 'px)'; el.style.opacity = '1';
      setTimeout(function () { location.reload(); }, 250);
    } else reset();
  }
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
})();
