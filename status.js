/**
 * 全站状态栏
 * ---------------------------------------------------------------------------
 * 在每个页面顶部显示账户状态。状态由服务端 /api/status 计算后下发，
 * 前端只负责渲染，不自行推断，避免被本地改时间绕过试用期。
 *
 *   红点  未登录          「登录以享受服务」（可点击去登录）
 *   黄点  42 试用账户     「未激活，试用期仅剩 X天 HH:MM:SS」逐秒递减，归零弹窗拦截
 *   绿点  管理员          「账户正常」（与已激活账户一致，不参与试用期倒计时）
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
  var BAN_ID = 'dsh-ban-mask';
  var WARN_ID = 'dsh-warn-mask';
  var DAY = 86400000;

  /** 把一段文字转义成可以安全放进 innerHTML 的形式 */
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

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
    /* 二次验证已关闭：感叹号 + 风险提示（替换掉「账户正常」，琥珀色区分于绿色圆点） */
    '#' + BAR_ID + ' .sb-ex{display:inline-flex;align-items:center;justify-content:center;' +
    'width:15px;height:15px;margin-right:5px;border-radius:50%;flex:none;' +
    'background:#ffcc00;color:#3a2a00;font-size:11px;font-weight:700;line-height:1;}' +
    '#' + BAR_ID + ' .sb-risk-text{color:#ffcc00;}' +
    '#' + BAR_ID + ' .sb-r{display:flex;align-items:center;gap:8px;flex:none;}' +
    '#' + BAR_ID + ' .sb-btn{display:inline-block;padding:4px 11px;border-radius:7px;' +
    'border:1px solid rgba(0,255,140,.45);color:#00ff8c;text-decoration:none;' +
    'font-size:12px;line-height:1.3;white-space:nowrap;background:rgba(0,255,140,.07);}' +
    '#' + BAR_ID + ' .sb-btn:active{background:rgba(0,255,140,.2);}' +
    /* 右上角语言选择：一个下拉，三档（简 / 繁 / EN）。
       和地区解耦 —— 换语言只换界面语种，不动账户里的地区。 */
    '#' + BAR_ID + ' .sb-lang{display:inline-flex;align-items:center;gap:4px;}' +
    '#' + BAR_ID + ' .sb-lang select{' +
    'appearance:none;-webkit-appearance:none;cursor:pointer;' +
    'padding:4px 20px 4px 9px;border-radius:7px;font-family:inherit;font-size:12px;line-height:1.3;' +
    'border:1px solid rgba(0,255,140,.45);background:rgba(0,255,140,.07);color:#00ff8c;' +
    'background-image:linear-gradient(45deg,transparent 50%,#00ff8c 50%),' +
    'linear-gradient(135deg,#00ff8c 50%,transparent 50%);' +
    'background-position:calc(100% - 11px) 50%,calc(100% - 7px) 50%;' +
    'background-size:4px 4px,4px 4px;background-repeat:no-repeat;}' +
    '#' + BAR_ID + ' .sb-lang select:focus{outline:none;}' +
    '#' + BAR_ID + ' .sb-lang select option{background:#0a120e;color:#e8f5ee;}' +
    '@media (max-width:420px){#' + BAR_ID + ' .sb-lang select{padding:3px 18px 3px 7px;font-size:11px;}}' +
    '@media (max-width:420px){' +
    '#' + BAR_ID + '{padding:0 8px;gap:6px;}' +
    '#' + BAR_ID + ' .sb-pre{display:none;}' +
    '#' + BAR_ID + ' .sb-pre-s{display:inline;}' +
    '#' + BAR_ID + ' .sb-btn{padding:3px 8px;font-size:11px;}}' +
    /* ---- 右侧滑出提示：图标 + 标题 + 说明 + 按钮，用站点自己的卡片观感 ---- */
    '#dsh-slide-toast{position:fixed;top:46px;right:12px;z-index:100010;box-sizing:border-box;' +
    'width:min(340px,calc(100vw - 24px));display:flex;align-items:flex-start;gap:10px;padding:13px 14px;' +
    'background:rgba(10,16,28,.94);border:1px solid rgba(0,255,170,.22);border-radius:14px;' +
    'box-shadow:0 10px 30px rgba(0,0,0,.45);' +
    'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);' +
    'font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#cfe8dc;text-align:left;' +
    'transform:translateX(calc(100% + 24px));opacity:0;' +
    'transition:transform .36s cubic-bezier(.18,.86,.3,1.02),opacity .26s ease;}' +
    '#dsh-slide-toast.on{transform:translateX(0);opacity:1;}' +
    '#dsh-slide-toast .sl-ico{width:36px;height:36px;flex:none;display:flex;align-items:center;' +
    'justify-content:center;font-size:17px;line-height:1;border-radius:10px;' +
    'background:rgba(0,255,170,.10);border:1px solid rgba(0,255,170,.25);color:#00ffaa;}' +
    '#dsh-slide-toast .sl-body{flex:1;min-width:0;}' +
    '#dsh-slide-toast .sl-t{font-size:13px;font-weight:700;color:#00ffaa;letter-spacing:.6px;' +
    'font-family:Orbitron,"Microsoft YaHei",sans-serif;}' +
    '#dsh-slide-toast .sl-d{font-size:12px;line-height:1.6;color:#9db6ad;margin-top:4px;word-break:break-word;}' +
    '#dsh-slide-toast .sl-acts{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;}' +
    '#dsh-slide-toast .sl-acts button{padding:6px 14px;font-size:12px;font-family:inherit;cursor:pointer;' +
    'border-radius:20px;border:1px solid rgba(0,255,170,.35);background:rgba(0,255,170,.08);color:#00ffaa;' +
    'transition:background .2s,border-color .2s,transform .15s;}' +
    '#dsh-slide-toast .sl-acts button:hover{background:rgba(0,255,170,.16);border-color:rgba(0,255,170,.55);}' +
    '#dsh-slide-toast .sl-acts button:active{transform:translateY(1px);}' +
    '#dsh-slide-toast .sl-acts button.primary{background:linear-gradient(135deg,#00ffaa,#00d98a);' +
    'border-color:transparent;color:#06120c;font-weight:700;}' +
    '#dsh-slide-toast .sl-acts button.primary:hover{box-shadow:0 0 18px rgba(0,255,170,.35);}' +
    '#dsh-slide-toast .sl-acts button.mute{border-color:rgba(127,168,147,.4);background:transparent;color:#9db6ad;}' +

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
    /* 维护弹窗第一行：一句诗 */
    '#' + MAINT_ID + ' .mt-quote{font-size:13px;color:#c9b98a;letter-spacing:1.5px;margin:0 0 14px;}' +
    /* 进度百分比：等宽数字，避免跳动 */
    '#' + MAINT_ID + ' .mt-pct{color:#ffb020;margin:0;}' +
    '#' + MAINT_ID + ' .mt-pct b{font-family:ui-monospace,Menlo,Consolas,monospace;' +
    'font-variant-numeric:tabular-nums;font-weight:600;}' +
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
    '#' + MAINT_ID + ' .mt-note{font-size:11px;color:#8a8060;margin-top:12px;}' +
    '#' + MAINT_ID + ' .mt-staff{margin-top:14px;padding-top:12px;border-top:1px dashed rgba(255,176,32,.3);}' +
    '#' + MAINT_ID + ' .mt-staff summary{font-size:12px;color:#8a8060;cursor:pointer;}' +
    '#' + MAINT_ID + ' .mt-staff input{width:100%;margin:10px 0 8px;padding:9px 11px;border-radius:8px;' +
    'border:1px solid rgba(255,176,32,.35);background:rgba(0,0,0,.42);color:#e8f5ee;font-size:13px;font-family:inherit;}' +
    '#' + MAINT_ID + ' .mt-staff button{width:100%;padding:9px 0;border-radius:8px;' +
    'border:1px solid rgba(255,176,32,.5);background:rgba(255,176,32,.14);color:#ffb020;' +
    'font-size:13px;font-family:inherit;cursor:pointer;}' +
    '#' + MAINT_ID + ' .mt-staff-msg{font-size:11px;min-height:15px;margin-top:7px;}' +
    /* 封禁弹窗：与「试用期已到」同款红色卡片，只换文案 */
    '#' + BAN_ID + '{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.78);' +
    'display:flex;align-items:center;justify-content:center;padding:20px;' +
    'font-family:"Microsoft YaHei","PingFang SC",sans-serif;}' +
    '#' + BAN_ID + ' .bn-card{width:100%;max-width:360px;padding:26px 22px;text-align:center;' +
    'background:rgba(16,8,8,.99);border:1px solid rgba(255,60,60,.6);border-radius:16px;' +
    'box-shadow:0 0 40px rgba(255,60,60,.22);}' +
    '#' + BAN_ID + ' h2{margin:0 0 12px;font-size:22px;color:#ff4444;letter-spacing:.5px;' +
    'font-family:Orbitron,"Microsoft YaHei",sans-serif;}' +
    '#' + BAN_ID + ' p{margin:0 0 18px;font-size:13px;line-height:1.9;color:#e8d0d0;}' +
    '#' + BAN_ID + ' .bn-meta{font-size:11px;color:#9c7c7c;margin:-8px 0 16px;}' +
    '#' + BAN_ID + ' .bn-acts{display:flex;gap:10px;}' +
    '#' + BAN_ID + ' .bn-acts a,#' + BAN_ID + ' .bn-acts button{flex:1;padding:10px 0;' +
    'border-radius:9px;font-size:13px;cursor:pointer;text-decoration:none;text-align:center;' +
    'font-family:inherit;border:1px solid rgba(255,60,60,.5);background:rgba(255,60,60,.1);' +
    'color:#ff8a8a;}' +
    '#' + BAN_ID + ' .bn-acts a:active,#' + BAN_ID + ' .bn-acts button:active{opacity:.7;}' +
    /* 账户警告弹窗：琥珀色，和「维护」区分开，但同样是「提醒」而不是「拦截」 */
    '#' + WARN_ID + '{position:fixed;inset:0;z-index:100003;background:rgba(0,0,0,.78);' +
    'display:flex;align-items:center;justify-content:center;padding:20px;' +
    'font-family:"Microsoft YaHei","PingFang SC",sans-serif;}' +
    '#' + WARN_ID + ' .wn-card{width:100%;max-width:380px;padding:24px 22px;text-align:left;' +
    'background:rgba(20,15,5,.99);border:1px solid rgba(255,190,60,.6);border-radius:16px;' +
    'box-shadow:0 0 40px rgba(255,190,60,.2);}' +
    '#' + WARN_ID + ' .wn-badge{display:inline-block;padding:3px 10px;border-radius:20px;' +
    'font-size:11px;letter-spacing:1px;background:rgba(255,190,60,.16);color:#ffbe3c;' +
    'border:1px solid rgba(255,190,60,.45);margin-bottom:12px;}' +
    '#' + WARN_ID + ' h2{margin:0 0 14px;font-size:18px;color:#ffbe3c;letter-spacing:.5px;}' +
    '#' + WARN_ID + ' .wn-text{font-size:13.5px;line-height:1.9;color:#efe4cc;' +
    'background:rgba(0,0,0,.35);border:1px solid rgba(255,190,60,.2);border-radius:10px;' +
    'padding:12px 14px;white-space:pre-wrap;word-break:break-word;max-height:40vh;overflow:auto;}' +
    '#' + WARN_ID + ' .wn-by{font-size:11px;color:#8a7a5c;margin:10px 0 0;}' +
    '#' + WARN_ID + ' .wn-note{font-size:11px;color:#8a7a5c;margin:10px 0 0;line-height:1.7;}' +
    '#' + WARN_ID + ' .wn-acts{display:flex;gap:10px;margin-top:16px;}' +
    '#' + WARN_ID + ' .wn-acts a,#' + WARN_ID + ' .wn-acts button{flex:1;padding:10px 0;' +
    'border-radius:9px;font-size:13px;cursor:pointer;text-decoration:none;text-align:center;' +
    'font-family:inherit;border:1px solid rgba(255,190,60,.5);background:rgba(255,190,60,.12);' +
    'color:#ffbe3c;}' +
    '#' + WARN_ID + ' .wn-acts a:active,#' + WARN_ID + ' .wn-acts button:active{opacity:.7;}';

  /* ==================== 主题（只剩「原生安卓」） ====================
   * 旧的两套主题（暗色 dark / 亮色 light）已下线：
   *   · 新访客一律是 data-theme="android"（Material You）
   *   · 老用户 localStorage 里可能还存着 dark / light —— 那已经不是合法值，
   *     会被自动当成 android，同时弹一次「旧版主题即将被删除」的通知，
   *     点确定后正式切到新主题（见 warnLegacyTheme）。
   * 具体配色全在 /android.css（只对 data-theme="android" 生效）。
   */
  var THEME_KEY = 'zrfeng-theme';
  var THEMES = { android: '原生安卓' };
  var THEME_DEFAULT = 'android';
  /** 已下线的旧主题：读到这些值就提示一次，然后切到新主题 */
  var LEGACY_THEMES = ['dark', 'light'];
  var TOAST_ID = 'dsh-slide-toast';
  var PREF_ACK_PREFIX = 'zrfeng-pref-ack:';
  /** 记录「旧主题提示」是否已经处理过，避免每次刷新都弹 */
  var LEGACY_THEME_ACK = 'zrfeng-legacy-theme-ack';
  /** 最近一次 /api/status 的结果（判断是否登录、账户偏好是什么） */
  var lastStatus = null;
  /** 每次页面加载只主动问一次「要不要套用账户偏好」 */
  var prefPrompted = false;
  var mcTimer = null;

  function isTheme(t) { return t === THEME_DEFAULT; }

  /** 这个值是不是已下线的旧主题（用来决定要不要提示） */
  function isLegacyTheme(t) {
    return LEGACY_THEMES.indexOf(String(t || '')) >= 0;
  }

  function currentTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    return isTheme(t) ? t : THEME_DEFAULT;
  }

  /** 本机存的主题原始值（可能是已下线的旧主题，调用方自行判断） */
  function readRawTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }

  function readTheme() {
    var t = readRawTheme();
    if (isTheme(t)) return t;
    return currentTheme();
  }

  function applyTheme(theme, persist) {
    var t = isTheme(theme) ? theme : THEME_DEFAULT;
    document.documentElement.setAttribute('data-theme', t);
    if (persist) {
      try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* 忽略 */ }
    }
    // 首页粒子背景这类「自己画」的东西，靠这个事件跟着换色
    try {
      document.dispatchEvent(new CustomEvent('zrfeng:themechange', { detail: { theme: t } }));
    } catch (e) {
      var ev = document.createEvent('CustomEvent');
      ev.initCustomEvent('zrfeng:themechange', false, false, { theme: t });
      document.dispatchEvent(ev);
    }
  }

  /* ==================== 旧主题下线提示 ====================
   * 老用户 localStorage 里还存着 dark / light：
   *   · 先立刻把页面切到新主题（别让人继续看着一套要删的皮肤）
   *   · 再弹一次通知说明情况，点「确定」把 localStorage 正式写掉
   * 用 LEGACY_THEME_ACK 记一笔，同一台设备只提示一次。
   * 本来就在用新主题的人完全不会看到这条。
   */
  function legacyAcked() {
    try { return localStorage.getItem(LEGACY_THEME_ACK) === '1'; } catch (e) { return false; }
  }

  function markLegacyAcked() {
    try { localStorage.setItem(LEGACY_THEME_ACK, '1'); } catch (e) { }
  }

  function warnLegacyTheme() {
    var raw = readRawTheme();
    if (!isLegacyTheme(raw)) return;      // 用的就是新主题 / 从没选过 → 不打扰
    if (legacyAcked()) {
      // 之前已经确认过，只是存储没清干净，顺手抹掉
      applyTheme(THEME_DEFAULT, true);
      return;
    }
    // 先切过去，通知里说的就是眼前这套
    applyTheme(THEME_DEFAULT, false);
    showMcToast({
      icon: '🎨',
      title: '旧版主题即将被删除',
      desc: '你正在使用的旧版主题（' + (raw === 'light' ? '亮色' : '暗色') +
        '）即将下线，请改用新的「原生安卓」主题。',
      autoHideMs: 0,                     // 0 = 不自动消失，必须点确定
      actions: [
        {
          text: '确定',
          cls: 'primary',
          onClick: function () {
            applyTheme(THEME_DEFAULT, true);   // 正式写入，之后不会再提示
            markLegacyAcked();
            hideMcToast();
          }
        }
      ]
    });
  }

  /** 唯一保留的主题 */
  var THEME_META = {
    android: { ico: '🤖', label: '原生安卓' }
  };

  function themeMeta(t) { return THEME_META[t] || THEME_META.android; }


  /* ==================== MC 成就风格滑出提示 ====================
   * 从右侧滑入、方角、粗亮边；用来问「是否保存账户偏好」这类一次性问题。
   */
  function hideMcToast(immediate) {
    if (mcTimer) { clearTimeout(mcTimer); mcTimer = null; }
    var t = document.getElementById(TOAST_ID);
    if (!t) return;
    t.classList.remove('on');
    if (immediate) { if (t.parentNode) t.parentNode.removeChild(t); return; }
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 420);
  }

  function showMcToast(opts) {
    hideMcToast(true);
    var t = document.createElement('div');
    t.id = TOAST_ID;

    var ico = document.createElement('div');
    ico.className = 'sl-ico';
    ico.textContent = opts.icon || '★';
    t.appendChild(ico);

    var body = document.createElement('div');
    body.className = 'sl-body';
    var title = document.createElement('div');
    title.className = 'sl-t';
    title.textContent = opts.title || '';
    body.appendChild(title);
    if (opts.desc) {
      var d = document.createElement('div');
      d.className = 'sl-d';
      d.textContent = opts.desc;
      body.appendChild(d);
    }
    if (opts.actions && opts.actions.length) {
      var acts = document.createElement('div');
      acts.className = 'sl-acts';
      opts.actions.forEach(function (a) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = a.text || '';
        if (a.cls) b.className = a.cls;
        b.onclick = function (e) {
          if (e) e.preventDefault();
          // 返回 true 表示「先别关」，等异步结果自己接管
          var keep = a.onClick ? a.onClick() === true : false;
          if (!keep) hideMcToast();
        };
        acts.appendChild(b);
      });
      body.appendChild(acts);
    }
    t.appendChild(body);
    document.body.appendChild(t);

    var raf = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame
      : function (f) { setTimeout(f, 16); };
    raf(function () { raf(function () { t.classList.add('on'); }); });

    if (opts.autoHideMs) mcTimer = setTimeout(hideMcToast, opts.autoHideMs);
    return t;
  }

  /* ==================== 账户偏好同步 ====================
   * 账户里存的是「上次保存的主题」；本机用 localStorage 记「这台设备已经
   * 对哪个值做过选择」，避免每次刷新都弹。
   */
  function prefAckKey(user) {
    return PREF_ACK_PREFIX + String(user || '').toLowerCase();
  }
  function readPrefAck(user) {
    try { return localStorage.getItem(prefAckKey(user)); } catch (e) { return null; }
  }
  function writePrefAck(user, theme) {
    try { localStorage.setItem(prefAckKey(user), String(theme || '')); } catch (e) { }
  }
  function themeName(t) { return (THEMES[t] || THEMES.android); }


  /* 账户偏好 = 主题 + 语言，两件事合起来算一份「偏好」。
   * 只要有一项和设备当前不一致，就滑出来问一次；两项都一致就不问。 */
  function maybeAskUsePref(data) {
    if (prefPrompted) return;
    var user = data && data.loggedIn ? String(data.username || '') : '';
    if (!user) return;

    var savedTheme = data.prefTheme;
    var savedLang = data.prefLang || null;
    var hasTheme = isTheme(savedTheme);
    var hasLang = !!(savedLang && SITE_LANG_SITE[savedLang]);
    if (!hasTheme && !hasLang) return;

    var curTheme = currentTheme();
    var curLang = currentSiteLang();
    var themeDiff = hasTheme && savedTheme !== curTheme;
    var langDiff = hasLang && savedLang !== curLang;
    if (!themeDiff && !langDiff) {
      writePrefAck(user, ackValue(savedTheme, savedLang));
      return;
    }
    var key = ackValue(savedTheme, savedLang);
    if (readPrefAck(user) === key) return;

    prefPrompted = true;
    var parts = [];
    if (themeDiff) parts.push('「' + themeName(savedTheme) + '」模式');
    if (langDiff) parts.push('「' + (SITE_LANG_NAME[savedLang] || savedLang) + '」语言');
    var curParts = [];
    if (themeDiff) curParts.push('「' + themeName(curTheme) + '」模式');
    if (langDiff) curParts.push('「' + (SITE_LANG_NAME[curLang] || '当前') + '」语言');

    showMcToast({
      icon: '⚙',
      title: '账户偏好设置',
      desc: '你的账户保存了 ' + parts.join(' 和 ') + '，这台设备现在是 ' + curParts.join(' 和 ') + '。要使用账户里的偏好吗？',
      autoHideMs: 15000,
      actions: [
        {
          text: '使用账户偏好',
          cls: 'primary',
          onClick: function () {
            writePrefAck(user, key);
            if (themeDiff) applyTheme(savedTheme, true);
            if (langDiff) {
              // 语言要换站，跳走之后就不用再弹「已套用」了
              location.replace(pathInLang(savedLang) + location.search);
              return;
            }
            showMcToast({
              icon: themeMeta(savedTheme).ico,
              title: '已套用账户偏好',
              desc: '现在是「' + themeName(savedTheme) + '」模式。',
              autoHideMs: 2800
            });
          }
        },
        {
          text: '保持这台设备',
          cls: 'mute',
          onClick: function () { writePrefAck(user, key); }
        }
      ]
    });
  }

  /** 把主题 + 语言压成一个字符串做「这台设备已确认过」的标记 */
  function ackValue(theme, lang) {
    return String(theme || '') + '|' + String(lang || '');
  }

  /**
   * 用户手动切换语言后（已登录）：问要不要把这个语言存成账户默认。
   *   存 → 写账户偏好，然后跳过去（以后任何设备登录都按这个语言）
   *   不存 → 只改本机 Cookie，跳过去；账户偏好保持原样
   * 不管选哪个，都会跳 —— 语言切换本身是立即生效的。
   */
  function askSaveLangPref(want, target, data) {
    var name = SITE_LANG_NAME[want] || want;
    // data 由调用方传入当前这次 /api/status 的结果，不能用 lastStatus
    var logged = data && data.loggedIn ? String(data.username || '') : '';
    showMcToast({
      icon: '🌐',
      title: '账户偏好设置',
      desc: '要把「' + name + '」保存为账户默认语言吗？保存后换设备登录也会用这个语言；不保存就只在这台设备生效。',
      autoHideMs: 18000,
      actions: [
        {
          text: '保存到账户',
          cls: 'primary',
          onClick: function () {
            fetch('/api/pref', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ lang: want })
            }).catch(function () { /* 存失败也照常跳，本机 Cookie 已经改了 */ })
              .then(function () {
                if (logged) writePrefAck(logged, ackValue((data || {}).prefTheme, want));
                location.href = target + location.search;
              });
          }
        },
        {
          text: '只改本机',
          cls: 'mute',
          onClick: function () {
            // 记下「这台设备对这个语言做过选择」，
            // 免得下次切到同一个语言又问一遍。
            if (logged) writePrefAck(logged, ackValue((data || {}).prefTheme, want));
            location.href = target + location.search;
          }
        }
      ]
    });
  }

  /**
   * 未登录时切换语言：语言立刻生效（本机 Cookie 已写），
   * 但「账户偏好设置」得有账户才能存，所以弹一句提示并给登录入口。
   */
  function askLangNoAccount(want, target) {
    var name = SITE_LANG_NAME[want] || want;
    showMcToast({
      icon: '🌐',
      title: '当前未登录账户',
      desc: '已切换到「' + name + '」，这次只在这台设备生效。登录后可以把它保存为账户偏好，换设备也会跟着走。',
      autoHideMs: 18000,
      actions: [
        {
          text: '登录账户',
          cls: 'primary',
          onClick: function () {
            // 登录页也跟着目标语种走，别把繁体用户丢进简体登录页
            var loginBase = (SITE_LANG_SITE[want] || SITE_LANG_SITE.en).replace(/\/$/, '');
            location.href = loginBase + '/login/?lang=' + encodeURIComponent(want) + '&next=' +
              encodeURIComponent(target + location.search);
          }
        },
        {
          text: '继续浏览',
          cls: 'mute',
          onClick: function () { location.href = target + location.search; }
        }
      ]
    });
  }

  /* ==================== 界面语言（与地区解耦） ====================
   * 三档：简 / 繁 / EN。右上角下拉切换。
   *
   * 关键约定：
   *   1) 换语言**不动账户里的地区** —— 语言是「你现在想看哪种文字」，
   *      地区是「你在哪」，两件事分开；
   *   2) 换完弹一次「账户偏好设置」，问要不要把这个语言存成账户默认，
   *      以后在任何设备登录都按它来（这一步和主题共用同一套弹窗）；
   *   3) 未登录也能换，只是不弹偏好设置（没有账户可存）。
   */
  var SITE_LANG_SITE = { zh: '/zh_cn/', zh_hant: '/zh_tw/', en: '/en_us/' };
  var SITE_LANG_NAME = { zh: '简体中文', zh_hant: '繁體中文', en: 'English' };
  var SITE_PREFIXES = [['/zh_tw', 'zh_hant'], ['/zh_cn', 'zh'], ['/en_us', 'en']];

  /** 当前页在哪个语种站；不在任何语种目录就返回 null */
  function currentSiteLang() {
    var p = location.pathname;
    for (var i = 0; i < SITE_PREFIXES.length; i++) {
      var pre = SITE_PREFIXES[i][0];
      if (p === pre || p.indexOf(pre + '/') === 0) return SITE_PREFIXES[i][1];
    }
    return null;
  }

  /** 当前页面路径 → 目标语种的同名页面 */
  function pathInLang(lang) {
    var cur = currentSiteLang();
    var base = SITE_LANG_SITE[lang] || SITE_LANG_SITE.en;
    if (!cur) return base;
    var curBase = SITE_LANG_SITE[cur];
    var rest = location.pathname.slice(curBase.length - 1);
    return base.replace(/\/$/, '') + (rest === '/' ? '/' : rest);
  }

  /** 把站内路径（如 '/contact/'）转成当前语种下的实际路径 */
  function siteUrl(logicalPath) {
    var cur = currentSiteLang();
    var base = SITE_LANG_SITE[cur] || SITE_LANG_SITE.en;
    var p = String(logicalPath || '/');
    if (p.charAt(0) !== '/') p = '/' + p;
    return base.replace(/\/$/, '') + (p === '/' ? '/' : p);
  }

  /* ==================== 地区 → 语种站（自动跟随） ====================
   * 账户在控制台选了「所在地区 / 国籍」后，登录状态下应该停在对应语种站：
   * 选了美国却还站在 /zh_cn/ 上，就自动换到 /en_us/ 的同名页面（反之亦然）。
   *
   * 三条约束：
   *   1) 只跳一次 —— sessionStorage 记住「这台设备已经为该地区跳过一次」，
   *      免得用户手动切回来又被弹走；
   *   2) 用户显式选过语言就不跳 —— 手动切换语言表达的是当下意图，
   *      比地区推断更准，不能拿地区把它覆盖掉；
   *   3) 只在语种目录之间互跳，根路径 / 静态资源不碰。
   */
  var REGION_REDIRECT_KEY = 'zrfeng-region-redirect:';
  var LANG_PICKED_KEY = 'zrfeng-lang-picked';   // 用户手动切过语言的标记

  function regionRedirectKey(user, region) {
    return REGION_REDIRECT_KEY + String(user || '').toLowerCase() + ':' + String(region || '');
  }

  function regionAlreadyJumped(user, region) {
    try { return sessionStorage.getItem(regionRedirectKey(user, region)) === '1'; } catch (e) { return false; }
  }

  function markRegionJumped(user, region) {
    try { sessionStorage.setItem(regionRedirectKey(user, region), '1'); } catch (e) { }
  }

  /** 用户是不是手动切过语言（切过就别再按地区自动跳） */
  function langPickedByUser() {
    try { return localStorage.getItem(LANG_PICKED_KEY) === '1'; } catch (e) { return false; }
  }

  function markLangPicked() {
    try { localStorage.setItem(LANG_PICKED_KEY, '1'); } catch (e) { }
  }

  /** 地区代码 → 目标语种（和服务端 SITE_REGIONS 保持一致） */
  function siteLangOfRegion(region) {
    var r = String(region || '').toUpperCase();
    if (r === 'CN') return 'zh';
    if (r === 'HK' || r === 'MO' || r === 'TW') return 'zh_hant';
    if (r === 'US' || r === 'OTHER') return 'en';
    return null;
  }

  function maybeFollowRegion(data) {
    if (!data || !data.loggedIn) return;
    var user = String(data.username || '');
    var region = data.prefRegion || null;
    if (!user || !region) return;

    // 用户手动切过语言 → 尊重他的选择，不按地区覆盖
    if (langPickedByUser()) return;

    var wantLang = siteLangOfRegion(region);
    if (!wantLang) return;

    var curLang = currentSiteLang();
    if (!curLang) return;   // 不在任何语种目录里，不插手

    if (curLang === wantLang) {
      // 已经在正确的语种站 → 清标记，下次换地区还能再跳
      try { sessionStorage.removeItem(regionRedirectKey(user, region)); } catch (e) { }
      return;
    }
    if (regionAlreadyJumped(user, region)) return;

    markRegionJumped(user, region);
    location.replace(pathInLang(wantLang) + location.search);
  }


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
      '<a href="' + siteUrl('/contact/') + '">联系我们</a>' +
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

  /* ==================== 封禁弹窗 ==================== */

  function hideBanned() {
    var m = document.getElementById(BAN_ID);
    if (m) m.remove();
  }

  /** VPN / 代理被封：文案与普通封禁不同，第一行英文标题、第二行中文说明 */
  var PROXY_MSG = 'You are blocked!\n检测到VPN或代理，您的账户已被封停，现在请立刻关闭VPN或代理，并联系支持人员';

  function showProxyBlock(raw) {
    if (document.getElementById(BAN_ID)) return;
    var lines = String(raw || PROXY_MSG).split('\n').filter(function (x) { return x.trim(); });
    var title = lines.length > 1 ? lines.shift() : 'You are blocked!';
    var body = lines.join(' ') || '检测到VPN或代理，您的账户已被封停，现在请立刻关闭VPN或代理，并联系支持人员';
    var mask = document.createElement('div');
    mask.id = BAN_ID;
    mask.innerHTML =
      '<div class="bn-card">' +
      '<h2>' + escHtml(title) + '</h2>' +
      '<p>' + escHtml(body) + '</p>' +
      '<div class="bn-acts">' +
      '<a href="' + siteUrl('/contact/') + '">联系我们</a>' +
      '<button type="button" id="dsh-ban-out">关闭</button>' +
      '</div></div>';
    document.body.appendChild(mask);
    var out = document.getElementById('dsh-ban-out');
    if (out) out.onclick = function () { hideBanned(); };
  }
  // 登录 / 注册页拿到 403 时直接调它弹出这句话
  window.zrfengProxyBlock = showProxyBlock;

  function showBanned(acc) {
    // 被 VPN / 代理检测封掉的，用专门的文案
    if (acc && acc.banReason === 'proxy') { showProxyBlock(PROXY_MSG); return; }
    if (document.getElementById(BAN_ID)) return;
    // 用**本地时间**显示封禁时段（服务端只给时间戳），支持「期限封禁」与「永久封禁」
    var meta = '';
    if (acc && (acc.banFrom || acc.banUntil)) {
      // 完整的起止时间：开始 →（结束 或 永久）
      meta += '<p class="bn-meta">封禁时段：' + (acc.banFrom ? fmtClock(acc.banFrom) : '—') +
        ' → ' + (acc.banUntil ? fmtClock(acc.banUntil) : '永久') + '</p>';
    }
    if (acc && acc.banPermanent) {
      // 永久封禁：和「试用期仅剩-1天」一样，用 -1天 表示永不到期
      meta += '<p class="bn-meta">剩余封禁时间 <b>-1天</b>（永久封禁，不会自动解封）</p>';
    } else if (acc && acc.banUntil) {
      meta += '<p class="bn-meta">剩余封禁时间 <span id="dsh-ban-left">' +
        fmtLeft(Math.max(0, Number(acc.banRemainingMs) || 0)) + '</span>（到期自动解封）</p>';
    } else if (acc && acc.bannedAt) {
      meta += '<p class="bn-meta">封禁时间：' + fmtClock(acc.bannedAt) + '</p>';
    }
    var mask = document.createElement('div');
    mask.id = BAN_ID;
    mask.innerHTML =
      '<div class="bn-card">' +
      '<h2>账户异常</h2>' +
      '<p>该账户已被管理员封禁，请联系管理员。</p>' +
      meta +
      '<div class="bn-acts">' +
      '<a href="' + siteUrl('/contact/') + '">联系我们</a>' +
      '<button type="button" id="dsh-ban-out">退出登录</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(mask);
    var out = document.getElementById('dsh-ban-out');
    if (out) {
      out.onclick = function () {
        fetch('/api/logout', { method: 'POST' }).then(function () {
          location.href = siteUrl('/');
        });
      };
    }
  }

  /* ==================== 账户警告弹窗 ==================== */

  function hideWarn() {
    var m = document.getElementById(WARN_ID);
    if (m) m.remove();
  }

  /**
   * 管理员发的警告。**警告内容是管理员手填的**，所以只走 textContent，
   * 绝不拼进 innerHTML —— 否则谁都能在警告里塞一段脚本。
   */
  function showWarn(w) {
    if (document.getElementById(WARN_ID)) return;
    if (!w || !w.text) return;
    var mask = document.createElement('div');
    mask.id = WARN_ID;
    mask.innerHTML =
      '<div class="wn-card">' +
      '<div class="wn-badge">账户警告</div>' +
      '<h2>收到一条管理员警告</h2>' +
      '<div class="wn-text" id="dsh-warn-text"></div>' +
      (w.by ? '<p class="wn-by">来自管理员：' + escHtml(w.by) + '</p>' : '') +
      '<p class="wn-note">确认后不再弹出；你可以在「通知板块 → 我的消息」里随时回顾。</p>' +
      '<div class="wn-acts">' +
      '<button type="button" id="dsh-warn-ok">我知道了</button>' +
      '<a href="' + siteUrl('/notice/') + '">去通知板块</a>' +
      '</div>' +
      '</div>';
    document.body.appendChild(mask);

    var t = document.getElementById('dsh-warn-text');
    if (t) t.textContent = String(w.text || '');

    var ok = document.getElementById('dsh-warn-ok');
    if (ok) {
      ok.onclick = function () {
        hideWarn();
        fetch('/api/warnings/seen', { method: 'POST' }).catch(function () {
          /* 记不上就算了，下次还会弹，总比看不见强 */
        });
      };
    }
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

  /**
   * 维护进度（0–100 的整数）。
   * 「按维护时间算」：刚开始 = 0%，到点 = 100%。
   */
  function maintPercent(st) {
    if (!st || !st.start || !st.end || st.end <= st.start) return 0;
    var now = Date.now();
    if (now <= st.start) return 0;
    if (now >= st.end) return 100;
    return Math.floor(((now - st.start) / (st.end - st.start)) * 100);
  }

  /** 刷新弹窗里的「已完成 xx%」（顺带刷新剩余时间，若界面上有） */
  function updateMaintMeters(st) {
    var p = document.getElementById('dsh-mt-pct');
    if (p) p.textContent = maintPercent(st) + '%';
    var l = document.getElementById('dsh-mt-left');
    if (l && st && st.end) l.textContent = fmtLeft(Math.max(0, st.end - Date.now()));
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
      updateMaintMeters(st);
      return;
    }
    var mask = document.createElement('div');
    mask.id = MAINT_ID;
    mask.innerHTML =
      '<div class="mt-card">' +
      '<p class="mt-quote">海内存知己，天涯若比邻</p>' +
      '<h2>正在维护服务</h2>' +
      '<p class="mt-pct">已完成 <b id="dsh-mt-pct">' + maintPercent(st) + '%</b></p>' +
      '<div class="mt-acts"><button type="button" id="dsh-mt-admin">管理员关闭</button></div>' +
      '<div class="mt-note" id="dsh-mt-note">管理员可进入控制台关闭维护</div>' +
      (st && st.keySet
        ? '<details class="mt-staff"><summary>工作人员预览入口</summary>' +
          '<input id="dsh-mt-key" type="password" placeholder="本次维护访问密钥" autocomplete="off">' +
          '<button type="button" id="dsh-mt-enter">进入预览</button>' +
          '<div class="mt-staff-msg" id="dsh-mt-smsg"></div></details>'
        : '') +
      '</div>';
    document.body.appendChild(mask);

    // 「管理员关闭」：管理员跳转到控制台去处理；没有权限则明确拒绝。
    // 按钮对所有人可见，所以权限判断必须在这里做，而不是靠隐藏按钮。
    var btn = document.getElementById('dsh-mt-admin');
    if (btn) {
      btn.onclick = function () {
        if (isAdmin) {
          location.href = siteUrl('/console/');
          return;
        }
        var n = document.getElementById('dsh-mt-note');
        if (n) {
          n.textContent = '你无权进行此操作';
          n.style.color = '#ff7b7b';
        }
      };
    }

    // 工作人员预览：凭本次维护的访问密钥换取通行证，然后就能正常浏览站点
    var enter = document.getElementById('dsh-mt-enter');
    if (enter) {
      var kEl = document.getElementById('dsh-mt-key');
      var sMsg = document.getElementById('dsh-mt-smsg');
      var go = function () {
        var v = kEl ? kEl.value.trim() : '';
        if (!v) { if (sMsg) { sMsg.textContent = '请输入访问密钥'; sMsg.style.color = '#ff7b7b'; } return; }
        enter.disabled = true;
        fetch('/api/maintenance/unlock', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: v }),
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (!j.ok) {
              if (sMsg) { sMsg.textContent = j.message || '密钥不正确'; sMsg.style.color = '#ff7b7b'; }
              enter.disabled = false;
              return;
            }
            if (sMsg) { sMsg.textContent = '已进入预览模式，正在刷新…'; sMsg.style.color = '#00ff8c'; }
            setTimeout(function () { location.reload(); }, 500);
          })
          .catch(function () {
            if (sMsg) { sMsg.textContent = '网络错误'; sMsg.style.color = '#ff7b7b'; }
            enter.disabled = false;
          });
      };
      enter.onclick = go;
      if (kEl) kEl.onkeydown = function (e) { if (e.key === 'Enter') go(); };
    }

    updateMaintMeters(st);
    if (maintTickTimer) clearInterval(maintTickTimer);
    maintTickTimer = setInterval(function () {
      if (!endAt || Date.now() >= endAt) {
        hideMaintenance();
        load();
        return;
      }
      updateMaintMeters(st);
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
  /**
   * 是否正处在「联系我们」页面。
   * 这个页面必须**绝对干净** —— 封禁、维护、未激活……什么都不显示，
   * 否则被封禁的人连联系管理员都做不到。
   */
  function onContactPage() {
    try {
      return typeof location !== 'undefined' && !!location.pathname &&
        (location.pathname.indexOf('/contact') === 0);
    } catch (e) {
      return false;
    }
  }

  /** 是否正处在控制台页面（管理员在这里不弹维护窗，否则会挡住自己） */
  function onConsolePage() {
    try {
      return typeof location !== 'undefined' && !!location.pathname && location.pathname.indexOf('/console') === 0;
    } catch (e) {
      return false;
    }
  }

  /**
   * 路径 → 页面 id。
   * ⚠️ 必须和 worker.js 里的 MAINT_PAGES 保持一致（那边是唯一的主人，
   *    这里只是浏览器端的一份镜像，用来判断「当前这一页在不在维护范围里」）。
   * 前缀匹配。「联系我们」故意不在这里 —— 它永远不弹任何弹窗。
   */
  var PAGE_PATHS = [
    ['/aboutus', 'aboutus'],
    ['/time', 'time'],
    ['/guide', 'guide'],
    ['/notice', 'notice'],
    ['/sponsorship', 'sponsorship'],
    ['/file', 'file'],
    ['/login', 'login'],
    ['/console', 'console'],
    ['/chat', 'chat'],
    ['/updates', 'updates'],
  ];

  /**
   * 去掉语种目录前缀：/zh_cn/notice/、/zh_tw/notice/、/en_us/notice/
   * 都按 /notice/ 处理。站点拆成多个语种目录后，维护范围判断不能再看完整路径，
   * 否则三边对不上（早先漏了 zh_tw，导致繁体站的维护标记失效）。
   */
  function langlessPath(path) {
    var p = String(path || '/');
    var prefixes = ['/zh_tw', '/zh_cn', '/en_us'];
    for (var i = 0; i < prefixes.length; i++) {
      var pre = prefixes[i];
      if (p === pre) return '/';
      if (p.indexOf(pre + '/') === 0) return p.slice(pre.length) || '/';
    }
    return p;
  }

  function pageIdOf(path) {
    var p = langlessPath(path);
    for (var i = 0; i < PAGE_PATHS.length; i++) {
      var pre = PAGE_PATHS[i][0];
      if (p === pre || p === pre + '.html' || p.indexOf(pre + '/') === 0) return PAGE_PATHS[i][1];
    }
    if (p === '/' || p === '/index.html' || p === '') return 'home';
    return null;
  }

  /**
   * 当前这一页要不要弹维护窗。
   *   pages 为空 → 全站维护（和以前的行为完全一样）
   *   pages 有值 → 只有勾选的那几个页面弹
   *   拿着工作人员通行证（unlocked）→ 永远不弹，但导航页的 Offline 灯照常显示
   */
  function maintHits(st) {
    if (!st || !st.active) return false;
    // 「联系我们」必须绝对干净：被封禁的人要靠它联系管理员
    if (onContactPage()) return false;
    var list = st.pages;
    if (!list || !list.length) return true;
    var id = pageIdOf(location.pathname);
    return !!id && list.indexOf(id) >= 0;
  }

  /**
   * 给带 data-page 的入口标上 Online / Offline（导航页靠它显示每个页面的状态）。
   * 维护中且这一页在范围内 → Offline；否则恢复这个入口原本的文字
   * （普通入口是 Online，控制台那个是「需登录」）。
   */
  function applyPageStatus(st) {
    var boxes;
    try {
      boxes = document.querySelectorAll('[data-page]');
    } catch (e) {
      return;
    }
    if (!boxes || !boxes.length) return;

    var live = !!(st && st.active);
    var list = (st && st.pages) || [];
    var all = live && !list.length;

    for (var i = 0; i < boxes.length; i++) {
      var el = boxes[i];
      var id = el.getAttribute('data-page');
      var down = all || (live && list.indexOf(id) >= 0);
      el.setAttribute('data-down', down ? '1' : '0');
      var s = el.querySelector('.status');
      if (!s) continue;
      var txt = down ? 'Offline' : el.getAttribute('data-default') || 'Online';
      s.innerHTML = '<span class="dot"></span>' + txt;
    }
  }

  function applyMaintenance(st, isAdmin) {
    var win = st && st.set ? { start: st.start, end: st.end } : null;
    maintCur = win;

    var skipForAdmin = isAdmin && onConsolePage();
    // 拿着工作人员通行证：不弹（但导航页的 Offline 灯不受影响，那边看的是真实维护状态）
    var unlocked = !!(st && st.unlocked);

    if (maintHits(st) && !skipForAdmin && !unlocked) {
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
    // 「联系我们」页：什么都不显示 —— 连状态栏带各种弹窗全部清掉后直接返回。
    // 封禁 / 维护 / 未激活都绝不能挡在这里，否则用户没法联系管理员。
    if (onContactPage()) {
      var ob = document.getElementById(BAR_ID);
      if (ob) ob.remove();
      hideBanned();
      hideBlocked();
      hideMaintenance();
      hideWarn();
      stopCountdown();
      return;
    }

    var acc = (data && data.account) || { state: 'guest', dot: 'red', label: '登录以享受服务', activated: false };
    stopCountdown();

    var old = document.getElementById(BAR_ID);
    if (old) old.remove();

    var bar = document.createElement('div');
    bar.id = BAR_ID;

    var left = document.createElement('div');
    left.className = 'sb-l';
    // 二次验证已关闭时不再显示绿点 —— 绿点代表「账户正常」，
    // 风险提示和绿点放在一起会自相矛盾，直接去掉圆点。
    if (!acc.twofaOff) {
      var dot = document.createElement('span');
      dot.className = 'sb-dot ' + (acc.dot || 'red');
      left.appendChild(dot);
    }

    var cdEl = null;
    var preEl = null;
    var preShortEl = null;

    if (acc.state === 'guest') {
      var a = document.createElement('a');
      a.className = 'sb-text';
      a.href = siteUrl('/login/');
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
    } else if (acc.state === 'banned') {
      // 左上角「账户异常」+ 剩余封禁时间：
      //   有期限 → 「账户异常，剩余封禁时间 3天 12:34:56」（逐秒递减）
      //   永久   → 「账户异常，剩余封禁时间 -1天」（和「试用期仅剩-1天」一个写法）
      preEl = document.createElement('span');
      preEl.className = 'sb-pre';
      preEl.textContent = '账户异常，剩余封禁时间 ';
      preShortEl = document.createElement('span');
      preShortEl.className = 'sb-pre-s';
      preShortEl.textContent = '账户异常 ';
      cdEl = document.createElement('span');
      cdEl.className = 'sb-cd';
      cdEl.textContent = acc.banPermanent
        ? '-1天'
        : fmtLeft(Math.max(0, Number(acc.banRemainingMs) || 0));
      left.appendChild(preEl);
      left.appendChild(preShortEl);
      left.appendChild(cdEl);
    } else {
      var t = document.createElement('span');
      t.className = 'sb-text';
      if (acc.twofaOff) {
        // 二次验证已关闭：把「账户正常」整段换掉，改成感叹号 + 风险提示。
        // 服务端判定（account.twofaOff），前端只负责显示。
        t.className = 'sb-text sb-risk-text';
        var ex = document.createElement('span');
        ex.className = 'sb-ex';
        ex.textContent = '!';
        // 服务端已按语种转换过 account.* 的文案（见 localizeResponse）：
        // 简体原文、繁体已繁化、英文走 riskLabelEn。这里直接用即可。
        var riskText = acc.riskLabel || '该账户有被劫持的风险';
        ex.title = riskText;
        t.appendChild(ex);
        t.appendChild(document.createTextNode(riskText));
      } else {
        t.textContent = acc.label || '';
      }
      left.appendChild(t);
    }
    bar.appendChild(left);

    var right = document.createElement('div');
    right.className = 'sb-r';

    /* 右上角语言选择器：三档，和地区无关，未登录也能用。
       放在控制台 / 登出前面，保证任何状态下都在最右侧固定位置。 */
    (function addLangSwitch() {
      var cur = currentSiteLang() || 'en';
      var wrap = document.createElement('span');
      wrap.className = 'sb-lang';
      var sel = document.createElement('select');
      sel.setAttribute('aria-label', '选择语言 / Language');
      sel.title = '选择界面语言（不影响账户地区）';
      [['zh', '简体'], ['zh_hant', '繁體'], ['en', 'EN']].forEach(function (p) {
        var o = document.createElement('option');
        o.value = p[0];
        o.textContent = p[1];
        if (p[0] === cur) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = function () {
        var want = sel.value;
        if (want === currentSiteLang()) return;
        // 本机选择先落地：不管后面弹不弹窗、跳不跳，刷新后语言都得留住。
        // 同时打上「用户手动选过」标记 —— 否则按地区自动跟随会把它覆盖回去。
        try {
          // 和 worker 写的 langCookieHeader 保持一致；https 下补 Secure
          var secure = location.protocol === 'https:' ? '; Secure' : '';
          document.cookie = 'zrfeng-lang=' + want + '; Path=/; Max-Age=15552000; SameSite=Lax' + secure;
        } catch (e) { }
        markLangPicked();
        var target = pathInLang(want);
        // ⚠️ 这里必须用闭包里的 data，不能用 lastStatus ——
        // 状态栏构建时 lastStatus 还没赋值（它在函数末尾才写），
        // 早先判断 lastStatus.loggedIn 永远是 false，所以从不弹偏好设置。
        if (data && data.loggedIn) {
          // 账户里已经是这个语言了 → 没什么可问的，直接跳。
          // （之前无条件弹窗，导致「切走再切回来」也会被问一遍，很烦。）
          if (data.prefLang === want) {
            location.href = target + location.search;
            return;
          }
          askSaveLangPref(want, target, data);
          return;
        }
        // 未登录：也弹一次，告诉他账户偏好设置需要登录，顺便给个登录入口
        askLangNoAccount(want, target);
      };
      wrap.appendChild(sel);
      right.appendChild(wrap);
    })();
    // 右上角控制台：已激活（完成邮箱验证）的用户可见。
    // 管理员额外可见 —— 否则没人能去激活被拦截的账户。
    if (data && data.loggedIn && (acc.activated || data.isAdmin)) {
      var c = document.createElement('a');
      c.className = 'sb-btn';
      c.href = siteUrl('/console/');
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
    // 记录本次状态；顺便判断要不要问「是否套用账户偏好」（每页只问一次）
    lastStatus = data;
    maybeAskUsePref(data);
    // 账户选过「所在地区」→ 停到对应语种站（每台设备每个地区只跳一次）
    maybeFollowRegion(data);

    // 与服务端重新对齐：只有真的 blocked 才弹窗
    if (acc.state === 'blocked') {
      showBlocked();
    } else {
      hideBlocked();
    }

    // 被封禁：弹出「账户异常」（含封禁起止时间与剩余时间）
    if (acc.state === 'banned') {
      showBanned(acc);
    } else {
      hideBanned();
    }

    // 账户警告：管理员发的、还没看过的警告弹一次（内容由管理员手填）
    var warning = (data && data.warning) || null;
    if (warning && warning.unread > 0 && warning.last) {
      showWarn(warning.last);
    }

    // 维护时段：到点自动弹出 / 到点自动关闭（页面维护时只有勾选的页面会弹）
    applyMaintenance(data && data.maintenance, !!(data && data.isAdmin));
    // 导航页：被维护的页面显示 Offline，其余显示 Online（或它原本的文字）
    applyPageStatus(data && data.maintenance);

    // 启动每秒倒计时（试用期 或 剩余封禁时间）
    var isBanBar = acc.state === 'banned';
    var tickMs = isBanBar
      ? (acc.banPermanent ? 0 : Math.max(0, Number(acc.banRemainingMs) || 0))
      : (typeof acc.remainingMs === 'number' ? acc.remainingMs : 0);
    if (cdEl && tickMs > 0) {
      var endAt = Date.now() + tickMs;
      countdownTimer = setInterval(function () {
        var leftMs = endAt - Date.now();
        if (leftMs <= 0) {
          stopCountdown();
          cdEl.textContent = '0天 00:00:00';
          if (isBanBar) {
            // 到点自动解封：先关掉弹窗，再与服务端确认
            if (preEl) preEl.textContent = '账户异常，已到解封时间 ';
            if (preShortEl) preShortEl.textContent = '已解封 ';
            hideBanned();
          } else {
            if (preEl) preEl.textContent = '未激活，试用期已到';
            if (preShortEl) preShortEl.textContent = '已到期';
            showBlocked();
          }
          // 与服务端确认一次（客户端时钟可能偏差），3 秒后同步
          setTimeout(load, 3000);
          return;
        }
        cdEl.textContent = fmtLeft(leftMs);
        // 封禁弹窗里那个「剩余封禁时间」也跟着倒数
        if (isBanBar) {
          var bl = document.getElementById('dsh-ban-left');
          if (bl) bl.textContent = fmtLeft(leftMs);
        }
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
    // 先落地已保存的主题（页面 <head> 里还有一段内联脚本做更早的一次，避免闪白）
    applyTheme(readTheme(), false);
    // 老用户还在用已下线的旧主题 → 提示一次并切到新主题（用新主题的人看不到）
    warnLegacyTheme();
    // 同浏览器别的标签页切了主题，这里跟着变
    window.addEventListener('storage', function (e) {
      if (e.key === THEME_KEY) applyTheme(readTheme(), false);
    });
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
