/**
 * 全站状态栏
 * ---------------------------------------------------------------------------
 * 在每个页面顶部显示账户状态。状态由服务端 /api/status 计算后下发，
 * 前端只负责渲染，不自行推断，避免被本地改时间绕过试用期。
 *
 *   红点  未登录          「登录以享受服务」（可点击去登录）
 *   黄点  42 试用账户     「未激活，试用期仅剩 X天 HH:MM:SS」逐秒递减，归零弹窗拦截
 *   黄点  管理员          「未激活，试用期仅剩-1天」（-1 表示永不到期）
 *   绿点  已完成邮箱验证  「账户正常」+ 右上角控制台入口
 *
 * 倒计时原理：服务端给出 remainingMs，前端换算成本地截止时刻 endAt 再逐秒递减。
 * 用「剩余量」而不是「绝对时间戳」，客户端时钟不准也不会把倒计时算错；
 * 而真正的放行/拦截始终由服务端判定，前端倒计时只是显示。
 */
(function () {
  'use strict';

  var BAR_ID = 'dsh-status-bar';
  var MASK_ID = 'dsh-block-mask';
  var MAINT_ID = 'dsh-maint-mask';
  var DAY = 86400000;

  /** 每秒倒计时的定时器；重新渲染前必须先清掉，避免叠加 */
  var countdownTimer = null;
  /** 周期性与服务端重新同步（管理员激活后最多 60 秒生效） */
  var syncTimer = null;
  /** 维护弹窗内的秒级倒计时 */
  var maintTickTimer = null;
  /** 到点自动开关维护弹窗的定时器 */
  var maintTimer = null;
  /** 当前维护时段 {start,end}，用于判断窗口是否变了 */
  var maintCur = null;

  /* 状态栏基础样式。用 !important 覆盖各页面自己的 body padding，
     因为状态栏是 fixed 定位，不给 body 留出空间会盖住页面内容。 */
  var CSS =
    '#' + BAR_ID + '{position:fixed;top:0;left:0;right:0;z-index:99999;' +
    'display:flex;align-items:center;justify-content:space-between;gap:8px;' +
    'height:34px;padding:0 12px;box-sizing:border-box;' +
    'background:rgba(6,14,10,.96);border-bottom:1px solid rgba(0,255,140,.22);' +
    'font-family:"Microsoft YaHei","PingFang SC",sans-serif;font-size:12px;' +
    'color:#cfe8dc;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);}' +
    '#' + BAR_ID + ' .sb-l{display:flex;align-items:center;gap:7px;min-width:0;flex:1;}' +
    '#' + BAR_ID + ' .sb-dot{width:9px;height:9px;border-radius:50%;flex:none;}' +
    '#' + BAR_ID + ' .sb-dot.red{background:#ff4d4d;box-shadow:0 0 7px #ff4d4d;}' +
    '#' + BAR_ID + ' .sb-dot.yellow{background:#ffcc00;box-shadow:0 0 7px #ffcc00;}' +
    '#' + BAR_ID + ' .sb-dot.green{background:#00ff8c;box-shadow:0 0 7px #00ff8c;}' +
    '#' + BAR_ID + ' .sb-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '#' + BAR_ID + ' a.sb-text{color:#00ff8c;text-decoration:none;}' +
    '#' + BAR_ID + ' a.sb-text:active{opacity:.6;}' +
    /* 倒计时：等宽 + 表格数字，避免每秒跳动导致宽度抖动 */
    '#' + BAR_ID + ' .sb-cd{font-family:ui-monospace,Menlo,Consolas,monospace;' +
    'font-variant-numeric:tabular-nums;color:#ffcc00;font-weight:600;}' +
    /* 窄屏时换用短前缀，保证倒计时不被挤掉 */
    '#' + BAR_ID + ' .sb-pre-s{display:none;}' +
    '#' + BAR_ID + ' .sb-r{display:flex;align-items:center;gap:8px;flex:none;}' +
    '#' + BAR_ID + ' .sb-btn{display:inline-block;padding:4px 11px;border-radius:7px;' +
    'border:1px solid rgba(0,255,140,.45);color:#00ff8c;text-decoration:none;' +
    'font-size:12px;line-height:1.3;white-space:nowrap;background:rgba(0,255,140,.07);}' +
    '#' + BAR_ID + ' .sb-btn:active{background:rgba(0,255,140,.2);}' +
    '@media (max-width:420px){' +
    '#' + BAR_ID + '{padding:0 8px;gap:6px;}' +
    '#' + BAR_ID + ' .sb-pre{display:none;}' +
    '#' + BAR_ID + ' .sb-pre-s{display:inline;}' +
    '#' + BAR_ID + ' .sb-btn{padding:3px 8px;font-size:11px;}}' +
    /* 弹窗 */
    '#' + MASK_ID + '{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.72);' +
    'display:flex;align-items:center;justify-content:center;padding:20px;' +
    'font-family:"Microsoft YaHei","PingFang SC",sans-serif;}' +
    '#' + MASK_ID + ' .bm-card{width:100%;max-width:360px;padding:26px 22px;text-align:center;' +
    'background:rgba(14,10,10,.98);border:1px solid rgba(255,77,77,.55);border-radius:16px;' +
    'box-shadow:0 0 40px rgba(255,77,77,.18);}' +
    '#' + MASK_ID + ' h2{margin:0 0 12px;font-size:21px;color:#ff5c5c;letter-spacing:.5px;' +
    'font-family:Orbitron,"Microsoft YaHei",sans-serif;}' +
    '#' + MASK_ID + ' p{margin:0 0 20px;font-size:13px;line-height:1.9;color:#e0c8c8;}' +
    '#' + MASK_ID + ' .bm-acts{display:flex;gap:10px;}' +
    '#' + MASK_ID + ' .bm-acts a,#' + MASK_ID + ' .bm-acts button{flex:1;padding:10px 0;' +
    'border-radius:9px;font-size:13px;cursor:pointer;text-decoration:none;text-align:center;' +
    'font-family:inherit;border:1px solid rgba(255,77,77,.5);background:rgba(255,77,77,.1);' +
    'color:#ff8a8a;}' +
    '#' + MASK_ID + ' .bm-acts a:active,#' + MASK_ID + ' .bm-acts button:active{opacity:.7;}' +
    /* 维护弹窗：琥珀色，比「已拦截」更柔和 */
    '#' + MAINT_ID + '{position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.8);' +
    'display:flex;align-items:center;justify-content:center;padding:20px;' +
    'font-family:"Microsoft YaHei","PingFang SC",sans-serif;}' +
    '#' + MAINT_ID + ' .mt-card{width:100%;max-width:360px;padding:28px 22px;text-align:center;' +
    'background:rgba(16,13,6,.99);border:1px solid rgba(255,170,0,.55);border-radius:16px;' +
    'box-shadow:0 0 40px rgba(255,170,0,.18);}' +
    '#' + MAINT_ID + ' h2{margin:0 0 12px;font-size:20px;color:#ffb020;letter-spacing:.5px;' +
    'font-family:Orbitron,"Microsoft YaHei",sans-serif;}' +
    '#' + MAINT_ID + ' p{margin:0 0 10px;font-size:13px;line-height:1.9;color:#e6dcc4;}' +
    '#' + MAINT_ID + ' .mt-cd{color:#ffb020;}' +
    '#' + MAINT_ID + ' .mt-cd span{font-family:ui-monospace,Menlo,Consolas,monospace;' +
    'font-variant-numeric:tabular-nums;font-weight:600;}' +
    '#' + MAINT_ID + ' .mt-range{font-size:11px;color:#9c9078;}' +
    '#' + MAINT_ID + ' .mt-acts{display:flex;gap:10px;margin-top:16px;}' +
    '#' + MAINT_ID + ' .mt-acts a,#' + MAINT_ID + ' .mt-acts button{flex:1;padding:9px 0;' +
    'border-radius:9px;font-size:12px;cursor:pointer;text-decoration:none;text-align:center;' +
    'font-family:inherit;border:1px solid rgba(255,170,0,.5);background:rgba(255,170,0,.1);' +
    'color:#ffc55c;}' +
    '#' + MAINT_ID + ' .mt-acts a:active,#' + MAINT_ID + ' .mt-acts button:active{opacity:.7;}' +
    '#' + MAINT_ID + ' .mt-note{font-size:11px;color:#8a8060;margin-top:12px;}';

  function injectCss() {
    if (document.getElementById('dsh-status-css')) return;
    var s = document.createElement('style');
    s.id = 'dsh-status-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /** 给 body 留出状态栏高度，避免遮挡页面内容 */
  function reserveSpace() {
    if (document.getElementById('dsh-status-space')) return;
    var st = document.createElement('style');
    st.id = 'dsh-status-space';
    // 用 34px 固定高度；各页面原本的 padding 用 max() 保留较大者
    st.textContent = 'body{padding-top:max(34px,var(--dsh-orig-pt,0px))!important;}';
    (document.head || document.documentElement).appendChild(st);
  }

  /** 把剩余毫秒格式化成「X天 HH:MM:SS」 */
  function fmtLeft(ms) {
    if (!(ms > 0)) return '0天 00:00:00';
    var d = Math.floor(ms / DAY);
    var h = Math.floor((ms % DAY) / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d + '天 ' + p2(h) + ':' + p2(m) + ':' + p2(s);
  }

  function showBlocked() {
    if (document.getElementById(MASK_ID)) return;
    var mask = document.createElement('div');
    mask.id = MASK_ID;
    mask.innerHTML =
      '<div class="bm-card">' +
      '<h2>You are blocked</h2>' +
      '<p>账户试用期已到，请联系管理员以激活账户。</p>' +
      '<div class="bm-acts">' +
      '<a href="/contact/">联系我们</a>' +
      '<button type="button" id="dsh-block-close">关闭</button>' +
      '</div></div>';
    document.body.appendChild(mask);
    var btn = document.getElementById('dsh-block-close');
    if (btn) {
      btn.onclick = function () {
        mask.remove();
      };
    }
  }

  function hideBlocked() {
    var m = document.getElementById(MASK_ID);
    if (m) m.remove();
  }

  /* ==================== 维护弹窗 ==================== */

  /** 把时间戳格式化成「MM-DD HH:MM」 */
  function fmtClock(ts) {
    var d = new Date(ts);
    var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
    return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  function hideMaintenance() {
    var m = document.getElementById(MAINT_ID);
    if (m) m.remove();
    if (maintTickTimer) {
      clearInterval(maintTickTimer);
      maintTickTimer = null;
    }
  }

  /** 刷新弹窗里的「预计剩余」 */
  function updateMaintLeft(endAt) {
    var el = document.getElementById('dsh-mt-left');
    if (!el || !endAt) return;
    el.textContent = fmtLeft(Math.max(0, endAt - Date.now()));
  }

  function showMaintenance(st, isAdmin) {
    var endAt = st && st.end ? st.end : null;
    if (document.getElementById(MAINT_ID)) {
      updateMaintLeft(endAt);
      return;
    }
    var mask = document.createElement('div');
    mask.id = MAINT_ID;
    mask.innerHTML =
      '<div class="mt-card">' +
      '<h2>正在维护服务</h2>' +
      '<p>站点正在维护中，请稍后再来。</p>' +
      (endAt ? '<p class="mt-cd">预计剩余 <span id="dsh-mt-left">—</span></p>' : '') +
      (st && st.start && endAt ? '<p class="mt-range">维护时段：' + fmtClock(st.start) + ' → ' + fmtClock(endAt) + '</p>' : '') +
      '<div class="mt-acts"><button type="button" id="dsh-mt-admin">管理员关闭</button></div>' +
      '<div class="mt-note" id="dsh-mt-note">管理员可进入控制台关闭维护</div>' +
      '</div>';
    document.body.appendChild(mask);

    // 「管理员关闭」：管理员跳转到控制台去处理；没有权限则明确拒绝。
    // 按钮对所有人可见，所以权限判断必须在这里做，而不是靠隐藏按钮。
    var btn = document.getElementById('dsh-mt-admin');
    if (btn) {
      btn.onclick = function () {
        if (isAdmin) {
          location.href = '/console/';
          return;
        }
        var n = document.getElementById('dsh-mt-note');
        if (n) {
          n.textContent = '你无权进行此操作';
          n.style.color = '#ff7b7b';
        }
      };
    }

    updateMaintLeft(endAt);
    if (maintTickTimer) clearInterval(maintTickTimer);
    maintTickTimer = setInterval(function () {
      if (!endAt || Date.now() >= endAt) {
        hideMaintenance();
        load();
        return;
      }
      updateMaintLeft(endAt);
    }, 1000);
  }

  /** 安排一个「到点再看一次」的定时器：最长 60 秒，长时段交给周期同步 */
  function scheduleMaint() {
    if (maintTimer) {
      clearTimeout(maintTimer);
      maintTimer = null;
    }
    if (!maintCur) return;
    var now = Date.now();
    var next = now < maintCur.start ? maintCur.start : now < maintCur.end ? maintCur.end : null;
    if (next === null) return;
    var delay = Math.max(500, Math.min(next - now + 500, 60000));
    maintTimer = setTimeout(function () {
      load();
    }, delay);
  }

  /** 根据服务端下发的维护状态，决定弹或不弹 */
  /** 是否正处在控制台页面（管理员在这里不弹维护窗，否则会挡住自己） */
  function onConsolePage() {
    try {
      return typeof location !== 'undefined' && !!location.pathname && location.pathname.indexOf('/console') === 0;
    } catch (e) {
      return false;
    }
  }

  function applyMaintenance(st, isAdmin) {
    var active = !!(st && st.active);
    var win = st && st.set ? { start: st.start, end: st.end } : null;
    maintCur = win;

    var skipForAdmin = isAdmin && onConsolePage();

    if (active && !skipForAdmin) {
      showMaintenance(st, isAdmin);
    } else {
      hideMaintenance();
    }
    scheduleMaint();
  }

  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function render(data) {
    var acc = (data && data.account) || { state: 'guest', dot: 'red', label: '登录以享受服务', activated: false };
    stopCountdown();

    var old = document.getElementById(BAR_ID);
    if (old) old.remove();

    var bar = document.createElement('div');
    bar.id = BAR_ID;

    var left = document.createElement('div');
    left.className = 'sb-l';
    var dot = document.createElement('span');
    dot.className = 'sb-dot ' + (acc.dot || 'red');
    left.appendChild(dot);

    var cdEl = null;
    var preEl = null;
    var preShortEl = null;

    if (acc.state === 'guest') {
      var a = document.createElement('a');
      a.className = 'sb-text';
      a.href = '/login/';
      a.textContent = acc.label || '登录以享受服务';
      left.appendChild(a);
    } else if (acc.state === 'trial' && typeof acc.remainingMs === 'number') {
      // 实时倒计时：宽屏「未激活，试用期仅剩 」/ 窄屏「未激活 」
      preEl = document.createElement('span');
      preEl.className = 'sb-pre';
      preEl.textContent = '未激活，试用期仅剩 ';
      preShortEl = document.createElement('span');
      preShortEl.className = 'sb-pre-s';
      preShortEl.textContent = '未激活 ';
      cdEl = document.createElement('span');
      cdEl.className = 'sb-cd';
      cdEl.textContent = fmtLeft(acc.remainingMs);
      left.appendChild(preEl);
      left.appendChild(preShortEl);
      left.appendChild(cdEl);
    } else {
      var t = document.createElement('span');
      t.className = 'sb-text';
      t.textContent = acc.label || '';
      left.appendChild(t);
    }
    bar.appendChild(left);

    var right = document.createElement('div');
    right.className = 'sb-r';
    // 右上角控制台：已激活（完成邮箱验证）的用户可见。
    // 管理员额外可见 —— 否则没人能去激活被拦截的账户。
    if (data && data.loggedIn && (acc.activated || data.isAdmin)) {
      var c = document.createElement('a');
      c.className = 'sb-btn';
      c.href = '/console/';
      c.textContent = '控制台';
      right.appendChild(c);
    }
    // 登出：所有已登录用户都要有。
    // 登录页在已登录时会把用户弹走，所以这里必须给出口，否则已激活用户无法切换账号。
    if (data && data.loggedIn) {
      var out = document.createElement('a');
      out.className = 'sb-btn';
      out.href = '#';
      out.textContent = '登出';
      out.onclick = function (e) {
        e.preventDefault();
        fetch('/api/logout', { method: 'POST' }).then(function () {
          location.reload();
        });
      };
      right.appendChild(out);
    }
    bar.appendChild(right);

    document.body.insertBefore(bar, document.body.firstChild);

    // 与服务端重新对齐：只有真的 blocked 才弹窗
    if (acc.state === 'blocked') {
      showBlocked();
    } else {
      hideBlocked();
    }

    // 维护时段：到点自动弹出 / 到点自动关闭
    applyMaintenance(data && data.maintenance, !!(data && data.isAdmin));

    // 启动每秒倒计时
    if (cdEl && acc.remainingMs > 0) {
      var endAt = Date.now() + acc.remainingMs;
      countdownTimer = setInterval(function () {
        var leftMs = endAt - Date.now();
        if (leftMs <= 0) {
          stopCountdown();
          cdEl.textContent = '0天 00:00:00';
          if (preEl) preEl.textContent = '未激活，试用期已到';
          if (preShortEl) preShortEl.textContent = '已到期';
          showBlocked();
          // 与服务端确认一次（客户端时钟可能偏差），3 秒后同步
          setTimeout(load, 3000);
          return;
        }
        cdEl.textContent = fmtLeft(leftMs);
      }, 1000);
    }
  }

  function load() {
    injectCss();
    reserveSpace();
    return fetch('/api/status', { cache: 'no-store' })
      .then(function (r) {
        return r.json();
      })
      .then(render)
      .catch(function () {
        // 网络异常时退回未登录样式，不阻塞页面
        render({ loggedIn: false, account: { state: 'guest', dot: 'red', label: '登录以享受服务' } });
      });
  }

  // 记录页面原本的 padding-top，供 reserveSpace 取较大值
  function rememberPadding() {
    try {
      var cur = parseFloat(getComputedStyle(document.body).paddingTop) || 0;
      document.body.style.setProperty('--dsh-orig-pt', cur + 'px');
    } catch (e) {
      /* 忽略 */
    }
  }

  function boot() {
    rememberPadding();
    load();
    // 每 60 秒重新同步一次：管理员激活 / 续期后，客户端最多 1 分钟跟上
    if (!syncTimer) syncTimer = setInterval(load, 60000);
    // 回到前台立刻同步一次（手机切回来时倒计时可能已过期）
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) load();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
