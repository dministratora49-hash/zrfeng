/**
 * 全站状态栏
 * ---------------------------------------------------------------------------
 * 在每个页面顶部显示账户状态。状态由服务端 /api/status 计算后下发，
 * 前端只负责渲染，不自行推断，避免被本地改时间绕过试用期。
 *
 *   红点  未登录          「登录以享受服务」（可点击去登录）
 *   黄点  42 试用账户     「未激活，试用期仅剩N天」，逐日递减，到 0 弹窗拦截
 *   黄点  管理员          「未激活，试用期仅剩-1天」（-1 表示永不到期）
 *   绿点  已完成邮箱验证  「账户正常」+ 右上角控制台入口
 */
(function () {
  'use strict';

  var BAR_ID = 'dsh-status-bar';

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
    '#' + BAR_ID + ' .sb-r{display:flex;align-items:center;gap:8px;flex:none;}' +
    '#' + BAR_ID + ' .sb-btn{display:inline-block;padding:4px 11px;border-radius:7px;' +
    'border:1px solid rgba(0,255,140,.45);color:#00ff8c;text-decoration:none;' +
    'font-size:12px;line-height:1.3;white-space:nowrap;background:rgba(0,255,140,.07);}' +
    '#' + BAR_ID + ' .sb-btn:active{background:rgba(0,255,140,.2);}' +
    /* 弹窗 */
    '#dsh-block-mask{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.72);' +
    'display:flex;align-items:center;justify-content:center;padding:20px;' +
    'font-family:"Microsoft YaHei","PingFang SC",sans-serif;}' +
    '#dsh-block-mask .bm-card{width:100%;max-width:360px;padding:26px 22px;text-align:center;' +
    'background:rgba(14,10,10,.98);border:1px solid rgba(255,77,77,.55);border-radius:16px;' +
    'box-shadow:0 0 40px rgba(255,77,77,.18);}' +
    '#dsh-block-mask h2{margin:0 0 12px;font-size:21px;color:#ff5c5c;letter-spacing:.5px;' +
    'font-family:Orbitron,"Microsoft YaHei",sans-serif;}' +
    '#dsh-block-mask p{margin:0 0 20px;font-size:13px;line-height:1.9;color:#e0c8c8;}' +
    '#dsh-block-mask .bm-acts{display:flex;gap:10px;}' +
    '#dsh-block-mask .bm-acts a,#dsh-block-mask .bm-acts button{flex:1;padding:10px 0;' +
    'border-radius:9px;font-size:13px;cursor:pointer;text-decoration:none;text-align:center;' +
    'font-family:inherit;border:1px solid rgba(255,77,77,.5);background:rgba(255,77,77,.1);' +
    'color:#ff8a8a;}' +
    '#dsh-block-mask .bm-acts a:active,#dsh-block-mask .bm-acts button:active{opacity:.7;}';

  function injectCss() {
    if (document.getElementById('dsh-status-css')) return;
    var s = document.createElement('style');
    s.id = 'dsh-status-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /** 给 body 留出状态栏高度，避免遮挡页面内容 */
  function reserveSpace() {
    var st = document.createElement('style');
    st.id = 'dsh-status-space';
    // 用 34px 固定高度；各页面原本的 padding 用 max() 保留较大者
    st.textContent =
      'body{padding-top:max(34px,var(--dsh-orig-pt,0px))!important;}';
    (document.head || document.documentElement).appendChild(st);
  }

  function showBlocked() {
    if (document.getElementById('dsh-block-mask')) return;
    var mask = document.createElement('div');
    mask.id = 'dsh-block-mask';
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

  function render(data) {
    var acc = (data && data.account) || { state: 'guest', dot: 'red', label: '登录以享受服务', activated: false };
    var old = document.getElementById(BAR_ID);
    if (old) old.remove();

    var bar = document.createElement('div');
    bar.id = BAR_ID;

    var left = document.createElement('div');
    left.className = 'sb-l';
    var dot = document.createElement('span');
    dot.className = 'sb-dot ' + (acc.dot || 'red');
    left.appendChild(dot);

    if (acc.state === 'guest') {
      var a = document.createElement('a');
      a.className = 'sb-text';
      a.href = '/login/';
      a.textContent = acc.label || '登录以享受服务';
      left.appendChild(a);
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

    if (acc.state === 'blocked') showBlocked();
  }

  function load() {
    injectCss();
    reserveSpace();
    fetch('/api/status', { cache: 'no-store' })
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      rememberPadding();
      load();
    });
  } else {
    rememberPadding();
    load();
  }
})();
