/**
 * zrfeng.top 后端（Cloudflare Worker）
 * ---------------------------------------------------------------------------
 * 提供：注册、登录、邮箱验证码、人机验证、下载门控、意见工单。
 *
 * ⚠️ 重要安全约定
 * 本文件会提交到**公开仓库**，任何人可见。因此：
 *   - 站内下载文件存在 KV（file:novel）里，绝不写进本文件；
 *   - 管理员密码存放在密钥 ADMIN_PASSWORD；
 *   - 邮件 API Key、会话签名密钥同理，全部走密钥。
 * 本文件里出现的任何明文密码/链接都等于公开。
 *
 * 需要的绑定与密钥（在 Cloudflare 控制台或 wrangler 里配置）：
 *   KV 命名空间绑定  USERS
 *   KV 键    file:novel       站内直接下载的文件（base64，不放进公开仓库）
 *   密钥 ADMIN_USERNAME     主管理员账户名（不设则不自动建号）
 *   密钥 ADMIN_PASSWORD     主管理员密码
 *   密钥 ADMIN_EMAIL        （可选）主管理员邮箱，允许用邮箱登录
 *   密钥 TRIAL_ACCOUNT      试用账户名（不设则不自动建号）
 *   密钥 TRIAL_PASSWORD     试用账户密码
 *   密钥 SESSION_SECRET     会话/验证码签名密钥（必填，任意长随机串）
 *   密钥 RESEND_API_KEY     邮件服务密钥（真发验证码用）
 *   密钥 MAIL_FROM          发件人，如 "zrfeng.top <noreply@zrfeng.top>"
 *   可选 TURNSTILE_SECRET   Cloudflare 人机验证密钥；不设则用算术题验证
 */

/* ========================== 常量配置 ========================== */

/** 只允许这些邮箱后缀，其余一律拒绝 */
const ALLOWED_SUFFIXES = ['.com', '.cn', '.net', '.top'];

/** 会话有效期（秒）：7 天 */
const SESSION_TTL = 7 * 24 * 3600;

/** 验证码有效期（秒）：10 分钟 */
const CODE_TTL = 10 * 60;

/** 同一邮箱发送验证码的最小间隔（秒） */
const CODE_COOLDOWN = 60;

/** 设备登录票据有效期（秒）：10 分钟 */
const DEVLOGIN_TTL = 10 * 60;

/** 每个账户最多记住几台设备 */
const MAX_DEVICES = 20;

/** 设备标记 Cookie 的有效期（秒）：约 400 天 */
const DEVICE_COOKIE_TTL = 400 * 24 * 3600;

/** 注销确认码有效期（秒）：10 分钟 */
const DELCODE_TTL = 10 * 60;

/** 人机验证票据有效期（秒） */
const CAPTCHA_TTL = 5 * 60;

/** PBKDF2 迭代次数。Workers 免费版 CPU 有限，不宜过高 */
const PBKDF2_ITERATIONS = 15000;

/** 保留用户名，不允许注册（admin / 试用账户名另外由密钥决定，见 reservedNames） */
const RESERVED = new Set(['administrator', 'root', 'system', 'zrfeng']);

/* -------- 意见工单（「联系我们」页的提交工单） -------- */

/** 标题最少字数：少于这个数直接当垃圾工单销毁 */
const TICKET_TITLE_MIN = 3;

/** 正文最少字数：少于这个数直接当垃圾工单销毁 */
const TICKET_BODY_MIN = 10;

/** 标题 / 正文的硬上限，防止有人塞进一整本书 */
const TICKET_TITLE_MAX = 80;
const TICKET_BODY_MAX = 2000;

/** 联系方式最多多少字 */
const TICKET_CONTACT_MAX = 100;

/** 同一个 IP 两次提交工单的最小间隔（秒） */
const TICKET_COOLDOWN = 60;

/** 一天最多收多少条有效工单（保护 KV 免费额度：免费版每天只有 1000 次写） */
const TICKET_DAILY_MAX = 50;

/** KV 里最多保留多少条工单，超出的从最旧的开始删 */
const TICKET_MAX_KEEP = 100;

/** 工单在 KV 里的键前缀（键是 ticket:<15 位时间戳>-<随机>，字典序即时间序） */
const TICKET_PREFIX = 'ticket:';

/** 工单节奏限制的键前缀（故意和 TICKET_PREFIX 不构成包含关系，免得被一起列出来） */
const TICKET_CD_PREFIX = 'ticketcd:';

/** 管理员上次查看工单的时间（用于「有 N 条新工单」） */
const TICKET_READ_KEY = 'ticketsread';

/* ========================== 通知板块 ========================== */

/** 公开公告在 KV 里的键前缀（键是 notice:<15 位时间戳>-<随机>，字典序即时间序） */
const NOTICE_PREFIX = 'notice:';

/** 公告最多保留多少条，超出的从最旧的开始删 */
const NOTICE_MAX_KEEP = 200;

/** 公告列表分页：默认每页 10 条，前端可通过 ?limit= 调整（上限 100） */
const NOTICE_PAGE_DEFAULT = 10;
const NOTICE_PAGE_MAX = 100;

/** 公告标题 / 正文的长度限制 */
const NOTICE_TITLE_MAX = 80;
const NOTICE_BODY_MAX = 2000;
const NOTICE_TITLE_MIN = 2;
const NOTICE_BODY_MIN = 2;
const NOTICE_DAILY_MAX = 100;

/** 个人通知的键前缀：notif:u:<账户>:… 或 notif:d:<设备 id>:… */
const NOTIF_PREFIX = 'notif:';
const NOTIF_ACCOUNT_PREFIX = NOTIF_PREFIX + 'u:';
const NOTIF_DEVICE_PREFIX = NOTIF_PREFIX + 'd:';
/** 每个人最多保留多少条个人通知 */
const NOTIF_MAX_KEEP = 100;

/** 工单里的回复 / 通知，正文长度限制 */
const REPLY_MAX = 1000;
const REPLY_MIN = 1;

/* ========================== 账户警告 ========================== */

/** 警告在 KV 里的键前缀：warn:<账户>:<15 位时间戳>-<随机> */
const WARN_PREFIX = 'warn:';
/** 某账户「已看到警告」的时间戳：warnseen:<账户> */
const WARN_SEEN_PREFIX = 'warnseen:';
/** 每个账户最多保留多少条警告 */
const WARN_MAX_KEEP = 20;
/** 警告内容的长度限制（内容由管理员自己填） */
const WARN_TEXT_MAX = 500;
const WARN_TEXT_MIN = 1;

/**
 * 管理员与试用账户的账户名 / 密码全部来自 Cloudflare 密钥，
 * 不写死在代码里 —— 否则会随公开仓库一起泄露。
 */
const adminUsername = (env) => String(env.ADMIN_USERNAME || '').trim().toLowerCase();
const adminEmail = (env) => String(env.ADMIN_EMAIL || '').trim().toLowerCase();
const trialUsername = (env) => String(env.TRIAL_ACCOUNT || '').trim().toLowerCase();

/** 32 位随机字母数字（大小写混合），区分大小写 */
function randomAlnum(n = RECOVER_RAND_LEN) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const hex = randomHex(n + 16);
  let out = '';
  for (let i = 0; i + 1 < hex.length && out.length < n; i += 2) {
    out += chars[parseInt(hex.substr(i, 2), 16) % chars.length];
  }
  return out;
}

/**
 * 生成恢复代码：
 *   key--用户名:邮箱:密码--32位随机   （账户没有邮箱时省略邮箱那一段）
 *
 * ⚠️ 代码里带着密码明文 —— 因为「在控制台里把它显示给用户看」就意味着
 * 服务端必须能还原出密码。生成它的前提是调用方手里正好有密码明文
 * （注册、改密码、初始化管理员/试用账户时）。
 */
function makeRecoveryCode(user, plainPassword) {
  const head = user.email
    ? user.username + ':' + user.email + ':' + plainPassword
    : user.username + ':' + plainPassword;
  return 'key--' + head + '--' + randomAlnum(RECOVER_RAND_LEN);
}

/**
 * 从恢复代码里取出「用户名」和候选密码。
 * 密码本身可能含冒号，所以按账户有没有邮箱分两种切法。
 */
function parseRecoveryCode(code) {
  const m = String(code || '').trim().match(/^key--([\s\S]+)--([A-Za-z0-9]{32})$/);
  if (!m) return null;
  const parts = m[1].split(':');
  if (parts.length < 2) return null;
  return { username: parts[0].trim().toLowerCase(), rest: parts.slice(1), rand: m[2] };
}

/** 拿恢复代码去核对某个账户：返回 true 表示代码里的密码与该账户一致 */
async function verifyRecoveryCode(user, parsed) {
  if (!user || !parsed) return false;
  if (user.username !== parsed.username) return false;
  // 有邮箱时，第二段应当就是邮箱；否则整段都是密码
  let pw = '';
  if (user.email && parsed.rest.length >= 2 && parsed.rest[0].toLowerCase() === user.email) {
    pw = parsed.rest.slice(1).join(':');
  } else {
    pw = parsed.rest.join(':');
  }
  if (!pw) return false;
  const hash = await hashPassword(pw, user.salt);
  return timingSafeEqual(hash, user.hash);
}

/** 换一个新密码：更新哈希、重置恢复代码、踢掉所有会话 */
async function applyNewPassword(env, user, newPassword) {
  user.salt = randomHex(16);
  user.hash = await hashPassword(newPassword, user.salt);
  user.recoveryCode = makeRecoveryCode(user, newPassword);
  user.passwordChangedAt = Date.now();
  await putUser(env, user);
  return await deleteUserSessions(env, user.username, null);
}

/** 不允许注册的名字（含运行时的管理员 / 试用账户名） */
function reservedNames(env) {
  const set = new Set(RESERVED);
  const a = adminUsername(env);
  const t = trialUsername(env);
  if (a) set.add(a);
  if (t) set.add(t);
  return set;
}

/** 试用账户天数（未激活账户的倒计时） */
const TRIAL_DAYS = 7;


/* ========================== 工具函数 ========================== */

const enc = new TextEncoder();

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function randomHex(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** 常数时间比较，避免计时攻击 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** PBKDF2-SHA256 口令哈希 */
async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: hexToBytes(saltHex),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    key,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

/** HMAC-SHA256 签名，用于无状态票据 */
async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

/* ========================== 邮箱校验 ========================== */

/**
 * 校验邮箱：格式正确 + 后缀在白名单内。
 * 返回 { ok: true, email } 或 { ok: false, message }
 */
function validateEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();

  if (!email) return { ok: false, message: '请输入邮箱' };

  // 基本格式：本地部分@域名，域名含至少一个点
  const m = email.match(/^([a-z0-9._%+-]+)@([a-z0-9-]+(\.[a-z0-9-]+)+)$/);
  if (!m) return { ok: false, message: '邮箱格式不正确' };

  const local = m[1];
  const domain = m[2];

  if (local.length > 64 || email.length > 254) {
    return { ok: false, message: '邮箱长度超出限制' };
  }
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return { ok: false, message: '邮箱格式不正确' };
  }

  // 后缀白名单
  const matched = ALLOWED_SUFFIXES.some((s) => domain.endsWith(s));
  if (!matched) {
    return {
      ok: false,
      message: `暂不支持该邮箱，仅支持 ${ALLOWED_SUFFIXES.join(' / ')} 结尾的邮箱`,
    };
  }

  return { ok: true, email };
}

/* ========================== 人机验证 ========================== */

/**
 * 签发算术题票据（无状态，答案签名在里面）。
 * 未配置 TURNSTILE_SECRET 时使用。
 */
async function issueCaptcha(env) {
  const a = 2 + Math.floor(Math.random() * 8);
  const b = 2 + Math.floor(Math.random() * 8);
  const op = Math.random() < 0.5 ? '+' : '×';
  const answer = op === '+' ? a + b : a * b;
  const exp = Date.now() + CAPTCHA_TTL * 1000;
  const payload = `${answer}.${exp}`;
  const sig = await hmac(env.SESSION_SECRET, 'captcha:' + payload);
  return {
    id: `${payload}.${sig}`,
    question: `${a} ${op} ${b} = ?`,
  };
}

/** 校验算术题票据 */
async function verifyCaptcha(env, id, answer) {
  if (!id || !answer) return false;
  const parts = String(id).split('.');
  if (parts.length !== 3) return false;
  const [expected, exp, sig] = parts;
  const payload = `${expected}.${exp}`;
  const good = await hmac(env.SESSION_SECRET, 'captcha:' + payload);
  if (!timingSafeEqual(sig, good)) return false;
  if (Date.now() > Number(exp)) return false;
  return timingSafeEqual(String(answer).trim(), expected);
}

/** 校验 Turnstile（配置了密钥时使用） */
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return null; // 未配置 → 不走这条路
  if (!token) return false;
  try {
    const body = new FormData();
    body.append('secret', env.TURNSTILE_SECRET);
    body.append('response', token);
    if (ip) body.append('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const j = await r.json();
    return j.success === true;
  } catch {
    return false;
  }
}

/**
 * 统一的人机验证入口。
 * 配置了 Turnstile 就必须过 Turnstile；否则过算术题。
 */
async function checkHuman(env, payload, ip) {
  if (env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(env, payload.turnstileToken, ip);
    return ok ? { ok: true } : { ok: false, message: '人机验证未通过，请重试' };
  }
  const ok = await verifyCaptcha(env, payload.captchaId, payload.captchaAnswer);
  return ok ? { ok: true } : { ok: false, message: '人机验证答案不正确' };
}

/* ========================== 账号 ========================== */

async function getUser(env, account) {
  const key = 'user:' + String(account || '').trim().toLowerCase();
  return await env.USERS.get(key, 'json');
}

async function putUser(env, user) {
  await env.USERS.put('user:' + user.username, JSON.stringify(user));
  if (user.email) await env.USERS.put('email:' + user.email, user.username);
}

/* ---------------- 账户偏好（跨设备同步用，目前只有亮/暗色主题） ----------------
 * 单独用一个 pref:<用户名> 键，绝不改动 user: 记录 ——
 * 这样写偏好永远碰不到密码、邮箱、权限这些字段。
 */
function prefKey(username) {
  return 'pref:' + String(username || '').trim().toLowerCase();
}

async function getPref(env, username) {
  const key = prefKey(username);
  if (key === 'pref:') return null;
  const raw = await env.USERS.get(key, 'json');
  return raw && typeof raw === 'object' ? raw : null;
}

async function putPref(env, username, patch) {
  const key = prefKey(username);
  if (key === 'pref:') return null;
  const cur = (await env.USERS.get(key, 'json')) || {};
  const next = Object.assign({}, cur, patch || {}, { at: Date.now() });
  await env.USERS.put(key, JSON.stringify(next));
  return next;
}

/** 按账号名或邮箱找到用户 */
async function findByLogin(env, account) {
  const a = String(account || '').trim().toLowerCase();
  if (!a) return null;
  let u = await env.USERS.get('user:' + a, 'json');
  if (u) return u;
  const username = await env.USERS.get('email:' + a);
  if (username) u = await env.USERS.get('user:' + username, 'json');
  return u || null;
}

/**
 * 权限层级。
 *   super —— 主管理员（admin 本人），权限最高
 *   sub   —— 副管理员，由主管理员设置
 *   user  —— 普通用户
 *
 * 兼容早期数据：只有 admin 会带 isAdmin:true 而没有 role，一律按主管理员处理。
 */
function roleOf(user) {
  if (!user) return 'guest';
  if (user.role === 'super') return 'super';
  if (user.role === 'sub') return 'sub';
  if (user.isAdmin) return 'super';
  return 'user';
}

const isAdminRole = (r) => r === 'super' || r === 'sub';

/**
 * 能不能对该账户做管理操作（激活 / 取消激活 / 续期 / 封禁 / 解封）。
 *   - 主管理员账户永远不可被操作（连主管理员自己也不行）；
 *   - 副管理员只能操作普通用户，不能碰任何管理员账户；
 *   - 主管理员可以操作普通用户和副管理员。
 */
function canManageAccount(actor, target) {
  const ar = roleOf(actor);
  if (!isAdminRole(ar)) {
    return { ok: false, res: json({ ok: false, message: '无权访问，仅管理员可用' }, 403) };
  }
  if (!target) return { ok: false, res: json({ ok: false, message: '账户不存在' }, 404) };

  const tr = roleOf(target);
  if (tr === 'super') {
    return { ok: false, res: json({ ok: false, message: '主管理员账户不可被操作' }, 403) };
  }
  if (ar === 'sub' && tr !== 'user') {
    return { ok: false, res: json({ ok: false, message: '副管理员不能操作管理员账户' }, 403) };
  }
  return { ok: true };
}

/**
 * 封禁状态：支持「起止时间」。
 *
 *   banUntil 为空  → 永久封禁
 *   banFrom 在未来 → 还没开始，暂时不受影响
 *   过了 banUntil  → 自动解封（不需要管理员手动操作）
 *
 * 用「时间点」而不是定时任务：安卓上没有 cron，Worker 也没有常驻进程，
 * 所以每次请求现算，到点自然失效。
 */
/** 把时间戳格式化成「MM-DD HH:MM」（Worker 里没有本地化工具，手写） */
function fmtShortTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  const p2 = (x) => (x < 10 ? '0' + x : '' + x);
  return p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' UTC';
}

function banState(user, now) {
  const t = Number(now) || Date.now();
  if (!user || !user.banned) return { banned: false };
  const from = Number(user.banFrom) || 0;
  const until = Number(user.banUntil) || 0;
  if (until && t >= until) return { banned: false, expired: true, until };
  if (from && t < from) return { banned: false, pending: true, from, startsInMs: from - t };
  return {
    banned: true,
    from: from || null,
    until: until || null,
    remainingMs: until ? Math.max(0, until - t) : null,
    permanent: !until,
  };
}

/* ========================== VPN / 代理检测 ==========================
 * Cloudflare 会在 request.cf 里给出客户端 IP 的 ASN 与运营商名，据此判断
 * 这条线路是不是机房 / 代理：命中 ASN 黑名单，或运营商名里带 VPN / Proxy /
 * Hosting 等关键词，都算代理。可选再叠加第三方 IP 情报接口。
 *
 * 用环境变量 VPN_BLOCK 控制：默认开启；设为 off / false / 0 则整体关闭。
 * VPN_BLOCK_CF_WARP=on 时把 Cloudflare WARP(AS13335) 也算作代理（默认不算，
 * 因为 1.1.1.1 这类加速器正常用户很多，误封代价太大）。
 */
const PROXY_BLOCK_MSG =
  'You are blocked!\n检测到VPN或代理，您的账户已被封停，现在请立刻关闭VPN或代理，并联系支持人员';

/** 常见机房 / VPS / VPN 出口的 ASN */
/** 公开的「高风险 ASN」名单（机房 / 防弹主机，共 723 个）：
 *  这类 ASN 基本只出现在服务器与代理出口上，普通宽带家用线路不会用到。
 *  来源：公开的 bad-asn-list。
 */
const BAD_ASNS = [
  1442, 3223, 3561, 3722, 3842, 4250, 4323, 4694, 4851, 5577, 6188, 6724, 6870, 6939,
  7203, 7349, 7489, 7506, 7595, 7598, 7850, 7979, 8075, 8100, 8455, 8477, 8556, 8560,
  8972, 9009, 9166, 9290, 9370, 9412, 9667, 9823, 9925, 10200, 10207, 10297, 10439, 10532,
  10929, 11230, 11235, 11274, 11588, 11831, 11878, 12586, 12617, 12876, 12989, 13209, 13213, 13647,
  13739, 13909, 13926, 13955, 14061, 14120, 14127, 14160, 14244, 14384, 14415, 14442, 14567, 14576,
  14618, 14708, 14986, 14987, 14992, 15003, 15083, 15169, 15189, 15395, 15497, 15510, 15626, 15734,
  15919, 16125, 16262, 16276, 16284, 16397, 16509, 16535, 16628, 16862, 16973, 17019, 17216, 17439,
  17669, 17881, 17918, 17920, 17971, 18120, 18450, 18570, 18779, 18978, 19084, 19133, 19234, 19318,
  19437, 19531, 19624, 19844, 19871, 19969, 20021, 20068, 20248, 20264, 20401, 20448, 20450, 20454,
  20473, 20598, 20692, 20738, 20773, 20836, 20860, 21100, 21159, 21217, 21321, 21859, 22152, 22363,
  22552, 22611, 22720, 22781, 22903, 23033, 23052, 23108, 23273, 23342, 23352, 23535, 23881, 24220,
  24381, 24482, 24549, 24558, 24611, 24679, 24725, 24768, 24875, 24931, 24940, 24958, 24961, 24971,
  24997, 25048, 25128, 25163, 25260, 25369, 25379, 25532, 25642, 25780, 25820, 25926, 26277, 26481,
  26484, 26978, 27175, 27223, 27229, 27257, 27357, 27589, 27597, 27640, 28099, 28216, 28333, 28747,
  28753, 28855, 28997, 29066, 29067, 29073, 29097, 29119, 29140, 29182, 29302, 29311, 29331, 29354,
  29452, 29465, 29550, 29691, 29713, 29748, 29802, 29838, 29854, 29869, 29883, 30083, 30152, 30176,
  30235, 30475, 30633, 30693, 30849, 30900, 30998, 31103, 31240, 31472, 31590, 31659, 31698, 31981,
  32097, 32181, 32244, 32275, 32306, 32338, 32400, 32475, 32489, 32613, 32647, 32740, 32780, 32911,
  33070, 33083, 33182, 33251, 33260, 33302, 33322, 33330, 33387, 33438, 33480, 33552, 33569, 33724,
  33785, 33891, 34305, 34432, 34541, 34649, 34745, 34971, 34989, 35017, 35278, 35295, 35366, 35415,
  35467, 35470, 35662, 35908, 35914, 35916, 35974, 36024, 36114, 36236, 36290, 36351, 36352, 36408,
  36536, 36666, 36791, 36873, 36887, 36920, 36970, 37018, 37088, 37153, 37170, 37209, 37230, 37248,
  37269, 37280, 37308, 37347, 37377, 37472, 37506, 37521, 37540, 37643, 37661, 37692, 37714, 38001,
  38107, 38279, 38894, 39020, 39326, 39351, 39392, 39451, 39458, 39572, 39704, 39756, 39839, 40156,
  40244, 40281, 40374, 40438, 40539, 40676, 40715, 40728, 40819, 40824, 40861, 41062, 41079, 41369,
  41427, 41562, 41653, 41665, 42120, 42160, 42210, 42244, 42311, 42331, 42399, 42400, 42418, 42442,
  42465, 42473, 42612, 42622, 42695, 42699, 42705, 42708, 42730, 42776, 42831, 43021, 43146, 43198,
  43289, 43317, 43350, 43472, 43541, 43620, 44050, 44066, 44398, 44901, 45102, 45152, 45179, 45187,
  45201, 45470, 45481, 45486, 45577, 45671, 45693, 45815, 45887, 46177, 46260, 46261, 46430, 46433,
  46475, 46562, 46664, 46805, 46816, 46844, 46873, 46945, 47143, 47161, 47172, 47205, 47328, 47385,
  47447, 47549, 47577, 47583, 47588, 47625, 48031, 48093, 48446, 48812, 48825, 48896, 49313, 49349,
  49453, 49485, 49505, 49532, 49544, 49693, 49815, 49834, 49949, 49981, 50297, 50465, 50608, 50613,
  50655, 50673, 50872, 50915, 50926, 50968, 50986, 51050, 51109, 51159, 51167, 51191, 51241, 51248,
  51290, 51294, 51395, 51430, 51447, 51698, 51731, 51765, 51852, 52048, 52173, 52219, 52236, 52270,
  52321, 52335, 52347, 52465, 52674, 52925, 53013, 53055, 53057, 53101, 53221, 53225, 53281, 53332,
  53340, 53342, 53370, 53559, 53589, 53597, 53667, 53755, 53850, 53889, 53914, 53918, 54104, 54203,
  54290, 54334, 54455, 54489, 54500, 54527, 54540, 54555, 54641, 54817, 54825, 54839, 55051, 55225,
  55229, 55286, 55293, 55536, 55720, 55761, 55799, 55933, 55967, 56106, 56110, 56322, 56617, 56630,
  56732, 56784, 56799, 56934, 57043, 57169, 57230, 57286, 57345, 57363, 57669, 57682, 57752, 57773,
  57858, 57879, 58073, 58113, 58305, 58667, 58797, 58922, 58936, 59135, 59253, 59349, 59432, 59504,
  59554, 59615, 59632, 59677, 59705, 59729, 59764, 59791, 59795, 59816, 59854, 60011, 60068, 60117,
  60118, 60404, 60476, 60485, 60505, 60558, 60567, 60739, 60781, 60800, 61102, 61107, 61147, 61157,
  61280, 61317, 61412, 61440, 62026, 62049, 62071, 62082, 62088, 62217, 62240, 62282, 62310, 62370,
  62471, 62540, 62563, 62567, 62605, 62651, 62756, 62838, 62899, 63008, 63018, 63119, 63128, 63129,
  63199, 63213, 63473, 63916, 63949, 64245, 64484, 132070, 132071, 132225, 132425, 132509, 132717, 132779,
  132816, 132869, 133120, 133143, 133229, 133296, 133393, 133480, 133752, 134451, 135822, 136258, 196645, 196678,
  196745, 196827, 197155, 197328, 197372, 197395, 197439, 197648, 197902, 197914, 198047, 198153, 198171, 198310,
  198313, 198347, 198375, 198414, 198432, 198651, 198968, 199129, 199213, 199481, 199653, 199733, 199847, 199883,
  199990, 199997, 200000, 200019, 200039, 200147, 200532, 200904, 201011, 201200, 201449, 201525, 201553, 201597,
  201630, 201634, 201670, 201702, 201709, 201862, 201983, 202023, 202053, 202118, 202836, 203523, 203629, 204196,
  206898, 212238, 262170, 262287, 262603, 262978, 262990, 263032, 263093, 263237, 327705, 327784, 327813, 327942,
  328035, 393326, 394256, 394330, 394380, 395089, 395111, 395978, 398779,
];

const PROXY_ASNS = new Set([
  14061, 46652,          // DigitalOcean
  63949,                 // Linode
  20473, 64515,          // Vultr / Choopa
  24940, 213230,         // Hetzner
  16276,                 // OVH
  51167, 141995,         // Contabo
  28753, 60781,          // Leaseweb
  9009,                  // M247
  16509, 14618, 8987,    // Amazon AWS
  396982, 19527,         // Google Cloud
  8075, 8068, 8069,      // Microsoft Azure
  31898,                 // Oracle Cloud
  45102, 37963,          // 阿里云
  132203, 45090,         // 腾讯云
  55990, 136907,         // 华为云
  12876,                 // Scaleway
  210644,                // Aeza
  44477,                 // PQ Hosting
  51852,                 // Private Layer
  40676,                 // Psychz
  46844,                 // Sharktech
  36352,                 // ColoCrossing
  54290,                 // Hostwinds
  204548,                // Kamatera
  8560,                  // IONOS
  197540,                // Netcup
  49505, 50340,          // Selectel / Hostkey
  62240,                 // Clouvider
  25820,                 // IT7 Networks（搬瓦工等）
  53667,                 // FranTech / BuyVM
  21859,                 // Zenlayer
  3214,                  // xTom
  26383,                 // Baxet Group（实测为机房出口）
]);
for (const a of BAD_ASNS) PROXY_ASNS.add(a);

/** 运营商名里出现这些词，基本就是机房或商业 VPN 线路 */
const PROXY_ORG_RE = /(vpn|proxy|proxies|hosting|dedicat|datacenter|data ?center|colo(cation)?|vps|cloud|anonym|privacy|tunnel|socks|shadowsocks|shadowsocksr|wireguard|nordvpn|expressvpn|surfshark|protonvpn|mullvad|windscribe|ipvanish|cyberghost|purevpn|vyprvpn|astrill|tunnelbear|private internet access|tor exit|torexit)/i;

/** 这些组织本身就承载海量正常用户，关键词命中也放行（避免误杀一整个 CDN） */
function isBenignOrg(org) {
  return /^(cloudflare|fastly|akamai)/i.test(String(org || ''));
}

function vpnBlockOn(env) {
  const v = String((env && env.VPN_BLOCK) || '').trim().toLowerCase();
  return !(v === 'off' || v === 'false' || v === '0');
}

/** 未识别线路的记账本（vpn:seen），用于事后发现新的机场 / VPN 线路 */
async function noteSeenLine(env, asn, org) {
  if (!asn && !org) return;
  try {
    const cur = (await env.USERS.get('vpn:seen', 'json')) || {};
    const key = String(asn || 0) + '|' + String(org || '').slice(0, 60);
    const rec = cur[key] || { asn: asn || 0, org: org || '', count: 0, firstAt: Date.now() };
    rec.count = (rec.count || 0) + 1;
    rec.lastAt = Date.now();
    cur[key] = rec;
    // 只保留最近 200 条，避免无限增长
    const keys = Object.keys(cur);
    if (keys.length > 200) {
      keys.sort((a, b) => (cur[b].lastAt || 0) - (cur[a].lastAt || 0));
      for (const k of keys.slice(200)) delete cur[k];
    }
    await env.USERS.put('vpn:seen', JSON.stringify(cur));
  } catch (e) { /* 记账失败不影响判定 */ }
}

/**
 * 额外规则放 KV（vpn:rules = {asns:[], keywords:[]}），
 * 发现新的机场 / VPN 线路时不用改代码重新部署，管理员调接口加一条即可。
 */
async function getProxyRules(env) {
  const out = { asns: new Set(), keywords: [], allow: new Set() };
  try {
    const raw = await env.USERS.get('vpn:rules', 'json');
    if (raw && typeof raw === 'object') {
      for (const a of raw.asns || []) {
        const n = Number(a);
        if (Number.isFinite(n) && n > 0 && n <= 4294967295) out.asns.add(n);
      }
      for (const k of raw.keywords || []) {
        const t = String(k || '').trim().toLowerCase();
        if (t.length >= 3 && t.length <= 40) out.keywords.push(t);
      }
      // 白名单：万一误封了正常线路，把它的 ASN 加进来立刻放行
      for (const a of raw.allowAsns || []) {
        const n = Number(a);
        if (Number.isFinite(n) && n > 0 && n <= 4294967295) out.allow.add(n);
      }
    }
  } catch (e) { /* KV 异常就当没有额外规则 */ }
  return out;
}

/**
 * 判断这次请求是不是走 VPN / 代理。
 * 没有 request.cf（本地开发、非 Cloudflare 环境）时一律放行，宁可漏判不误封。
 */
async function detectProxy(request, env) {
  if (!vpnBlockOn(env)) return { detected: false };
  const cf = request.cf;
  if (!cf) return { detected: false };

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const asn = Number(cf.asn) || 0;
  const org = String(cf.asOrganization || '');

  // Cloudflare WARP：默认不算代理，除非显式要求
  const warpOn = /^(on|true|1)$/i.test(String((env && env.VPN_BLOCK_CF_WARP) || ''));
  if (asn === 13335) {
    return warpOn
      ? { detected: true, via: 'warp', asn, org, ip }
      : { detected: false, asn, org, ip };
  }

  const extra = await getProxyRules(env);

  // 白名单优先：管理员放行的线路一律不判代理
  if (asn && extra.allow.has(asn)) return { detected: false, whitelisted: true, asn, org, ip };

  if (asn && PROXY_ASNS.has(asn)) return { detected: true, via: 'asn', asn, org, ip };
  if (asn && extra.asns.has(asn)) return { detected: true, via: 'kv-asn', asn, org, ip };
  const orgLower = org.toLowerCase();
  if (orgLower && extra.keywords.some((k) => orgLower.includes(k))) {
    return { detected: true, via: 'kv-keyword', asn, org, ip };
  }

  if (org && !isBenignOrg(org) && PROXY_ORG_RE.test(org)) {
    return { detected: true, via: 'org', asn, org, ip };
  }

  // 可选：第三方 IP 情报（IPINTEL_URL 里用 {ip} 占位，返回 JSON 含 proxy/vpn/isProxy）
  if (env && env.IPINTEL_URL && ip) {
    try {
      const url = String(env.IPINTEL_URL).replace('{ip}', encodeURIComponent(ip));
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
      clearTimeout(timer);
      if (res.ok) {
        const j = await res.json();
        const hit = j && (j.proxy === true || j.vpn === true || j.isProxy === true
          || Number(j.fraud_score) >= 80 || Number(j.risk) >= 80);
        if (hit) return { detected: true, via: 'intel', asn, org, ip };
      }
    } catch (e) {
      // 情报接口异常时放行：不能因为第三方挂了就把用户全封了
    }
  }
  return { detected: false, asn, org, ip };
}

/**
 * 检测到代理 → 立刻永久封号（并踢掉全部会话）。
 * 已经有封禁记录的不覆盖，保留管理员原先写下的原因。
 * 管理员不参与封号，避免自己出差连酒店 / 机场网络时被锁在门外。
 */
async function banForProxy(env, user, hit) {
  if (!user || !user.username) return false;
  if (isAdminRole(roleOf(user))) return false;
  const now = Date.now();
  if (banState(user, now).banned) return false;

  user.banned = true;
  user.bannedAt = now;
  user.bannedBy = 'system:vpn';
  user.banReason = 'proxy';
  user.banAsn = (hit && hit.asn) || null;
  user.banOrg = (hit && hit.org) || null;
  user.banIp = (hit && hit.ip) || null;
  delete user.banUntil;
  delete user.banFrom;

  await putUser(env, user);
  await deleteUserSessions(env, user.username);
  return true;
}

/**
 * 计算账户状态。前端状态栏完全依赖这个结果。
 *
 *   guest   —— 未登录           红点「登录以享受服务」
 *   admin   —— 管理员           绿点「账户正常」+ 右上角控制台（与已激活账户一致，不参与试用期倒计时）
 *   banned  —— 已被封禁         红点 + You are banned 弹窗
 *   trial   —— 试用期未结束     黄点「未激活，试用期仅剩…」（前端按 remainingMs 秒级倒数）
 *   blocked —— 试用期已到       黄点 + You are blocked 弹窗
 *   active  —— 已完成邮箱验证   绿点「账户正常」+ 右上角控制台
 *
 * 试用账户会额外返回 remainingMs / expiresAt：
 * 前端拿 remainingMs 换算成本地截止时刻再逐秒递减，
 * 这样即使客户端时钟不准，倒计时也不会算错；而真正的拦截始终由服务端判定。
 */
function accountStatus(user) {
  if (!user) {
    return { state: 'guest', dot: 'red', label: '登录以享受服务', activated: false, days: null, remainingMs: null };
  }

  // 管理员（主 / 副）：与已激活账户同款状态（绿点「账户正常」）。
  // 额外带 role，控制台据此显示「主管理员 / 副管理员」。管理员不参与试用期倒计时。
  if (user.isAdmin) {
    return {
      state: 'active',
      dot: 'green',
      label: '账户正常',
      activated: true,
      days: null,
      remainingMs: null,
      role: roleOf(user),
    };
  }

  // 被封禁：优先级仅次于管理员。仍然允许登录，目的是让他看到「You are banned」；
  // 但下载会被服务端拦掉。支持起止时间，到点自动解封。
  const ban = banState(user, Date.now());
  if (ban.banned) {
    return {
      state: 'banned',
      dot: 'red',
      // 状态栏左上角显示「账户异常」，剩余封禁时间由前端逐秒倒数
      // （永久封禁显示 -1天，和「试用期仅剩-1天」一个写法）
      label: '账户异常',
      activated: false,
      days: null,
      remainingMs: null,
      banned: true,
      banFrom: ban.from,
      banUntil: ban.until,
      banPermanent: !!ban.permanent,
      banRemainingMs: ban.remainingMs,
      bannedAt: user.bannedAt || null,
      bannedBy: user.bannedBy || null,
      // 'proxy' = 被 VPN/代理检测封的，前端据此显示专门的文案
      banReason: user.banReason || null,
      banOrg: user.banOrg || null,
    };
  }

  // 已激活 = 完成了电子邮件验证
  if (user.verified) {
    return { state: 'active', dot: 'green', label: '账户正常', activated: true, days: null, remainingMs: null };
  }

  // 试用账户：剩余时间精确到毫秒
  const start = Number(user.trialStart || user.createdAt || Date.now());
  const total = Number(user.trialDays) > 0 ? Number(user.trialDays) : TRIAL_DAYS;
  const expiresAt = start + total * 86400000;
  const remainingMs = Math.max(0, expiresAt - Date.now());
  // days 取上整：剩余 6 天多仍显示 7 天，与倒计时并存，供控制台等处使用
  const days = Math.ceil(remainingMs / 86400000);
  if (remainingMs > 0) {
    return {
      state: 'trial',
      dot: 'yellow',
      label: `未激活，试用期仅剩${days}天`,
      activated: false,
      days,
      remainingMs,
      expiresAt,
    };
  }
  return {
    state: 'blocked',
    dot: 'yellow',
    label: '未激活，试用期已到',
    activated: false,
    days: 0,
    remainingMs: 0,
    expiresAt,
  };
}

/** 读取会话对应的完整用户记录，用于计算实时状态 */
async function sessionUser(env, session) {
  if (!session) return null;
  return await getUser(env, session.username);
}

/** 确保试用账户存在（账户名 / 密码来自密钥，未配置则不建号） */
async function ensureTrial(env) {
  const name = trialUsername(env);
  const password = String(env.TRIAL_PASSWORD || '');
  if (!name || !password) return null;

  const existing = await env.USERS.get('user:' + name, 'json');
  if (existing) return existing;

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const now = Date.now();
  const user = {
    username: name,
    email: '',
    salt,
    hash,
    isAdmin: false,
    verified: false,
    isTrial: true,
    trialStart: now,
    recoveryCode: '',
    createdAt: now,
  };
  await env.USERS.put('user:' + name, JSON.stringify(user));
  return user;
}

/** 确保管理员账户存在（首次访问时创建；账户名/密码来自密钥） */
async function ensureAdmin(env) {
  const name = adminUsername(env);
  const password = String(env.ADMIN_PASSWORD || '');
  if (!name || !password) return null;

  const existing = await env.USERS.get('user:' + name, 'json');
  if (existing) return existing;

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const admin = {
    username: name,
    email: adminEmail(env),
    salt,
    hash,
    isAdmin: true,
    role: 'super',
    verified: true,
    createdAt: Date.now(),
  };
  admin.recoveryCode = makeRecoveryCode(admin, password);
  await env.USERS.put('user:' + name, JSON.stringify(admin));
  return admin;
}

/* ========================== 会话 ========================== */

async function createSession(env, user) {
  const token = randomHex(32);
  await env.USERS.put(
    'session:' + token,
    JSON.stringify({
      username: user.username,
      email: user.email,
      isAdmin: !!user.isAdmin,
      expires: Date.now() + SESSION_TTL * 1000,
    }),
    { expirationTtl: SESSION_TTL }
  );
  const cookie =
    `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`;
  return { token, cookie };
}

async function getSession(env, request) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)session=([a-f0-9]{64})/);
  if (!m) return null;
  const s = await env.USERS.get('session:' + m[1], 'json');
  if (!s) return null;
  if (Date.now() > s.expires) {
    await env.USERS.delete('session:' + m[1]);
    return null;
  }
  return s;
}

/* ========================== 邮件发送 ========================== */

async function sendMail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) {
    return { ok: false, message: '邮件服务未配置，请联系管理员' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.RESEND_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM || 'zrfeng.top <noreply@zrfeng.top>',
        to: [to],
        subject,
        html,
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, message: '邮件发送失败', detail: t.slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: '邮件发送异常', detail: String(e).slice(0, 200) };
  }
}

/* ========================== 路由处理 ========================== */

/** 读取 JSON 请求体 */
async function readJson(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

/** 是否为正则允许的邮箱（给前端用的即时提示） */
function emailHint(raw) {
  const v = validateEmail(raw);
  return v.ok ? { ok: true } : { ok: false, message: v.message };
}

/** 发送验证码 */
async function handleSendCode(env, request, ip) {
  const body = await readJson(request);

  // 1) 先人机验证
  const human = await checkHuman(env, body, ip);
  if (!human.ok) return json({ ok: false, message: human.message }, 400);

  // 2) 再校验邮箱
  const v = validateEmail(body.email);
  if (!v.ok) return json({ ok: false, message: v.message }, 400);
  const email = v.email;

  // 2.5) 已注销的邮箱不可再注册，提前拦下以免白费一封邮件
  if (await isEmailRetired(env, email)) {
    return json({ ok: false, message: '该邮箱已注销，不可再次注册' }, 400);
  }

  // 3) 冷却限制
  const cd = await env.USERS.get('cooldown:' + email);
  if (cd) return json({ ok: false, message: '发送过于频繁，请稍后再试' }, 429);

  // 4) 生成并保存验证码
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await env.USERS.put('code:' + email, JSON.stringify({ code, tries: 0 }), {
    expirationTtl: CODE_TTL,
  });
  await env.USERS.put('cooldown:' + email, '1', { expirationTtl: CODE_COOLDOWN });

  // 5) 发信
  const sent = await sendMail(
    env,
    email,
    '【zrfeng.top】邮箱验证码',
    `<div style="font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;padding:24px;background:#050807;color:#e8f5ee">
       <h2 style="color:#00ff8c;margin:0 0 12px">zrfeng.top 邮箱验证</h2>
       <p style="color:#a9c6b8;margin:0 0 16px">你的验证码是：</p>
       <p style="font-size:30px;letter-spacing:8px;font-weight:700;color:#00ff8c;margin:0 0 18px">${code}</p>
       <p style="color:#7fa893;font-size:13px;margin:0">10 分钟内有效，請勿泄露给他人。</p>
     </div>`
  );

  if (!sent.ok) return json({ ok: false, message: sent.message }, 502);

  // 开发期提示：未配置邮件服务时不泄露验证码到前端
  return json({ ok: true, message: '验证码已发送，请查收邮件（含垃圾箱）' });
}

/** 注册 */
async function handleRegister(env, request, ip) {
  const body = await readJson(request);

  const human = await checkHuman(env, body, ip);
  if (!human.ok) return json({ ok: false, message: human.message }, 400);

  const v = validateEmail(body.email);
  if (!v.ok) return json({ ok: false, message: v.message }, 400);
  const email = v.email;

  // 已注销的邮箱永久不可再注册
  if (await isEmailRetired(env, email)) {
    return json({ ok: false, message: '该邮箱已注销，不可再次注册' }, 400);
  }

  const username = String(body.username || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,20}$/.test(username)) {
    return json({ ok: false, message: '用户名需 3-20 位，仅字母数字下划线连字符' }, 400);
  }
  if (reservedNames(env).has(username)) {
    return json({ ok: false, message: '该用户名为系统保留，请换一个' }, 400);
  }

  const password = String(body.password || '');
  if (password.length < 6) {
    return json({ ok: false, message: '密码至少 6 位' }, 400);
  }
  if (password.length > 128) {
    return json({ ok: false, message: '密码过长' }, 400);
  }

  // 校验验证码
  const rec = await env.USERS.get('code:' + email, 'json');
  if (!rec) return json({ ok: false, message: '验证码已过期，请重新获取' }, 400);
  if (rec.tries >= 5) {
    await env.USERS.delete('code:' + email);
    return json({ ok: false, message: '尝试次数过多，请重新获取验证码' }, 400);
  }
  if (String(body.code || '').trim() !== rec.code) {
    rec.tries = (rec.tries || 0) + 1;
    await env.USERS.put('code:' + email, JSON.stringify(rec), { expirationTtl: CODE_TTL });
    return json({ ok: false, message: '验证码不正确' }, 400);
  }

  // 唯一性
  if (await getUser(env, username)) {
    return json({ ok: false, message: '该用户名已被注册' }, 400);
  }
  const byEmail = await env.USERS.get('email:' + email);
  if (byEmail) {
    return json({ ok: false, message: '该邮箱已被注册' }, 400);
  }

  // 建号
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const user = {
    username,
    email,
    salt,
    hash,
    isAdmin: false,
    verified: true,
    createdAt: Date.now(),
  };
  user.recoveryCode = makeRecoveryCode(user, password);
  await putUser(env, user);
  await env.USERS.delete('code:' + email);

  // 注册时检测到 VPN / 代理：账号照样建出来，但立刻永久封停，不给会话
  const proxy = await detectProxy(request, env);
  if (proxy.detected) {
    await banForProxy(env, user, proxy);
    return json({
      ok: false,
      blocked: true,
      proxy: true,
      message: PROXY_BLOCK_MSG,
      account: accountStatus(user),
    }, 403);
  }

  const { cookie } = await createSession(env, user);
  return json(
    { ok: true, message: '注册成功', user: { username, email, isAdmin: false } },
    200,
    { 'Set-Cookie': cookie }
  );
}

/** 登录 */
async function handleLogin(env, request, ip) {
  const body = await readJson(request);

  const human = await checkHuman(env, body, ip);
  if (!human.ok) return json({ ok: false, message: human.message }, 400);

  const account = String(body.account || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!account || !password) {
    return json({ ok: false, message: '请输入账号和密码' }, 400);
  }

  // 管理员 / 试用账户首次登录时自动建号（账户名取自密钥，未配置则跳过）
  if (account && account === adminUsername(env)) await ensureAdmin(env);
  if (account && account === adminEmail(env)) await ensureAdmin(env);
  if (account && account === trialUsername(env)) await ensureTrial(env);

  const user = await findByLogin(env, account);
  if (!user) return json({ ok: false, message: '账号或密码错误' }, 401);

  const hash = await hashPassword(password, user.salt);
  if (!timingSafeEqual(hash, user.hash)) {
    return json({ ok: false, message: '账号或密码错误' }, 401);
  }

  // 登录时检测到 VPN / 代理：直接封号并拦下。
  // 管理员豁免（否则自己出差连酒店网络就被锁在门外）；
  // 若账号早已因别的原因被封，保持原来的提示，不覆盖成 VPN 文案。
  const proxy = await detectProxy(request, env);
  if (proxy.detected && !isAdminRole(roleOf(user))) {
    const alreadyBanned = banState(user, Date.now()).banned;
    const reportProxy = alreadyBanned ? user.banReason === 'proxy' : await banForProxy(env, user, proxy);
    if (reportProxy) {
      return json({
        ok: false,
        blocked: true,
        proxy: true,
        message: PROXY_BLOCK_MSG,
        account: accountStatus((await getUser(env, user.username)) || user),
      }, 403);
    }
  }

  // 新设备登录验证：这台设备从没在该账户上成功登录过 → 需要额外确认身份
  const deviceId = deviceIdOf(request) || randomHex(16);
  if (!(await isKnownDevice(env, user, deviceId)) && !user.email) {
    // 没有邮箱 → 收不到验证码，改用「管理员给的密钥」
    const ticket = randomHex(16);
    await env.USERS.put(
      'devlogin:' + ticket,
      JSON.stringify({ username: user.username, deviceId, mode: 'key', tries: 0, at: Date.now() }),
      { expirationTtl: DEVLOGIN_TTL }
    );
    return json(
      {
        ok: false,
        needDeviceKey: true,
        ticket,
        message: '我们无法认证你的身份，请输入管理员给你的密钥，以帮助我们确认身份',
      },
      200,
      { 'Set-Cookie': deviceCookie(deviceId) }
    );
  }
  if (user.email && !(await isKnownDevice(env, user, deviceId))) {
    const ticket = randomHex(16);
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await env.USERS.put(
      'devlogin:' + ticket,
      JSON.stringify({ username: user.username, deviceId, code, tries: 0, at: Date.now() }),
      { expirationTtl: DEVLOGIN_TTL }
    );
    await env.USERS.put('devcooldown:' + ticket, '1', { expirationTtl: CODE_COOLDOWN });
    const sent = await sendDeviceCode(env, user, code);
    if (!sent.ok) return json({ ok: false, message: sent.message }, 502);
    return json(
      {
        ok: false,
        needDeviceVerify: true,
        ticket,
        message: '这是一台新设备，验证码已发送到 ' + maskEmail(user.email),
        email: maskEmail(user.email),
      },
      200,
      { 'Set-Cookie': deviceCookie(deviceId) }
    );
  }

  const status = accountStatus(user);
  const { cookie } = await createSession(env, user);
  return json(
    {
      ok: true,
      message: '登录成功',
      user: {
        username: user.username,
        email: user.email,
        isAdmin: isAdminRole(roleOf(user)),
        role: roleOf(user),
        isSuper: roleOf(user) === 'super',
      },
      account: status,
    },
    200,
    { 'Set-Cookie': cookie }
  );
}

/** 登出 */
async function handleLogout(env, request) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)session=([a-f0-9]{64})/);
  if (m) await env.USERS.delete('session:' + m[1]);
  return json({ ok: true }, 200, {
    'Set-Cookie': 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
  });
}

/* ========================== 注销账户 ========================== */

/** 注销通知的 KV 键。管理员点「已读」即删除此键 */
const NOTICE_KEY = 'notice:deletions';
/** 通知最多保留多少条，防止无限增长 */
const NOTICE_MAX = 50;

/** 该邮箱是否已被注销、不可再次注册 */
async function isEmailRetired(env, email) {
  if (!email) return false;
  return !!(await env.USERS.get('retired:' + email));
}

/** 把邮箱永久加入「不可再注册」名单 */
async function retireEmail(env, email, username) {
  if (!email) return;
  await env.USERS.put('retired:' + email, JSON.stringify({ username, at: Date.now() }));
}

/** 记一条注销通知（管理员点已读前一直累积） */
async function recordDeletion(env, user) {
  let list = [];
  try {
    list = (await env.USERS.get(NOTICE_KEY, 'json')) || [];
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  list.unshift({
    username: user.username,
    email: user.email || '',
    at: Date.now(),
    verified: !!user.verified,
  });
  await env.USERS.put(NOTICE_KEY, JSON.stringify(list.slice(0, NOTICE_MAX)));
}

/**
 * 踢掉某个账户的全部会话。
 * keepToken 用于「改密码」场景：踢掉其它设备，保留当前这台，免得用户改完立刻被登出。
 */
async function deleteUserSessions(env, username, keepToken) {
  let removed = 0;
  try {
    const list = await env.USERS.list({ prefix: 'session:', limit: 1000 });
    for (const k of list.keys) {
      if (keepToken && k.name === 'session:' + keepToken) continue;
      const s = await env.USERS.get(k.name, 'json');
      if (s && s.username === username) {
        await env.USERS.delete(k.name);
        removed++;
      }
    }
  } catch {
    /* 忽略：会话到期会自行失效 */
  }
  return removed;
}

/** 取当前会话对应的用户，并做「能否注销」的通用校验 */
async function deleteGuard(env, request) {
  const session = await getSession(env, request);
  if (!session) return { error: json({ ok: false, message: '请先登录', needLogin: true }, 401) };
  const user = await sessionUser(env, session);
  if (!user) return { error: json({ ok: false, message: '账户不存在' }, 404) };
  // 保护系统账户：管理员注销掉就没人能管理了；42 是公开的共享试用号，
  // 谁都能登录，若允许注销，任何人都能把演示账号弄没。
  if (user.isAdmin) return { error: json({ ok: false, message: '管理员账户不可注销' }, 403) };
  if (user.isTrial) return { error: json({ ok: false, message: '试用账户不可注销' }, 403) };
  if (!user.email) return { error: json({ ok: false, message: '该账户没有绑定邮箱，无法发送确认邮件' }, 400) };
  return { session, user };
}

/**
 * 注销第一步：校验密码，然后往绑定邮箱发一封注销确认码。
 * 真正的删除发生在第二步（handleDeleteConfirm），避免误触即刻删号。
 */
async function handleDeleteRequest(env, request) {
  const g = await deleteGuard(env, request);
  if (g.error) return g.error;
  const { user } = g;

  const body = await readJson(request);
  const password = String(body.password || '');
  if (!password) return json({ ok: false, message: '请输入密码' }, 400);

  const hash = await hashPassword(password, user.salt);
  if (!timingSafeEqual(hash, user.hash)) {
    return json({ ok: false, message: '密码不正确' }, 401);
  }

  // 冷却：同一账户 60 秒内只能发一次确认码
  const ck = 'delcooldown:' + user.username;
  if (await env.USERS.get(ck)) {
    return json({ ok: false, message: '确认码刚发过，请稍后再试或查看邮箱' }, 429);
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await env.USERS.put(
    'delcode:' + user.username,
    JSON.stringify({ code, tries: 0, email: user.email }),
    { expirationTtl: DELCODE_TTL }
  );
  await env.USERS.put(ck, '1', { expirationTtl: CODE_COOLDOWN });

  const sent = await sendMail(
    env,
    user.email,
    '【zrfeng.top】注销账户确认',
    `<div style="font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;padding:24px;background:#050807;color:#e8f5ee">
       <h2 style="color:#ff5c5c;margin:0 0 12px">注销账户确认</h2>
       <p style="color:#a9c6b8;margin:0 0 16px">你正在注销 zrfeng.top 的账户 <b style="color:#00ff8c">${user.username}</b>。确认码是：</p>
       <p style="font-size:30px;letter-spacing:8px;font-weight:700;color:#ff5c5c;margin:0 0 18px">${code}</p>
       <p style="color:#7fa893;font-size:13px;margin:0 0 8px">10 分钟内有效。</p>
       <p style="color:#7fa893;font-size:13px;margin:0">注销后该邮箱<b>不可再次注册</b>，账户数据将被删除且无法恢复。</p>
       <p style="color:#5c7a6b;font-size:12px;margin:16px 0 0">如果这不是你本人操作，请忽略本邮件，账户不会有任何变化。</p>
     </div>`
  );
  if (!sent.ok) return json({ ok: false, message: sent.message }, 502);

  return json({
    ok: true,
    message: '确认码已发送到 ' + maskEmail(user.email),
    needCode: true,
  });
}

/** 把邮箱打码，避免接口回显完整地址 */
function maskEmail(email) {
  const s = String(email || '');
  const i = s.indexOf('@');
  if (i <= 0) return '你的邮箱';
  const name = s.slice(0, i);
  const head = name.slice(0, Math.min(2, name.length));
  return head + '***' + s.slice(i);
}

/**
 * 注销第二步（二次确认）：校验邮件里的确认码，通过后才真正删除。
 */
async function handleDeleteConfirm(env, request) {
  const g = await deleteGuard(env, request);
  if (g.error) return g.error;
  const { user } = g;

  const body = await readJson(request);
  const input = String(body.code || '').trim();
  if (!/^\d{6}$/.test(input)) return json({ ok: false, message: '请输入 6 位确认码' }, 400);

  const rec = await env.USERS.get('delcode:' + user.username, 'json');
  if (!rec) return json({ ok: false, message: '确认码已过期，请重新获取' }, 400);
  if (rec.tries >= 5) {
    await env.USERS.delete('delcode:' + user.username);
    return json({ ok: false, message: '尝试次数过多，请重新获取确认码' }, 400);
  }
  if (String(input) !== String(rec.code)) {
    rec.tries = (rec.tries || 0) + 1;
    await env.USERS.put('delcode:' + user.username, JSON.stringify(rec), { expirationTtl: DELCODE_TTL });
    return json({ ok: false, message: '确认码不正确' }, 400);
  }

  // 1) 邮箱拉黑，永久不可再注册
  await retireEmail(env, user.email, user.username);
  // 2) 删除账户与邮箱索引
  await env.USERS.delete('user:' + user.username);
  if (user.email) await env.USERS.delete('email:' + user.email);
  // 3) 清掉所有会话与确认码
  const sessions = await deleteUserSessions(env, user.username);
  await env.USERS.delete('delcode:' + user.username);
  // 4) 给管理员留一条通知
  await recordDeletion(env, user);

  return json(
    {
      ok: true,
      message: '账户已注销',
      detail: '该邮箱已不可再次注册，账户数据已删除。',
      removedSessions: sessions,
    },
    200,
    { 'Set-Cookie': 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' }
  );
}

/**
 * 下载链接 —— 只有登录用户才能拿到。
 * 现在只有一份站内文件（《听潮》），直接从 KV 读取返回，不再有第三方网盘链接。
 */
async function handleDownloads(env, request) {
  const session = await getSession(env, request);
  if (!session) {
    return json({ ok: false, message: '请先登录后再下载', needLogin: true }, 401);
  }

  // 试用期已到的账户不能下载，必须联系管理员激活
  const user = await sessionUser(env, session);
  const status = accountStatus(user);
  if (status.state === 'blocked') {
    return json(
      { ok: false, message: '账户试用期已到，请联系管理员以激活账户', blocked: true, needLogin: false, account: status },
      403
    );
  }
  // 被封禁的账户同样拿不到任何下载链接
  if (status.state === 'banned') {
    return json(
      { ok: false, message: '该账户已被封禁，请联系管理员', banned: true, needLogin: false, account: status },
      403
    );
  }

  const rec = await readNovelFile(env);
  return json({
    ok: true,
    // 站内直接下载：不再有任何第三方网盘链接
    file: {
      name: rec ? rec.name : '',
      size: rec ? Number(rec.size) || 0 : 0,
      type: rec ? rec.type || '' : '',
      available: !!rec,
      url: '/api/novel/download',
    },
    account: status,
  });
}

/* ========================== 站内文件（《听潮》） ========================== */

/** 站内文件的 KV 键 */
const NOVEL_KEY = 'file:novel';

/** 读取站内文件记录；没上传或数据损坏都返回 null */
async function readNovelFile(env) {
  try {
    const rec = await env.USERS.get(NOVEL_KEY, 'json');
    if (!rec || !rec.b64) return null;
    return rec;
  } catch {
    return null;
  }
}

/** 文件大小上限（base64 后仍要留在 KV 单值 25MB 以内） */
const NOVEL_MAX_BYTES = 15 * 1024 * 1024;

/**
 * 上传 / 替换站内文件（仅管理员）。
 * 存进 KV 而不是仓库 —— 仓库是公开的，放进去等于把小说公开发布。
 */
async function handleAdminUploadNovel(env, request) {
  const guard = await requireAdmin(env, request);
  if (guard.error) return guard.error;

  const body = await readJson(request);
  const name = String(body.name || '').trim() || 'download.docx';
  const type = String(body.type || '').trim() || 'application/octet-stream';
  const b64 = String(body.b64 || '').replace(/\s+/g, '');
  if (!b64) return json({ ok: false, message: '缺少文件内容' }, 400);

  // base64 长度 → 原始字节数的近似值
  const size = Math.floor((b64.length * 3) / 4);
  if (size > NOVEL_MAX_BYTES) {
    return json({ ok: false, message: '文件过大（上限 ' + Math.round(NOVEL_MAX_BYTES / 1024 / 1024) + ' MB）' }, 400);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return json({ ok: false, message: '文件内容不是合法的 base64' }, 400);
  }

  const rec = { name, type, size, b64, uploadedAt: Date.now(), uploadedBy: guard.session.username };
  await env.USERS.put(NOVEL_KEY, JSON.stringify(rec));

  return json({ ok: true, message: '已更新站内文件：' + name, file: { name, type, size } });
}

/**
 * 站内文件下载 —— 必须登录，且被封禁 / 试用到期的账户拿不到。
 * 文件从 KV 取出后由本 Worker 直接返回，不经过任何第三方网盘。
 */
async function handleNovelDownload(env, request) {
  const session = await getSession(env, request);
  if (!session) {
    return json({ ok: false, message: '请先登录后再下载', needLogin: true }, 401);
  }

  const user = await sessionUser(env, session);
  const status = accountStatus(user);
  if (status.state === 'blocked') {
    return json(
      { ok: false, message: '账户试用期已到，请联系管理员以激活账户', blocked: true, needLogin: false, account: status },
      403
    );
  }
  if (status.state === 'banned') {
    return json(
      { ok: false, message: '该账户已被封禁，请联系管理员', banned: true, needLogin: false, account: status },
      403
    );
  }

  const rec = await readNovelFile(env);
  if (!rec) {
    return json({ ok: false, message: '文件尚未上传，请联系管理员' }, 404);
  }

  // base64 → 字节
  const bin = atob(rec.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const name = rec.name || 'download.bin';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': rec.type || 'application/octet-stream',
      'content-length': String(bytes.length),
      // 中文文件名用 filename* 传，兼容各浏览器
      'content-disposition': 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name),
      'cache-control': 'no-store',
    },
  });
}

/* ========================== 意见工单 ========================== */

/** 按「码点」截断，免得把一个 emoji 切成半个 */
function capText(s, n) {
  return Array.from(String(s == null ? '' : s)).slice(0, n).join('');
}

/** 工单里的「字数」：先去掉所有空白，再按码点算（一个 emoji 算一个字） */
function ticketLen(s) {
  return Array.from(String(s == null ? '' : s).replace(/\s+/gu, '')).length;
}

/**
 * 里面有没有「文字」——汉字、字母、假名、谚文都算。
 * 纯数字、纯标点、纯符号（包括纯 emoji）一律返回 false。
 */
function ticketHasWord(s) {
  return /\p{L}/u.test(String(s == null ? '' : s));
}

/**
 * 判定垃圾工单。返回 null 表示正常工单；否则返回 { code, message }。
 * 命中任意一条就算垃圾工单（用户要求）：
 *   title_short  标题少于 3 个字
 *   body_short   正文少于 10 个字
 *   no_text      标题或正文里一个文字都没有（全是数字 / 标点 / 符号）
 */
function ticketSpam(title, body) {
  if (ticketLen(title) < TICKET_TITLE_MIN) {
    return {
      code: 'title_short',
      message: '标题至少要 ' + TICKET_TITLE_MIN + ' 个字，这条已按垃圾工单销毁，补充后可以重新提交。',
    };
  }
  if (ticketLen(body) < TICKET_BODY_MIN) {
    return {
      code: 'body_short',
      message: '正文至少要 ' + TICKET_BODY_MIN + ' 个字，这条已按垃圾工单销毁，补充后可以重新提交。',
    };
  }
  if (!ticketHasWord(title) || !ticketHasWord(body)) {
    return {
      code: 'no_text',
      message: '标题或正文里没有实际文字（全是数字或标点），这条已按垃圾工单销毁。',
    };
  }
  return null;
}

/** 工单算在哪一天（按东八区，凌晨 0 点换日） */
function ticketDayKey(ts) {
  return new Date(Number(ts) + 8 * 3600000).toISOString().slice(0, 10);
}

/**
 * 取出工单，新的在前。
 * 键是 ticket:<15 位补零时间戳>-<随机 hex>，字典序倒排就是时间倒序。
 */
async function listTickets(env, limit = TICKET_MAX_KEEP) {
  let keys = [];
  try {
    const r = await env.USERS.list({ prefix: TICKET_PREFIX, limit });
    keys = (r && r.keys) || [];
  } catch {
    return [];
  }
  keys.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const out = [];
  for (const k of keys) {
    let t = null;
    try {
      t = await env.USERS.get(k.name, 'json');
    } catch {
      t = null;
    }
    if (!t || typeof t !== 'object') continue;
    out.push(Object.assign({ id: k.name.slice(TICKET_PREFIX.length) }, t));
  }
  return out;
}

/**
 * 提交工单。**不需要登录** —— 被封禁、未激活的人正是靠这里联系管理员，
 * 所以「联系我们」页不弹任何遮罩、这个接口也不要求会话。
 */
async function handleTicketSubmit(env, request, ip) {
  const body = await readJson(request);

  // 机器人陷阱：这个输入框对正常用户是隐藏的（没人会去填）。
  // 但浏览器的自动填充偶尔会去填隐藏字段，所以再加一条「时间闸」：
  // 只有「填了陷阱」而且「打开页面后 3 秒内就提交」（或者干脆没报耗时）才算机器人。
  // 人正常打字怎么也要几秒，所以真实用户不会被误伤。
  const elapsed = Number(body.elapsedMs);
  const trapFilled = !!String(body.site || body.website || '').trim();
  if (trapFilled && (!Number.isFinite(elapsed) || elapsed < 3000)) {
    return json({ ok: true, message: '工单已提交，我会尽快查看。' });
  }

  const title = capText(String(body.title || '').trim(), TICKET_TITLE_MAX + 1);
  const text = capText(String(body.body || body.content || '').trim(), TICKET_BODY_MAX + 1);
  const contact = capText(String(body.contact || '').trim(), TICKET_CONTACT_MAX + 1);

  // 两个都是空的：这是「忘了填」，按普通表单提示处理，不算垃圾工单
  if (!title && !text) {
    return json({ ok: false, message: '请填写标题和正文内容' }, 400);
  }

  // 垃圾工单：就地销毁 —— 不写 KV、不留记录、不占任何计数。
  // 先判垃圾再谈写库，机器人刷垃圾也烧不掉 KV 的免费写入额度。
  const spam = ticketSpam(title, text);
  if (spam) {
    return json({ ok: false, spam: true, code: spam.code, message: spam.message }, 400);
  }

  if (Array.from(title).length > TICKET_TITLE_MAX) {
    return json({ ok: false, message: '标题太长了，最多 ' + TICKET_TITLE_MAX + ' 个字' }, 400);
  }
  if (Array.from(text).length > TICKET_BODY_MAX) {
    return json({ ok: false, message: '正文太长了，最多 ' + TICKET_BODY_MAX + ' 个字' }, 400);
  }

  const now = Date.now();
  const today = ticketDayKey(now);
  const existing = await listTickets(env, TICKET_MAX_KEEP + 50);

  // 保护 KV 免费额度：每天最多收 TICKET_DAILY_MAX 条
  const todayCount = existing.filter((t) => ticketDayKey(t.at) === today).length;
  if (todayCount >= TICKET_DAILY_MAX) {
    return json(
      { ok: false, message: '今天收到的工单太多了，请明天再来（每日上限 ' + TICKET_DAILY_MAX + ' 条）' },
      429
    );
  }

  // 同一个 IP 一分钟只能提交一条，挡住连点
  const cdKey = TICKET_CD_PREFIX + (ip || 'unknown');
  try {
    if (await env.USERS.get(cdKey)) {
      return json({ ok: false, message: '提交得太频繁了，请等一分钟再试' }, 429);
    }
  } catch {
    /* 读不到就不拦 */
  }

  // 登录用户自动带上账户名，管理员一看就知道是谁提的；
  // 未登录的就留空，控制台显示成「未登录用户」。
  let account = '';
  try {
    const s = await getSession(env, request);
    if (s) {
      const u = await sessionUser(env, s);
      account = (u && u.username) || s.username || '';
    }
  } catch {
    account = '';
  }

  // 勾了「匿名发送」：控制台只显示「已匿名」，并且这条工单会被排到最下面。
  // 注意 account 仍然照存 —— 只是不下发给控制台。
  const anonymous = body.anonymous === true || body.anon === true;

  // 键是 ticket:<15 位时间戳>-<随机>，靠字典序倒排来排「新的在前」。
  // 同一毫秒收到的两条会撞时间戳、只能靠随机段比大小，顺序就不稳定了；
  // 这里顺手在已有列表上取最大值 +1ms，让键严格递增（不多花一次 KV 读）。
  const lastAt = existing.reduce((mx, x) => Math.max(mx, Number(x.at) || 0), 0);
  const at = Math.max(now, lastAt + 1);

  const id = String(at).padStart(15, '0') + '-' + randomHex(3);
  try {
    const rec = { title, body: text, contact, account, at };
    if (anonymous) rec.anonymous = true;
    // 记下设备 cookie：未登录的人以后也能在「通知板块 → 我的消息」里
    // 找到这条工单并看到管理员的回复（换设备或清缓存就找不到了，界面上有提示）。
    const dev = deviceIdOf(request);
    if (dev) rec.dev = String(dev);
    await env.USERS.put(TICKET_PREFIX + id, JSON.stringify(rec));
    await env.USERS.put(cdKey, String(now), { expirationTtl: TICKET_COOLDOWN });
  } catch {
    return json({ ok: false, message: '工单没能保存，请稍后再试' }, 500);
  }

  // 只留最近 TICKET_MAX_KEEP 条，超出的从最旧的删
  const keep = [id].concat(existing.map((t) => t.id));
  for (const old of keep.slice(TICKET_MAX_KEEP)) {
    try {
      await env.USERS.delete(TICKET_PREFIX + old);
    } catch {
      /* 忽略 */
    }
  }

  return json({ ok: true, message: '工单已提交，我会尽快查看。', id });
}

/** 管理员工单列表 */
async function handleAdminTickets(env, request) {
  const guard = await requireAdmin(env, request);
  if (guard.error) return guard.error;

  const all = await listTickets(env, 500);
  let lastRead = 0;
  try {
    lastRead = Number(await env.USERS.get(TICKET_READ_KEY)) || 0;
  } catch {
    lastRead = 0;
  }
  const now = Date.now();

  // 一条工单的「最后动静」时间：提交时间与最后一条回复里取大的。
  // 「有 N 条新」和排序都用它，这样用户追加回复也能重新顶上来。
  const lastAct = (t) => {
    const reps = Array.isArray(t.replies) ? t.replies : [];
    return reps.reduce((mx, r) => Math.max(mx, Number(r.at) || 0), Number(t.at) || 0);
  };

  // 未回复的用户留言（管理员还没看过的）
  const needReply = (t) => {
    const reps = Array.isArray(t.replies) ? t.replies : [];
    const last = reps.length ? reps[reps.length - 1] : null;
    return !last || last.by !== 'admin';
  };

  // 优先级：匿名工单排在所有具名工单后面（各自仍然新的在前）。
  // 排序只在这里做，不动 listTickets —— 那边的顺序还要用来算每日上限和淘汰最旧的。
  const ordered = all.slice().sort((a, b) => {
    const ax = a.anonymous === true ? 1 : 0;
    const bx = b.anonymous === true ? 1 : 0;
    if (ax !== bx) return ax - bx;
    return lastAct(b) - lastAct(a);
  });

  return json({
    ok: true,
    count: all.length,
    today: all.filter((t) => ticketDayKey(t.at) === ticketDayKey(now)).length,
    dailyMax: TICKET_DAILY_MAX,
    maxKeep: TICKET_MAX_KEEP,
    unread: all.filter((t) => lastAct(t) > lastRead).length,
    lastReadAt: lastRead || null,
    anonymousCount: all.filter((t) => t.anonymous === true).length,
    // 有几条是「用户还在等回复」的（最后一条不是管理员发的）
    pendingCount: all.filter(needReply).length,
    tickets: ordered.slice(0, 50).map((t) => {
      const anon = t.anonymous === true;
      const reps = Array.isArray(t.replies) ? t.replies : [];
      return {
        id: t.id,
        title: String(t.title || ''),
        body: String(t.body || ''),
        contact: String(t.contact || ''),
        // 匿名工单不下发用户名：控制台就只显示「已匿名」。
        // （KV 里其实还留着 account，万一以后要追溯；要连记录都不留，说一声改一行即可）
        account: anon ? '' : String(t.account || ''),
        anonymous: anon,
        at: Number(t.at) || 0,
        lastAt: lastAct(t),
        replyCount: reps.length,
        pending: needReply(t),
        replies: reps.slice(-30).map((r) => ({
          at: Number(r.at) || 0,
          by: r.by === 'admin' ? 'admin' : 'user',
          text: String(r.text || ''),
        })),
      };
    }),
  });
}

/** 管理员点「已读」：记下时间，下次就能算出有几条新工单 */
async function handleAdminTicketsRead(env, request) {
  const guard = await requireAdmin(env, request);
  if (guard.error) return guard.error;
  const now = Date.now();
  try {
    await env.USERS.put(TICKET_READ_KEY, String(now));
  } catch {
    /* 忽略 */
  }
  return json({ ok: true, message: '已标记为已读', lastReadAt: now });
}

/** 管理员删除工单：带 id 删一条，带 all:true 全部清空 */
async function handleAdminTicketsDelete(env, request) {
  const guard = await requireAdmin(env, request);
  if (guard.error) return guard.error;

  const body = await readJson(request);

  if (body.all) {
    const all = await listTickets(env, 1000);
    let n = 0;
    for (const t of all) {
      try {
        await env.USERS.delete(TICKET_PREFIX + t.id);
        n++;
      } catch {
        /* 忽略 */
      }
    }
    return json({ ok: true, message: '已清空 ' + n + ' 条工单', deleted: n });
  }

  const id = String(body.id || '').trim();
  // 严格校验编号，只可能删到 ticket: 前缀下的键，删不到别的东西
  if (!/^\d{15}-[0-9a-f]{6}$/.test(id)) {
    return json({ ok: false, message: '工单编号不正确' }, 400);
  }
  await env.USERS.delete(TICKET_PREFIX + id);
  return json({ ok: true, message: '已删除该工单', deleted: 1 });
}

/* ========================== 通知板块 ========================== */

/** 把时间戳格式化成「MM-DD HH:MM」（北京时间，东八区） */
function fmtCST(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts) + 8 * 3600000);
  const p2 = (x) => (x < 10 ? '0' + x : '' + x);
  return p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
}

/** 取出公开公告，新的在前 */
async function listNotices(env, limit = NOTICE_MAX_KEEP) {
  let keys = [];
  try {
    const r = await env.USERS.list({ prefix: NOTICE_PREFIX, limit });
    keys = (r && r.keys) || [];
  } catch {
    return [];
  }
  keys.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const out = [];
  for (const k of keys) {
    let n = null;
    try {
      n = await env.USERS.get(k.name, 'json');
    } catch {
      n = null;
    }
    if (!n || typeof n !== 'object') continue;
    out.push(Object.assign({ id: k.name.slice(NOTICE_PREFIX.length) }, n));
  }
  return out;
}

/**
 * 发一条公开公告。
 * kind: 'manual'（管理员手发）| 'maint'（维护自动发）
 * 传了 rec.id 就用这个编号（用来做「同一条消息只发一次」的幂等覆盖，
 * 比如维护到点自动结束时，多个并发请求都会来发一次，但写的键是同一个）。
 */
async function postNotice(env, rec) {
  const at = Number(rec.at) || Date.now();
  const id = rec.id ? String(rec.id) : String(at).padStart(15, '0') + '-' + randomHex(3);
  const out = {
    at,
    title: capText(String(rec.title || ''), NOTICE_TITLE_MAX),
    body: capText(String(rec.body || ''), NOTICE_BODY_MAX),
    kind: rec.kind === 'maint' ? 'maint' : 'manual',
  };
  if (rec.setBy) out.setBy = String(rec.setBy);
  await env.USERS.put(NOTICE_PREFIX + id, JSON.stringify(out));

  // 只留最近 NOTICE_MAX_KEEP 条，超出的从最旧的删
  const all = await listNotices(env, NOTICE_MAX_KEEP + 20);
  for (const old of all.slice(NOTICE_MAX_KEEP)) {
    try {
      await env.USERS.delete(NOTICE_PREFIX + old.id);
    } catch {
      /* 忽略 */
    }
  }
  return id;
}

/**
 * 个人通知归谁：登录用户按账户，未登录按设备（同一台手机/浏览器）。
 * 返回 null 表示这次请求既没登录也没设备 cookie，没地方放通知。
 */
function notifOwner(account, device) {
  if (account) return NOTIF_ACCOUNT_PREFIX + String(account).toLowerCase();
  if (device) return NOTIF_DEVICE_PREFIX + String(device);
  return null;
}

/** 取出某个人的通知，新的在前 */
async function listNotifications(env, owner, limit = NOTIF_MAX_KEEP) {
  if (!owner) return [];
  const pre = owner + ':';
  let keys = [];
  try {
    const r = await env.USERS.list({ prefix: pre, limit });
    keys = (r && r.keys) || [];
  } catch {
    return [];
  }
  keys.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const out = [];
  for (const k of keys) {
    let n = null;
    try {
      n = await env.USERS.get(k.name, 'json');
    } catch {
      n = null;
    }
    if (!n || typeof n !== 'object') continue;
    out.push(Object.assign({ id: k.name.slice(pre.length) }, n));
  }
  return out;
}

/** 往某个人的通知中心塞一条 */
async function pushNotification(env, owner, rec) {
  if (!owner) return null;
  const at = Number(rec.at) || Date.now();
  const id = String(at).padStart(15, '0') + '-' + randomHex(3);
  const out = { at, text: capText(String(rec.text || ''), REPLY_MAX) };
  if (rec.ticketId) out.ticketId = String(rec.ticketId);
  if (rec.kind) out.kind = String(rec.kind);
  if (rec.title) out.title = capText(String(rec.title), NOTICE_TITLE_MAX);
  await env.USERS.put(owner + ':' + id, JSON.stringify(out));

  const all = await listNotifications(env, owner, NOTIF_MAX_KEEP + 20);
  for (const old of all.slice(NOTIF_MAX_KEEP)) {
    try {
      await env.USERS.delete(owner + ':' + old.id);
    } catch {
      /* 忽略 */
    }
  }
  return id;
}

/**
 * 公开公告列表：任何人都能看（含维护自动消息）。
 * 分页由前端按 ?limit=&offset= 指定；不传就是第一页、每页 NOTICE_PAGE_DEFAULT 条。
 * count / total 都是「一共有多少条」，不是「这一页返回了多少条」——
 * 首页只取 notices[0]，靠它兜底不受分页影响。
 */
async function handleNotices(env, request) {
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get('limit'));
  const rawOffset = Number(url.searchParams.get('offset'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), NOTICE_PAGE_MAX)
    : NOTICE_PAGE_DEFAULT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  const all = await listNotices(env, NOTICE_MAX_KEEP);
  const page = all.slice(offset, offset + limit);
  return json({
    ok: true,
    count: all.length,
    total: all.length,
    limit,
    offset,
    returned: page.length,
    notices: page.map((n) => ({
      id: n.id,
      at: Number(n.at) || 0,
      title: String(n.title || ''),
      body: String(n.body || ''),
      kind: n.kind === 'maint' ? 'maint' : 'manual',
    })),
  });
}

/** 我的通知 + 我的工单（含回复）：登录按账户，未登录按设备 */
async function handleMyNotifications(env, request) {
  const now = Date.now();

  // 没有设备 cookie 就现场发一个：/notice/ 页自己的请求和 status.js 的 /api/status
  // 是同时发出的，谁先到不确定 —— 不补发的话，第一次打开通知板块会被当成「没有身份」。
  let device = deviceIdOf(request);
  let mintedDevice = null;
  if (!device) {
    mintedDevice = randomHex(16);
    device = mintedDevice;
  }

  let account = '';
  let isAdmin = false;
  try {
    const s = await getSession(env, request);
    if (s) {
      const u = await sessionUser(env, s);
      account = (u && u.username) || s.username || '';
      isAdmin = !!(u && isAdminRole(roleOf(u)));
    }
  } catch {
    account = '';
  }

  const owner = notifOwner(account, device);
  const notifications = await listNotifications(env, owner, NOTIF_MAX_KEEP);

  // 我的工单：登录用户看自己账户提交的；未登录看这台设备提交的
  const all = await listTickets(env, TICKET_MAX_KEEP);
  const mine = all.filter((t) => {
    const byAccount = account && String(t.account || '').toLowerCase() === account.toLowerCase();
    const byDevice = device && t.dev && String(t.dev) === String(device);
    return !!(byAccount || byDevice);
  });

  return json({
    ok: true,
    me: {
      loggedIn: !!account,
      username: account || null,
      isAdmin,
      // 未登录时靠设备记住，换设备/清缓存就找不到了 —— 界面上会提示
      byDevice: !account && !!device,
    },
    notifications: notifications.map((n) => ({
      id: n.id,
      at: Number(n.at) || 0,
      text: String(n.text || ''),
      title: String(n.title || ''),
      kind: String(n.kind || ''),
      ticketId: String(n.ticketId || ''),
    })),
    tickets: mine.slice(0, 30).map((t) => {
      const replies = Array.isArray(t.replies) ? t.replies : [];
      return {
        id: t.id,
        title: String(t.title || ''),
        body: String(t.body || ''),
        at: Number(t.at) || 0,
        anonymous: t.anonymous === true,
        canReply: true,
        replies: replies.slice(-30).map((r) => ({
          at: Number(r.at) || 0,
          by: r.by === 'admin' ? 'admin' : 'user',
          text: String(r.text || ''),
        })),
      };
    }),
    serverNow: now,
  }, 200, mintedDevice ? { 'Set-Cookie': deviceCookie(mintedDevice) } : undefined);
}

/** 用户回复自己的工单（历史工单也能继续聊） */
async function handleTicketReply(env, request) {
  const body = await readJson(request);
  const id = String(body.id || '').trim();
  if (!/^\d{15}-[0-9a-f]{6}$/.test(id)) {
    return json({ ok: false, message: '工单编号不正确' }, 400);
  }
  const text = capText(String(body.text || '').trim(), REPLY_MAX + 1);
  if (ticketLen(text) < REPLY_MIN) {
    return json({ ok: false, message: '请先写点什么再发送' }, 400);
  }
  if (Array.from(text).length > REPLY_MAX) {
    return json({ ok: false, message: '回复太长了，最多 ' + REPLY_MAX + ' 个字' }, 400);
  }

  const t = await env.USERS.get(TICKET_PREFIX + id, 'json');
  if (!t || typeof t !== 'object') {
    return json({ ok: false, message: '找不到这条工单' }, 404);
  }

  // 身份校验：登录用户按账户名，未登录按设备 cookie。
  // 两者都对不上就不是你的工单，不能回复（否则谁都能给别人的工单留言）。
  const device = deviceIdOf(request);
  let account = '';
  try {
    const s = await getSession(env, request);
    if (s) {
      const u = await sessionUser(env, s);
      account = (u && u.username) || s.username || '';
    }
  } catch {
    account = '';
  }
  const byAccount = account && String(t.account || '').toLowerCase() === account.toLowerCase();
  const byDevice = device && t.dev && String(t.dev) === String(device);
  if (!byAccount && !byDevice) {
    return json({ ok: false, message: '这不是你提交的工单，不能在这里回复' }, 403);
  }

  const now = Date.now();
  const replies = Array.isArray(t.replies) ? t.replies.slice() : [];
  replies.push({ at: now, by: 'user', text });
  t.replies = replies.slice(-50);
  try {
    await env.USERS.put(TICKET_PREFIX + id, JSON.stringify(t));
  } catch {
    return json({ ok: false, message: '回复没能保存，请稍后再试' }, 500);
  }
  return json({ ok: true, message: '回复已发送', at: now });
}

/** 管理员回复工单：写入回复，并给提交者发一条个人通知 */
async function handleAdminTicketReply(env, request) {
  const guard = await requireAdmin(env, request);
  if (guard.error) return guard.error;

  const body = await readJson(request);
  const id = String(body.id || '').trim();
  if (!/^\d{15}-[0-9a-f]{6}$/.test(id)) {
    return json({ ok: false, message: '工单编号不正确' }, 400);
  }
  const text = capText(String(body.text || '').trim(), REPLY_MAX + 1);
  if (ticketLen(text) < REPLY_MIN) {
    return json({ ok: false, message: '请先写点什么再发送' }, 400);
  }
  if (Array.from(text).length > REPLY_MAX) {
    return json({ ok: false, message: '回复太长了，最多 ' + REPLY_MAX + ' 个字' }, 400);
  }

  const t = await env.USERS.get(TICKET_PREFIX + id, 'json');
  if (!t || typeof t !== 'object') {
    return json({ ok: false, message: '找不到这条工单' }, 404);
  }

  const now = Date.now();
  const replies = Array.isArray(t.replies) ? t.replies.slice() : [];
  replies.push({ at: now, by: 'admin', text, account: guard.session.username });
  t.replies = replies.slice(-50);
  try {
    await env.USERS.put(TICKET_PREFIX + id, JSON.stringify(t));
  } catch {
    return json({ ok: false, message: '回复没能保存，请稍后再试' }, 500);
  }

  // 提交者能在「通知板块 → 我的消息」里看到这条回复。
  // 匿名工单也照发 —— 归属看的是记录里的 account/dev，不是控制台显示的那个名字。
  let notified = false;
  try {
    const owner = notifOwner(t.account, t.dev);
    if (owner) {
      await pushNotification(env, owner, {
        at: now,
        kind: 'ticket-reply',
        ticketId: id,
        title: '工单有新回复',
        text: '你的工单《' + String(t.title || '') + '》有新回复：' + text.slice(0, 120),
      });
      notified = true;
    }
  } catch {
    notified = false;
  }

  return json({ ok: true, message: '回复已发送', at: now, notified });
}

/** 管理员发一条公开公告 */
async function handleAdminNoticePost(env, request) {
  const guard = await requireAdmin(env, request);
  if (guard.error) return guard.error;

  const body = await readJson(request);
  const title = capText(String(body.title || '').trim(), NOTICE_TITLE_MAX + 1);
  const text = capText(String(body.body || body.content || '').trim(), NOTICE_BODY_MAX + 1);

  if (Array.from(title).length < NOTICE_TITLE_MIN) {
    return json({ ok: false, message: '标题至少要 ' + NOTICE_TITLE_MIN + ' 个字' }, 400);
  }
  if (Array.from(text).length < NOTICE_BODY_MIN) {
    return json({ ok: false, message: '正文至少要 ' + NOTICE_BODY_MIN + ' 个字' }, 400);
  }
  if (Array.from(title).length > NOTICE_TITLE_MAX) {
    return json({ ok: false, message: '标题最多 ' + NOTICE_TITLE_MAX + ' 个字' }, 400);
  }
  if (Array.from(text).length > NOTICE_BODY_MAX) {
    return json({ ok: false, message: '正文最多 ' + NOTICE_BODY_MAX + ' 个字' }, 400);
  }

  const id = await postNotice(env, {
    at: Date.now(),
    title,
    body: text,
    kind: 'manual',
    setBy: guard.session.username,
  });
  return json({ ok: true, message: '公告已发布', id });
}

/** 管理员删公告：带 id 删一条，带 all:true 清空 */
async function handleAdminNoticeDelete(env, request) {
  const guard = await requireAdmin(env, request);
  if (guard.error) return guard.error;

  const body = await readJson(request);
  if (body.all) {
    const all = await listNotices(env, NOTICE_MAX_KEEP + 50);
    let n = 0;
    for (const x of all) {
      try {
        await env.USERS.delete(NOTICE_PREFIX + x.id);
        n++;
      } catch {
        /* 忽略 */
      }
    }
    return json({ ok: true, message: '已清空 ' + n + ' 条公告', deleted: n });
  }

  const id = String(body.id || '').trim();
  if (!/^\d{15}-[0-9a-f]{6}$/.test(id)) {
    return json({ ok: false, message: '公告编号不正确' }, 400);
  }
  await env.USERS.delete(NOTICE_PREFIX + id);
  return json({ ok: true, message: '已删除该公告', deleted: 1 });
}

/* ========================== 账户警告 ========================== */

/** 取出某个账户收到的警告，新的在前 */
async function listWarnings(env, account, limit = WARN_MAX_KEEP) {
  const name = String(account || '').toLowerCase();
  if (!name) return [];
  const pre = WARN_PREFIX + name + ':';
  let keys = [];
  try {
    const r = await env.USERS.list({ prefix: pre, limit });
    keys = (r && r.keys) || [];
  } catch {
    return [];
  }
  keys.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const out = [];
  for (const k of keys) {
    let w = null;
    try {
      w = await env.USERS.get(k.name, 'json');
    } catch {
      w = null;
    }
    if (!w || typeof w !== 'object') continue;
    out.push(Object.assign({ id: k.name.slice(pre.length) }, w));
  }
  return out;
}

/** 给某个账户记一条警告（内容由管理员手填） */
async function pushWarning(env, account, rec) {
  const name = String(account || '').toLowerCase();
  if (!name) return null;
  const at = Number(rec.at) || Date.now();
  const id = String(at).padStart(15, '0') + '-' + randomHex(3);
  const out = { at, text: capText(String(rec.text || ''), WARN_TEXT_MAX) };
  if (rec.by) out.by = String(rec.by);
  await env.USERS.put(WARN_PREFIX + name + ':' + id, JSON.stringify(out));

  const all = await listWarnings(env, name, WARN_MAX_KEEP + 10);
  for (const old of all.slice(WARN_MAX_KEEP)) {
    try {
      await env.USERS.delete(WARN_PREFIX + name + ':' + old.id);
    } catch {
      /* 忽略 */
    }
  }
  return id;
}

/** 某个账户的警告概况：一共几条、有几条还没看到 */
async function warningState(env, account) {
  const all = await listWarnings(env, account);
  let seen = 0;
  try {
    seen = Number(await env.USERS.get(WARN_SEEN_PREFIX + String(account || '').toLowerCase())) || 0;
  } catch {
    seen = 0;
  }
  const unread = all.filter((w) => Number(w.at) > seen);
  const last = all[0] || null;
  return {
    count: all.length,
    unread: unread.length,
    seenAt: seen || null,
    last: last
      ? { at: Number(last.at) || 0, text: String(last.text || ''), by: String(last.by || '') }
      : null,
  };
}

/** 管理员给某个账户发警告（内容管理员自己填） */
async function handleAdminWarn(env, request) {
  const guard = await requireAdmin(env, request);
  if (guard.error) return guard.error;

  const body = await readJson(request);
  const username = String(body.username || '').trim();
  const text = capText(String(body.text || body.message || '').trim(), WARN_TEXT_MAX + 1);

  if (!username) return json({ ok: false, message: '缺少用户名' }, 400);
  if (Array.from(text).length < WARN_TEXT_MIN) {
    return json({ ok: false, message: '请填写警告内容' }, 400);
  }
  if (Array.from(text).length > WARN_TEXT_MAX) {
    return json({ ok: false, message: '警告内容最多 ' + WARN_TEXT_MAX + ' 个字' }, 400);
  }

  const user = await getUser(env, username);
  if (!user) return json({ ok: false, message: '找不到这个账户' }, 404);
  const perm = canManageAccount(guard.user, user);
  if (!perm.ok) return perm.res;

  const now = Date.now();
  await pushWarning(env, user.username, { at: now, text, by: guard.session.username });

  // 同时放进「通知板块 → 我的消息」，弹窗关掉以后还能回头看到
  try {
    await pushNotification(env, notifOwner(user.username, null), {
      at: now,
      kind: 'warn',
      title: '账户警告',
      text,
    });
  } catch {
    /* 通知发不出去不影响警告本身 */
  }

  return json({ ok: true, message: '已警告账户 ' + user.username, username: user.username, warnedAt: now });
}

/** 当前用户确认「我知道了」，之后不再弹这个警告 */
async function handleWarningsSeen(env, request) {
  const session = await getSession(env, request);
  if (!session) return json({ ok: false, message: '请先登录', needLogin: true }, 401);
  const user = await sessionUser(env, session);
  const name = String((user && user.username) || session.username || '').toLowerCase();
  if (!name) return json({ ok: false, message: '请先登录', needLogin: true }, 401);
  const now = Date.now();
  try {
    await env.USERS.put(WARN_SEEN_PREFIX + name, String(now));
  } catch {
    return json({ ok: false, message: '没能记录，请稍后再试' }, 500);
  }
  return json({ ok: true, message: '已确认', seenAt: now });
}

/* ========================== 管理员控制台 ========================== */

/** 要求当前会话是管理员，否则返回 null */
async function requireAdmin(env, request) {
  const session = await getSession(env, request);
  if (!session) return { error: json({ ok: false, message: '请先登录', needLogin: true }, 401) };
  const user = await sessionUser(env, session);
  if (!user || !isAdminRole(roleOf(user))) {
    return { error: json({ ok: false, message: '无权访问，仅管理员可用' }, 403) };
  }
  // 被同时标记为封禁的管理员也不能进后台，避免「封禁了却还能管理」
  if (banState(user, Date.now()).banned) {
    return { error: json({ ok: false, message: '该账户已被封禁' }, 403) };
  }
  return { session, user, role: roleOf(user) };
}

/** 要求主管理员（副管理员不能做权限变更类操作） */
async function requireSuperAdmin(env, request) {
  const guard = await requireAdmin(env, request);
  if (guard.error) return guard;
  if (guard.role !== 'super') {
    return { error: json({ ok: false, message: '只有主管理员可以进行此操作' }, 403) };
  }
  return guard;
}

/** 列出全部账户（给控制台用）。不返回任何密码字段 */
async function handleAdminUsers(env, request) {
  const guard = await requireAdmin(env, request);
  if (guard.error) return guard.error;

  const list = await env.USERS.list({ prefix: 'user:', limit: 1000 });

  // 警告次数：一次 list 把所有警告的键拿出来按账户归组，
  // 比「每个用户读一次」省很多（KV 免费额度有限）。
  const warnStats = {};
  try {
    const wr = await env.USERS.list({ prefix: WARN_PREFIX, limit: 1000 });
    for (const k of (wr && wr.keys) || []) {
      const rest = k.name.slice(WARN_PREFIX.length);
      const i = rest.lastIndexOf(':');
      if (i < 0) continue;
      const acc = rest.slice(0, i);
      const at = Number(rest.slice(i + 1, i + 16)) || 0;
      const g = warnStats[acc] || (warnStats[acc] = { count: 0, lastAt: 0 });
      g.count++;
      if (at > g.lastAt) g.lastAt = at;
    }
  } catch {
    /* 数不出来就当没有 */
  }

  const users = [];
  for (const k of list.keys) {
    const u = await env.USERS.get(k.name, 'json');
    if (!u) continue;
    const st = accountStatus(u);
    const ws = warnStats[String(u.username || '').toLowerCase()] || { count: 0, lastAt: 0 };
    users.push({
      username: u.username,
      email: u.email || '',
      isAdmin: !!u.isAdmin,
      verified: !!u.verified,
      isTrial: !!u.isTrial,
      createdAt: u.createdAt || null,
      state: st.state,
      label: st.label,
      days: st.days,
      role: roleOf(u),
      banned: banState(u, Date.now()).banned,
      banFrom: u.banFrom || null,
      banUntil: u.banUntil || null,
      banPermanent: !!u.banned && !u.banUntil,
      banRemainingMs: banState(u, Date.now()).remainingMs || null,
      bannedAt: u.bannedAt || null,
      // 警告次数与最后一次警告时间（控制台每行显示）
      warnCount: ws.count,
      lastWarnAt: ws.lastAt || null,
    });
  }
  // 管理员在前，其余按创建时间倒序
  users.sort((a, b) => (b.isAdmin ? 1 : 0) - (a.isAdmin ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0));

  const stats = {
    total: users.length,
    active: users.filter((u) => u.state === 'active').length,
    trial: users.filter((u) => u.state === 'trial').length,
    blocked: users.filter((u) => u.state === 'blocked').length,
    banned: users.filter((u) => u.state === 'banned').length,
  };

  // 注销通知：管理员点「已读」前一直累积
  let deletions = [];
  try {
    deletions = (await env.USERS.get(NOTICE_KEY, 'json')) || [];
  } catch {
    deletions = [];
  }
  if (!Array.isArray(deletions)) deletions = [];

  return json({
    ok: true,
    users,
    stats,
    notices: {
      deletions,
      count: deletions.length,
      latestAt: deletions.length ? deletions[0].at : null,
    },
    maintenance: Object.assign(maintenanceState(await getMaintenance(env), Date.now()), {
      // 控制台要用它渲染「页面维护」的勾选框：服务端是这张表唯一的主人，
      // 前端只负责显示和把勾选结果发回来。
      pageList: MAINT_PAGES,
    }),
  });
}

/**
 * 管理员点「已读」：删除注销通知。
 * 之后再有人注销，会重新累积出新的通知。
 */
async function handleAdminNoticesRead(env, request) {
  const guard = await requireAdmin(env, request);
  if (guard.error) return guard.error;

  let count = 0;
  try {
    const cur = (await env.USERS.get(NOTICE_KEY, 'json')) || [];
    count = Array.isArray(cur) ? cur.length : 0;
  } catch {
    count = 0;
  }
  await env.USERS.delete(NOTICE_KEY);

  return json({ ok: true, message: '已清空 ' + count + ' 条注销通知', cleared: count });
}

/* ========================== 维护时间 ========================== */

/** 维护时段存放的 KV 键 */
/** 找回密码：邮箱验证码有效期（秒） */
const RECOVER_TTL = 10 * 60;

/** 恢复代码里随机段的长度 */
const RECOVER_RAND_LEN = 32;

/** 维护期间「工作人员预览」通行证 Cookie 名 */
const MAINT_PASS_COOKIE = 'maintpass';

const MAINT_KEY = 'config:maintenance';

/** 维护时段最长允许 30 天，防止误填出一个「永久维护」 */
const MAINT_MAX_MS = 30 * 86400000;

/**
 * 可以被「页面维护」单独关掉的页面。
 * ⚠️ 故意**不含「联系我们」**：那个页面是所有人（尤其被封禁的人）唯一的联系通道，
 *    status.js 也硬性规定它永远不弹任何弹窗，所以这里不提供这个选项，
 *    免得管理员勾了却看不出任何效果。
 * id 是稳定标识（存进 KV 的就是它），name 只用来显示。
 * 这张表是唯一来源：控制台用它渲染勾选框，导航页用它把入口标成 Offline。
 */
const MAINT_PAGES = [
  { id: 'home', name: '主站首页', path: '/' },
  { id: 'aboutus', name: '关于项目组', path: '/aboutus' },
  { id: 'time', name: '北京时间', path: '/time' },
  { id: 'guide', name: '导航页', path: '/guide' },
  { id: 'notice', name: '通知板块', path: '/notice' },
  { id: 'sponsorship', name: '赞助', path: '/sponsorship' },
  { id: 'file', name: '资源库', path: '/file' },
  { id: 'login', name: '登录 / 注册', path: '/login' },
  { id: 'console', name: '控制台', path: '/console' },
];

const MAINT_PAGE_IDS = MAINT_PAGES.map((p) => p.id);

/** 洗干净前端传来的页面 id 列表：只留认识的、去重、按 MAINT_PAGES 的顺序排 */
function cleanMaintPages(input) {
  if (!Array.isArray(input)) return [];
  const set = new Set(input.map((x) => String(x || '').trim()));
  return MAINT_PAGE_IDS.filter((id) => set.has(id));
}

/** 读取维护时段；没设置或数据损坏时返回 null */
async function getMaintenance(env) {
  let m = null;
  try {
    m = await env.USERS.get(MAINT_KEY, 'json');
  } catch {
    m = null;
  }
  if (!m || typeof m.start !== 'number' || typeof m.end !== 'number') return null;
  if (!(m.end > m.start)) return null;
  // 维护结束后**整条配置连同访问密钥一起销毁**（密钥只在这一轮维护里有效）
  if (Date.now() >= m.end) {
    try {
      await env.USERS.delete(MAINT_KEY);
    } catch {
      /* 忽略 */
    }
    // 到点自动结束也要往通知板块说一声（以前只有「手动清除」才会发）。
    // 编号由结束时间决定，所以并发请求同时来发也只会留下一条。
    try {
      await postNotice(env, {
        id: String(m.end).padStart(15, '0') + '-end000',
        at: Date.now(),
        kind: 'maint',
        title: '维护已结束',
        body: '维护时段已到，站点已恢复正常，感谢等待。',
        setBy: m.setBy || '',
      });
    } catch {
      /* 公告发不出去不影响维护状态 */
    }
    return null;
  }
  return {
    start: m.start,
    end: m.end,
    key: typeof m.key === 'string' && m.key ? m.key : null,
    // 空数组 = 全站维护；老记录没有 pages 字段，等价于全站，行为和以前完全一样
    pages: cleanMaintPages(m.pages),
    setBy: m.setBy || null,
    setAt: m.setAt || null,
  };
}

/**
 * 把维护时段换算成「此刻是否在维护中」。
 *   active     —— 现在正处于 [start, end) 之内
 *   pages      —— 受影响的页面 id；**空数组 = 全站**
 *   scope      —— 'all'（全站）或 'pages'（只维护勾选的那几个）
 *   startsInMs —— 还没开始，距离开始还有多久
 *   remainingMs—— 维护中，距离结束还有多久（到点自动关弹窗）
 */
function maintenanceState(m, now) {
  if (!m) {
    return {
      set: false, active: false, start: null, end: null, remainingMs: null,
      startsInMs: null, ended: false, keySet: false, pages: [], scope: 'all',
    };
  }
  const active = now >= m.start && now < m.end;
  const pages = cleanMaintPages(m.pages);
  return {
    set: true,
    active,
    start: m.start,
    end: m.end,
    remainingMs: active ? Math.max(0, m.end - now) : null,
    startsInMs: now < m.start ? m.start - now : null,
    ended: now >= m.end,
    setBy: m.setBy,
    setAt: m.setAt,
    // 只告诉前端「设了密钥」，密钥本身永远不下发
    keySet: !!(m.key && String(m.key).length),
    pages,
    scope: pages.length ? 'pages' : 'all',
  };
}

/** 设置或清除维护时段（仅管理员） */
async function handleAdminMaintenance(env, request) {
  const guard = await requireAdmin(env, request);
  if (guard.error) return guard.error;

  const body = await readJson(request);
  const now = Date.now();

  // 清除
  if (body.clear) {
    // 只有真的撤销了一次维护才发公告，避免空点「清除」刷屏
    const before = await getMaintenance(env);
    await env.USERS.delete(MAINT_KEY);
    if (before) {
      try {
        await postNotice(env, {
          at: now,
          kind: 'maint',
          title: '维护已结束',
          body: '站点维护已结束，服务已恢复正常，感谢等待。',
          setBy: guard.session.username,
        });
      } catch {
        /* 公告发不出去不影响清除维护 */
      }
    }
    return json({ ok: true, message: '已清除维护时间', maintenance: maintenanceState(null, now) });
  }

  const start = Number(body.start);
  const end = Number(body.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return json({ ok: false, message: '请选择开始时间和结束时间' }, 400);
  }
  if (end <= start) {
    return json({ ok: false, message: '结束时间必须晚于开始时间' }, 400);
  }
  if (end - start > MAINT_MAX_MS) {
    return json({ ok: false, message: '维护时段最长 30 天' }, 400);
  }

  // 访问密钥：给工作人员在维护期间预览站点用；留空则不设。
  // 页面范围：body.pages 是数组就按它来（空数组 = 全站）；没传这个字段就沿用原来的，
  // 免得「改个时间」把已勾好的页面悄悄清成全站。
  let old = null;
  const needOld = body.keepKey || body.pages === undefined;
  if (needOld) old = await getMaintenance(env);

  const rawKey = body.key === undefined ? null : String(body.key).trim();
  let key = null;
  if (rawKey) {
    if (rawKey.length < 4 || rawKey.length > 64) {
      return json({ ok: false, message: '访问密钥长度需在 4–64 个字符之间' }, 400);
    }
    key = rawKey;
  } else if (body.keepKey) {
    // 只改时间段、不填密钥 → 沿用原来的
    key = old && old.key ? old.key : null;
  }

  const pages = body.pages === undefined ? (old ? old.pages : []) : cleanMaintPages(body.pages);

  const m = { start, end, setBy: guard.session.username, setAt: now };
  if (key) m.key = key;
  if (pages.length) m.pages = pages;
  await env.USERS.put(MAINT_KEY, JSON.stringify(m));

  const st = maintenanceState(m, now);
  const human = st.active ? '维护已开始' : '维护将于稍后自动开始';
  const scopeText = pages.length ? '，范围：' + pages.map(pageName).join('、') : '，范围：全站';

  // 维护也往通知板块发一条，用户不用等到点开某个页面才知道
  try {
    const scopeName = pages.length ? '（' + pages.map(pageName).join('、') + '）' : '（全站）';
    await postNotice(env, {
      at: now,
      kind: 'maint',
      title: st.active ? '站点正在维护' : '维护公告',
      body: st.active
        ? '站点正在维护中' + scopeName + '，预计 ' + fmtCST(end) + ' 结束。'
        : '站点将于 ' + fmtCST(start) + ' 开始维护' + scopeName + '，预计 ' + fmtCST(end) + ' 结束。',
      setBy: guard.session.username,
    });
  } catch {
    /* 公告发不出去不影响维护本身 */
  }

  return json({ ok: true, message: '维护时间已设置（' + human + scopeText + '）', maintenance: st });
}

/** 页面 id → 中文名（不认识就原样返回，方便排查） */
function pageName(id) {
  const p = MAINT_PAGES.find((x) => x.id === id);
  return p ? p.name : String(id);
}

/**
 * 激活 / 取消激活账户。
 * 激活 = 把 verified 置为 true，也就是「完成了电子邮件验证」。
 */
async function handleAdminActivate(env, request) {
  const guard = await requireAdmin(env, request);
  if (guard.error) return guard.error;

  const body = await readJson(request);
  const username = String(body.username || '').trim().toLowerCase();
  const activate = body.activate !== false;

  if (!username) return json({ ok: false, message: '缺少用户名' }, 400);

  const user = await getUser(env, username);
  const perm = canManageAccount(guard.user, user);
  if (!perm.ok) return perm.res;

  user.verified = activate;
  if (activate && !user.activatedAt) user.activatedAt = Date.now();
  if (activate) user.activatedBy = guard.session.username;
  await putUser(env, user);

  return json({
    ok: true,
    message: activate ? '已激活账户 ' + username : '已取消激活 ' + username,
    username,
    account: accountStatus(user),
  });
}

/**
 * 续期试用：把试用起点重置为现在，等于重新给 7 天。
 */
async function handleAdminExtend(env, request) {
  const guard = await requireAdmin(env, request);
  if (guard.error) return guard.error;

  const body = await readJson(request);
  const username = String(body.username || '').trim().toLowerCase();
  if (!username) return json({ ok: false, message: '缺少用户名' }, 400);

  const user = await getUser(env, username);
  const perm = canManageAccount(guard.user, user);
  if (!perm.ok) return perm.res;

  const days = Math.min(365, Math.max(1, Number(body.days) || TRIAL_DAYS));
  user.trialStart = Date.now();
  user.trialDays = days;
  await putUser(env, user);

  return json({
    ok: true,
    message: `已为 ${username} 重置 ${days} 天试用期`,
    username,
    account: accountStatus(user),
  });
}

/* ========================== 封禁 / 解封 ========================== */

/**
 * 封禁或解封账户。
 * 封禁后会立刻踢掉该账户的所有会话，于是他再登录时就会看到「You are banned」。
 */
async function handleAdminBan(env, request) {
  const guard = await requireAdmin(env, request);
  if (guard.error) return guard.error;

  const body = await readJson(request);
  const username = String(body.username || '').trim().toLowerCase();
  const banned = body.banned !== false;

  if (!username) return json({ ok: false, message: '缺少用户名' }, 400);

  const user = await getUser(env, username);
  const perm = canManageAccount(guard.user, user);
  if (!perm.ok) return perm.res;

  const now = Date.now();
  let human = '';

  if (!banned) {
    // 解封：清掉全部封禁字段
    delete user.banned;
    delete user.banFrom;
    delete user.banUntil;
    delete user.bannedAt;
    delete user.bannedBy;
    delete user.banReason;
    delete user.banAsn;
    delete user.banOrg;
    delete user.banIp;
    human = '已解封账户 ' + username;
  } else {
    // 起止时间：可只给结束时间（从现在开始），也可给未来开始时间
      let from = Number(body.from) || 0;
      let until = Number(body.until) || 0;

      // 先按客户端原始值校验：结束时间必须晚于开始时间。
      // 必须放在「时钟修正」之前，否则非法输入会被悄悄夹成 1 秒而不报错。
      if (until && from && until <= from) {
    return json({ ok: false, message: '封禁结束时间必须晚于开始时间' }, 400);
      }

      // 客户端时钟可能比服务端快/慢几秒。开始时间就在此刻附近时按服务端时间算，
      // 否则用户点「立即封禁」会被误判成「已排期」。结束时间用「时长」推算，
      // 不受时钟偏差影响；真正排到未来的封禁则原样保留。
      const NEAR = 5 * 60 * 1000;
      if (from && Math.abs(from - now) < NEAR) {
        if (until) until = now + Math.max(1000, until - from);
        from = now;
      }

    if (until && until <= Math.max(from || now, now)) {
      return json({ ok: false, message: '封禁结束时间必须晚于开始时间' }, 400);
    }

    user.banned = true;
    user.bannedAt = now;
    user.bannedBy = guard.session.username;
    if (from) user.banFrom = from; else delete user.banFrom;
    if (until) user.banUntil = until; else delete user.banUntil;

    const st = banState(user, now);
    if (st.pending) {
      human = '已排期：' + username + ' 将从 ' + fmtShortTime(from) + ' 起被封禁'
        + (until ? '，至 ' + fmtShortTime(until) + ' 自动解封' : '');
    } else if (until) {
      human = '已封禁 ' + username + '，至 ' + fmtShortTime(until) + ' 自动解封';
    } else {
      human = '已永久封禁 ' + username;
    }
  }
  await putUser(env, user);

  // 立即生效：踢掉该账户所有会话，他重新登录就会看到提示
  const st2 = banState(user, now);
  let kicked = 0;
  if (st2.banned) kicked = await deleteUserSessions(env, username);

  return json({
    ok: true,
    message: human,
    username,
    kicked,
    account: accountStatus(user),
  });
}

/* ========================== 管理员权限（主 / 副） ========================== */

/**
 * 设置或解除「副管理员」。
 * 只有主管理员能做；主管理员自己的权限不能改；被封禁的账户不能提升。
 * 副管理员不能解除别的副管理员 —— 这一点由「必须主管理员」天然保证。
 */
async function handleAdminRole(env, request) {
  const guard = await requireSuperAdmin(env, request);
  if (guard.error) return guard.error;

  const body = await readJson(request);
  const username = String(body.username || '').trim().toLowerCase();
  const makeSub = body.admin !== false;

  if (!username) return json({ ok: false, message: '缺少用户名' }, 400);

  const user = await getUser(env, username);
  if (!user) return json({ ok: false, message: '账户不存在' }, 404);

  const tr = roleOf(user);
  if (tr === 'super') {
    return json({ ok: false, message: '主管理员权限不可更改' }, 400);
  }
  if (makeSub && banState(user, Date.now()).banned) {
    return json({ ok: false, message: '该账户已被封禁，请先解封再设为管理员' }, 400);
  }

  if (makeSub) {
    user.role = 'sub';
    user.isAdmin = true;
    user.grantedBy = guard.session.username;
    user.grantedAt = Date.now();
  } else {
    delete user.role;
    delete user.grantedBy;
    delete user.grantedAt;
    user.isAdmin = false;
    // 被降级后回到普通账户：如果从没验证过邮箱，就是一个试用账户
    if (!user.isTrial && !user.verified && !user.trialStart) user.trialStart = Date.now();
  }
  await putUser(env, user);

  return json({
    ok: true,
    message: makeSub ? '已设为副管理员：' + username : '已解除管理员权限：' + username,
    username,
    role: roleOf(user),
    account: accountStatus(user),
  });
}

/* ========================== 修改用户名 / 密码 ========================== */

/** 修改类验证码有效期（秒） */
const CHANGECODE_TTL = 10 * 60;

const CHANGE_LABEL = { username: '用户名', password: '密码' };

/** 从 Cookie 里取出当前会话 token */
function sessionToken(request) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)session=([a-f0-9]{64})/);
  return m ? m[1] : null;
}

/** 修改用户名 / 密码的通用前置校验 */
async function changeGuard(env, request) {
  const session = await getSession(env, request);
  if (!session) return { error: json({ ok: false, message: '请先登录', needLogin: true }, 401) };
  const user = await sessionUser(env, session);
  if (!user) return { error: json({ ok: false, message: '账户不存在' }, 404) };
  if (banState(user, Date.now()).banned) {
    return { error: json({ ok: false, message: '该账户已被封禁' }, 403) };
  }
  if (!user.email) {
    return { error: json({ ok: false, message: '该账户没有绑定邮箱，无法通过邮箱验证' }, 400) };
  }
  return { session, user };
}

/**
 * 第一步：校验新值，然后发一封确认邮件。
 * 密码在这一步就哈希好，避免明文躺在 KV 里。
 */
async function handleChangeRequest(env, request) {
  const g = await changeGuard(env, request);
  if (g.error) return g.error;
  const { user } = g;

  const body = await readJson(request);
  const field = String(body.field || '');
  if (field !== 'username' && field !== 'password') {
    return json({ ok: false, message: '不支持的修改类型' }, 400);
  }

  const rec = { field, tries: 0 };

  if (field === 'username') {
    if (roleOf(user) === 'super') {
      return json({ ok: false, message: '主管理员账户不可修改用户名' }, 403);
    }
    const newName = String(body.value || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{3,20}$/.test(newName)) {
      return json({ ok: false, message: '用户名需 3-20 位，仅字母数字下划线连字符' }, 400);
    }
    // 用运行时保留名（含密钥里的管理员 / 试用账户名），不能只用静态 RESERVED
    if (reservedNames(env).has(newName)) {
      return json({ ok: false, message: '该用户名为系统保留，请换一个' }, 400);
    }
    if (newName === user.username) {
      return json({ ok: false, message: '新用户名与当前用户名相同' }, 400);
    }
    if (await getUser(env, newName)) {
      return json({ ok: false, message: '该用户名已被占用' }, 400);
    }
    rec.newUsername = newName;
  } else {
    const pw = String(body.value || '');
    if (pw.length < 6) return json({ ok: false, message: '密码至少 6 位' }, 400);
    if (pw.length > 128) return json({ ok: false, message: '密码过长' }, 400);
    rec.salt = randomHex(16);
    rec.hash = await hashPassword(pw, rec.salt);
    // 临时留在确认码记录里（10 分钟后随记录一起过期），
    // 用于确认成功后顺手刷新恢复代码 —— 只在这一个流程里短暂存在
    rec.plain = pw;
  }

  // 冷却：同一账户 60 秒内只能发一次
  const ck = 'changecooldown:' + user.username;
  if (await env.USERS.get(ck)) {
    return json({ ok: false, message: '确认码刚发过，请稍后再试或查看邮箱' }, 429);
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  rec.code = code;
  await env.USERS.put('changecode:' + user.username, JSON.stringify(rec), { expirationTtl: CHANGECODE_TTL });
  await env.USERS.put(ck, '1', { expirationTtl: CODE_COOLDOWN });

  const what = CHANGE_LABEL[field];
  const detail =
    field === 'username'
      ? `新用户名：<b style="color:#00ff8c">${rec.newUsername}</b>`
      : '新密码已在提交时记录（本邮件不会显示密码内容）';

  const sent = await sendMail(
    env,
    user.email,
    `【zrfeng.top】修改${what}确认`,
    `<div style="font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;padding:24px;background:#050807;color:#e8f5ee">
       <h2 style="color:#00ff8c;margin:0 0 12px">修改${what}确认</h2>
       <p style="color:#a9c6b8;margin:0 0 8px">账户 <b style="color:#00ff8c">${user.username}</b> 正在申请修改${what}。</p>
       <p style="color:#a9c6b8;margin:0 0 16px">${detail}</p>
       <p style="color:#a9c6b8;margin:0 0 8px">确认码：</p>
       <p style="font-size:30px;letter-spacing:8px;font-weight:700;color:#00ff8c;margin:0 0 18px">${code}</p>
       <p style="color:#7fa893;font-size:13px;margin:0">10 分钟内有效。</p>
       <p style="color:#5c7a6b;font-size:12px;margin:16px 0 0">如果这不是你本人操作，请忽略本邮件，${what}不会有任何变化。</p>
     </div>`
  );
  if (!sent.ok) return json({ ok: false, message: sent.message }, 502);

  return json({
    ok: true,
    message: `确认码已发送到 ${maskEmail(user.email)}`,
    needCode: true,
    field,
  });
}

/** 第二步（二次确认）：凭邮件里的确认码真正修改 */
async function handleChangeConfirm(env, request) {
  const g = await changeGuard(env, request);
  if (g.error) return g.error;
  const { user } = g;

  const body = await readJson(request);
  const field = String(body.field || '');
  const input = String(body.code || '').trim();
  if (field !== 'username' && field !== 'password') {
    return json({ ok: false, message: '不支持的修改类型' }, 400);
  }
  if (!/^\d{6}$/.test(input)) return json({ ok: false, message: '请输入 6 位确认码' }, 400);

  const rec = await env.USERS.get('changecode:' + user.username, 'json');
  if (!rec || rec.field !== field) {
    return json({ ok: false, message: '确认码已过期，请重新获取' }, 400);
  }
  if (rec.tries >= 5) {
    await env.USERS.delete('changecode:' + user.username);
    return json({ ok: false, message: '尝试次数过多，请重新获取确认码' }, 400);
  }
  if (String(input) !== String(rec.code)) {
    rec.tries = (rec.tries || 0) + 1;
    await env.USERS.put('changecode:' + user.username, JSON.stringify(rec), { expirationTtl: CHANGECODE_TTL });
    return json({ ok: false, message: '确认码不正确' }, 400);
  }

  const token = sessionToken(request);

  if (field === 'username') {
    const newName = rec.newUsername;
    // 再查一次：这十分钟里可能被别人抢注了
    if (await getUser(env, newName)) {
      return json({ ok: false, message: '该用户名刚被占用，请重新发起修改' }, 409);
    }
    const oldName = user.username;
    user.username = newName;
    await env.USERS.delete('user:' + oldName);
    await putUser(env, user); // 写 user:<新名> 与 email:<邮箱> → 新名

    // 让当前这台设备的会话跟到新名字，其它设备上的会话失效（它们的用户名已不存在）
    if (token) {
      const s = await env.USERS.get('session:' + token, 'json');
      if (s) {
        s.username = newName;
        await env.USERS.put('session:' + token, JSON.stringify(s));
      }
    }
    const kicked = await deleteUserSessions(env, oldName, token);
    await env.USERS.delete('changecode:' + oldName);
    await env.USERS.delete('changecooldown:' + oldName);

    return json({
      ok: true,
      field,
      message: `用户名已修改为 ${newName}`,
      username: newName,
      kicked,
    });
  }

  // 改密码：只踢掉其它设备，当前这台继续用
  user.salt = rec.salt;
  user.hash = rec.hash;
  if (field === 'password' && rec.plain) {
    // 手上有新密码明文，顺手把恢复代码刷新
    user.recoveryCode = makeRecoveryCode(user, rec.plain);
  }
  user.passwordChangedAt = Date.now();
  await putUser(env, user);
  await env.USERS.delete('changecode:' + user.username);
  const kicked = await deleteUserSessions(env, user.username, token);

  return json({
    ok: true,
    field,
    message: kicked > 0 ? `密码已修改，其它 ${kicked} 台设备已登出` : '密码已修改',
    kicked,
  });
}

/* ========================== 邮箱：添加 / 更改 ========================== */

/** 邮箱验证码有效期（秒） */
const EMAILCODE_TTL = 10 * 60;

/** 邮箱相关操作的通用前置校验 */
async function emailGuard(env, request) {
  const session = await getSession(env, request);
  if (!session) return { error: json({ ok: false, message: '请先登录', needLogin: true }, 401) };
  const user = await sessionUser(env, session);
  if (!user) return { error: json({ ok: false, message: '账户不存在' }, 404) };
  if (banState(user, Date.now()).banned) {
    return { error: json({ ok: false, message: '该账户已被封禁' }, 403) };
  }
  return { session, user };
}

/** 这个邮箱能不能被该账户使用 */
async function emailAvailable(env, email, user) {
  if (await isEmailRetired(env, email)) {
    return { ok: false, message: '该邮箱已注销，不可使用' };
  }
  const owner = await env.USERS.get('email:' + email);
  if (owner && owner !== user.username) {
    return { ok: false, message: '该邮箱已被其他账户使用' };
  }
  if (user.email && user.email === email) {
    return { ok: false, message: '新邮箱与当前邮箱相同' };
  }
  return { ok: true };
}

/**
 * 邮箱操作第一步：发验证码。
 *
 *   action=add,    step=new —— 账户还没有邮箱时「添加邮箱」：
 *                              要**新邮箱 + 密码**，验证通过即激活账户。
 *   action=change, step=old —— 已有邮箱时「更改邮箱」：先验证**旧邮箱**。
 *   action=change, step=new —— 旧邮箱验证通过后，再验证**新邮箱**。
 */
async function handleEmailRequest(env, request) {
  const g = await emailGuard(env, request);
  if (g.error) return g.error;
  const { user } = g;

  const body = await readJson(request);
  const action = String(body.action || '');
  const step = String(body.step || '');


  let rec = null;
  let to = '';

  if (action === 'add') {
    if (user.email) return json({ ok: false, message: '该账户已有邮箱，请使用「更改邮箱」' }, 400);
    if (step !== 'new') return json({ ok: false, message: '参数不正确' }, 400);

    const pw = String(body.password || '');
    if (!pw) return json({ ok: false, message: '请输入密码' }, 400);
    const hash = await hashPassword(pw, user.salt);
    if (!timingSafeEqual(hash, user.hash)) {
      return json({ ok: false, message: '密码不正确' }, 401);
    }

    const v = validateEmail(body.email);
    if (!v.ok) return json({ ok: false, message: v.message }, 400);
    const av = await emailAvailable(env, v.email, user);
    if (!av.ok) return json({ ok: false, message: av.message }, 400);

    rec = { action: 'add', stage: 'new', newEmail: v.email };
    to = v.email;
  } else if (action === 'change') {
    if (!user.email) return json({ ok: false, message: '该账户还没有邮箱，请使用「添加邮箱」' }, 400);

    if (step === 'old') {
      rec = { action: 'change', stage: 'old' };
      to = user.email;
    } else if (step === 'new') {
      const prev = await env.USERS.get('emailcode:' + user.username, 'json');
      if (!prev || prev.action !== 'change' || !prev.oldVerified) {
        return json({ ok: false, message: '请先验证当前邮箱' }, 400);
      }
      const v = validateEmail(body.email);
      if (!v.ok) return json({ ok: false, message: v.message }, 400);
      const av = await emailAvailable(env, v.email, user);
      if (!av.ok) return json({ ok: false, message: av.message }, 400);

      rec = { action: 'change', stage: 'new', oldVerified: true, newEmail: v.email };
      to = v.email;
    } else {
      return json({ ok: false, message: '参数不正确' }, 400);
    }
  } else {
    return json({ ok: false, message: '不支持的邮箱操作' }, 400);
  }

  // 限流放在各项校验之后：这样「还没验证旧邮箱」之类的真实原因才不会被 429 掩盖
  const ck = 'emailcooldown:' + user.username;
  if (await env.USERS.get(ck)) {
    return json({ ok: false, message: '验证码刚发过，请稍后再试或查看邮箱' }, 429);
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  rec.code = code;
  rec.tries = 0;
  await env.USERS.put('emailcode:' + user.username, JSON.stringify(rec), { expirationTtl: EMAILCODE_TTL });
  await env.USERS.put(ck, '1', { expirationTtl: CODE_COOLDOWN });

  const isOld = rec.stage === 'old';
  const title = isOld ? '验证当前邮箱' : action === 'add' ? '添加邮箱' : '验证新邮箱';
  const tip = isOld
    ? '有人正在为你的账户更换绑定邮箱。'
    : action === 'add'
      ? '把这个邮箱绑定到你的账户后，账户即完成激活。'
      : '这是要绑定的新邮箱。';

  const sent = await sendMail(
    env,
    to,
    '【zrfeng.top】' + title + '确认',
    '<div style="font-family:system-ui,-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;padding:24px;background:#050807;color:#e8f5ee">' +
      '<h2 style="color:#00ff8c;margin:0 0 12px">' + title + '确认</h2>' +
      '<p style="color:#a9c6b8;margin:0 0 8px">账户 <b style="color:#00ff8c">' + user.username + '</b></p>' +
      '<p style="color:#a9c6b8;margin:0 0 16px">' + tip + '</p>' +
      '<p style="color:#a9c6b8;margin:0 0 8px">确认码：</p>' +
      '<p style="font-size:30px;letter-spacing:8px;font-weight:700;color:#00ff8c;margin:0 0 18px">' + code + '</p>' +
      '<p style="color:#7fa893;font-size:13px;margin:0">10 分钟内有效。</p>' +
      '<p style="color:#5c7a6b;font-size:12px;margin:16px 0 0">如果不是你本人操作，请忽略本邮件，邮箱不会有任何变化。</p>' +
      '</div>'
  );
  if (!sent.ok) return json({ ok: false, message: sent.message }, 502);

  return json({
    ok: true,
    message: '确认码已发送到 ' + maskEmail(to),
    needCode: true,
    action,
    step: rec.stage,
  });
}

/**
 * 邮箱操作第二步：校验验证码。
 * 「更改邮箱」会先用旧邮箱的码走到 ready，再让前端去要新邮箱。
 */
async function handleEmailConfirm(env, request) {
  const g = await emailGuard(env, request);
  if (g.error) return g.error;
  const { user } = g;

  const body = await readJson(request);
  const action = String(body.action || '');
  const code = String(body.code || '').trim();
  if (action !== 'add' && action !== 'change') {
    return json({ ok: false, message: '不支持的邮箱操作' }, 400);
  }
  if (!/^\d{6}$/.test(code)) return json({ ok: false, message: '请输入 6 位验证码' }, 400);

  const key = 'emailcode:' + user.username;
  const rec = await env.USERS.get(key, 'json');
  if (!rec || rec.action !== action) {
    return json({ ok: false, message: '验证码已过期，请重新获取' }, 400);
  }
  if (rec.tries >= 5) {
    await env.USERS.delete(key);
    return json({ ok: false, message: '尝试次数过多，请重新获取验证码' }, 400);
  }
  if (String(code) !== String(rec.code)) {
    rec.tries = (rec.tries || 0) + 1;
    await env.USERS.put(key, JSON.stringify(rec), { expirationTtl: EMAILCODE_TTL });
    return json({ ok: false, message: '验证码不正确' }, 400);
  }

  // 旧邮箱验证通过 → 进入「输入新邮箱」阶段
  if (rec.stage === 'old') {
    rec.stage = 'ready';
    rec.oldVerified = true;
    delete rec.code;
    await env.USERS.put(key, JSON.stringify(rec), { expirationTtl: EMAILCODE_TTL });
    // 清掉冷却，让用户能立刻给新邮箱发码
    await env.USERS.delete('emailcooldown:' + user.username);
    return json({
      ok: true,
      needNewEmail: true,
      message: '当前邮箱已验证，请输入新的邮箱地址',
    });
  }

  // 正式生效
  const newEmail = rec.newEmail;
  const av = await emailAvailable(env, newEmail, user);
  if (!av.ok) return json({ ok: false, message: av.message }, 409);

  const oldEmail = user.email;
  if (oldEmail && oldEmail !== newEmail) await env.USERS.delete('email:' + oldEmail);

  user.email = newEmail;
  user.verified = true; // 邮箱验证通过 = 账户已激活
  user.emailChangedAt = Date.now();
  await putUser(env, user);
  await env.USERS.delete(key);
  await env.USERS.delete('emailcooldown:' + user.username);

  const wasAdd = rec.action === 'add';
  return json({
    ok: true,
    message: wasAdd ? '邮箱已添加，账户已激活' : '邮箱已更新',
    email: newEmail,
    account: accountStatus(user),
  });
}

/* ========================== 维护期间：工作人员预览 ========================== */

/** 从 Cookie 里取维护通行证 */
function maintPassOf(request) {
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)maintpass=([a-f0-9]{32})/);
  return m ? m[1] : null;
}

/**
 * 这次请求是否持有有效的维护通行证。
 * 只在维护进行中有效，且必须在 KV 里对得上 —— 维护一结束整条配置就被删了，
 * 通行证自然失效。
 */
async function maintUnlocked(env, request, m) {
  if (!m || !m.key) return false;
  const token = maintPassOf(request);
  if (!token) return false;
  try {
    const rec = await env.USERS.get('maintpass:' + token, 'json');
    return !!(rec && rec.until && Date.now() < rec.until);
  } catch {
    return false;
  }
}

/**
 * 工作人员用「本次维护访问密钥」换取通行证。
 * 密钥由管理员在控制台随时自定义，维护结束自动销毁。
 */
async function handleMaintUnlock(env, request) {
  const now = Date.now();
  const m = await getMaintenance(env);
  if (!m || !(now >= m.start && now < m.end)) {
    return json({ ok: false, message: '当前不在维护时段' }, 400);
  }
  if (!m.key) return json({ ok: false, message: '本次维护没有设置访问密钥' }, 400);

  const body = await readJson(request);
  const input = String(body.key || '').trim();
  if (!input) return json({ ok: false, message: '请输入访问密钥' }, 400);
  if (!timingSafeEqual(input, String(m.key))) {
    return json({ ok: false, message: '密钥不正确' }, 403);
  }

  const token = randomHex(16);
  const ttl = Math.max(60, Math.ceil((m.end - now) / 1000));
  await env.USERS.put('maintpass:' + token, JSON.stringify({ until: m.end, at: now }), {
    expirationTtl: ttl,
  });

  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  headers.append(
    'Set-Cookie',
    `maintpass=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}`
  );
  return new Response(JSON.stringify({ ok: true, message: '已进入预览模式' }), { status: 200, headers });
}

/* ========================== 找回密码 ========================== */

/** 新密码的基本校验 */
function checkNewPassword(pw) {
  if (!pw || pw.length < 6) return '密码至少 6 位';
  if (pw.length > 128) return '密码过长';
  return null;
}

/**
 * 方式一：用「恢复代码」重设密码。
 * 恢复代码形如 key--用户名:邮箱:密码--32位随机；代码里带着旧密码，
 * 所以这里直接拿它去核对哈希即可 —— 代码本身不需要在服务端存一份。
 */
async function handleRecoverByCode(env, request) {
  const body = await readJson(request);
  const code = String(body.code || '').trim();
  const newPassword = String(body.password || '');

  const bad = checkNewPassword(newPassword);
  if (bad) return json({ ok: false, message: bad }, 400);
  if (!code) return json({ ok: false, message: '请输入恢复代码' }, 400);

  const parsed = parseRecoveryCode(code);
  if (!parsed) return json({ ok: false, message: '恢复代码格式不正确' }, 400);

  const user = await getUser(env, parsed.username);
  if (!user) return json({ ok: false, message: '恢复代码不正确' }, 401);
  if (!(await verifyRecoveryCode(user, parsed))) {
    return json({ ok: false, message: '恢复代码不正确' }, 401);
  }

  const kicked = await applyNewPassword(env, user, newPassword);
  return json({
    ok: true,
    message: '密码已重设，请用新密码登录',
    username: user.username,
    kicked,
  });
}

/**
 * 方式二：用绑定邮箱收验证码重设密码。
 * 账户要存在且绑定了邮箱；为了不泄露「某个账号是否存在」，
 * 找不到时也回同样的提示。
 */
async function handleRecoverByEmailRequest(env, request, ip) {
  const body = await readJson(request);
  const human = await checkHuman(env, body, ip);
  if (!human.ok) return json({ ok: false, message: human.message }, 400);

  const account = String(body.account || '').trim().toLowerCase();
  if (!account) return json({ ok: false, message: '请输入用户名或邮箱' }, 400);

  const generic = { ok: true, message: '如果该账户存在且绑定了邮箱，验证码已发送，请查收' };
  const user = await findByLogin(env, account);
  if (!user || !user.email) return json(generic);

  const ck = 'recovercooldown:' + user.username;
  if (await env.USERS.get(ck)) {
    return json({ ok: false, message: '验证码刚发过，请稍后再试' }, 429);
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await env.USERS.put(
    'recovercode:' + user.username,
    JSON.stringify({ code, tries: 0, at: Date.now() }),
    { expirationTtl: RECOVER_TTL }
  );
  await env.USERS.put(ck, '1', { expirationTtl: CODE_COOLDOWN });

  const sent = await sendMail(
    env,
    user.email,
    '【zrfeng.top】重设密码验证',
    '<div style="font-family:system-ui,-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;padding:24px;background:#050807;color:#e8f5ee">' +
      '<h2 style="color:#00ff8c;margin:0 0 12px">重设密码验证</h2>' +
      '<p style="color:#a9c6b8;margin:0 0 8px">账户 <b style="color:#00ff8c">' + user.username + '</b> 正在申请重设密码。</p>' +
      '<p style="color:#a9c6b8;margin:0 0 8px">验证码：</p>' +
      '<p style="font-size:30px;letter-spacing:8px;font-weight:700;color:#00ff8c;margin:0 0 18px">' + code + '</p>' +
      '<p style="color:#7fa893;font-size:13px;margin:0">10 分钟内有效。</p>' +
      '<p style="color:#5c7a6b;font-size:12px;margin:16px 0 0">如果这不是你本人操作，请忽略本邮件，密码不会有任何变化。</p>' +
      '</div>'
  );
  if (!sent.ok) return json({ ok: false, message: sent.message }, 502);
  return json(generic);
}

/** 方式二第二步：验证码 + 新密码 */
async function handleRecoverByEmailConfirm(env, request) {
  const body = await readJson(request);
  const account = String(body.account || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  const newPassword = String(body.password || '');

  const bad = checkNewPassword(newPassword);
  if (bad) return json({ ok: false, message: bad }, 400);
  if (!/^\d{6}$/.test(code)) return json({ ok: false, message: '请输入 6 位验证码' }, 400);

  const user = await findByLogin(env, account);
  if (!user) return json({ ok: false, message: '验证码已过期，请重新获取' }, 400);

  const key = 'recovercode:' + user.username;
  const rec = await env.USERS.get(key, 'json');
  if (!rec) return json({ ok: false, message: '验证码已过期，请重新获取' }, 400);
  if (rec.tries >= 5) {
    await env.USERS.delete(key);
    return json({ ok: false, message: '尝试次数过多，请重新获取' }, 400);
  }
  if (!timingSafeEqual(code, String(rec.code))) {
    rec.tries = (rec.tries || 0) + 1;
    await env.USERS.put(key, JSON.stringify(rec), { expirationTtl: RECOVER_TTL });
    return json({ ok: false, message: '验证码不正确' }, 401);
  }

  await env.USERS.delete(key);
  await env.USERS.delete('recovercooldown:' + user.username);
  const kicked = await applyNewPassword(env, user, newPassword);
  return json({ ok: true, message: '密码已重设，请用新密码登录', username: user.username, kicked });
}

/* ========================== 新设备登录验证 ========================== */

/**
 * 「管理员给的密钥」表：{ "账户名": "密钥" }。
 * 存在 Cloudflare 密钥 DEVICE_KEYS 里，代码里一个字都不留。
 * 用于**没有邮箱**的账户（收不到验证码）在新设备上确认身份。
 */
function deviceKeys(env) {
  try {
    const j = JSON.parse(env.DEVICE_KEYS || '{}');
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/** 从 Cookie 里取设备标记 */
function deviceIdOf(request) {
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)device=([a-f0-9]{32})/);
  return m ? m[1] : null;
}

/** 生成设备标记 Cookie */
function deviceCookie(id) {
  return `device=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DEVICE_COOKIE_TTL}`;
}

/** 这个设备之前在该账户上登录成功过吗 */
async function isKnownDevice(env, user, deviceId) {
  if (!deviceId) return false;
  let list = [];
  try {
    list = (await env.USERS.get('devices:' + user.username, 'json')) || [];
  } catch {
    list = [];
  }
  return Array.isArray(list) && list.includes(deviceId);
}

/** 记住一台设备（最近使用的排前面） */
async function rememberDevice(env, username, deviceId) {
  if (!deviceId) return;
  let list = [];
  try {
    list = (await env.USERS.get('devices:' + username, 'json')) || [];
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  const next = [deviceId, ...list.filter((x) => x !== deviceId)].slice(0, MAX_DEVICES);
  await env.USERS.put('devices:' + username, JSON.stringify(next));
}

/** 发一封「新设备登录」验证码邮件 */
async function sendDeviceCode(env, user, code) {
  return await sendMail(
    env,
    user.email,
    '【zrfeng.top】新设备登录验证',
    '<div style="font-family:system-ui,-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;padding:24px;background:#050807;color:#e8f5ee">' +
      '<h2 style="color:#00ff8c;margin:0 0 12px">新设备登录验证</h2>' +
      '<p style="color:#a9c6b8;margin:0 0 8px">账户 <b style="color:#00ff8c">' + user.username + '</b> 正在一台<b>没有登录过</b>的设备上登录。</p>' +
      '<p style="color:#a9c6b8;margin:0 0 16px">如果这是你本人，请输入下面的验证码完成登录；如果不是，请忽略本邮件并尽快修改密码。</p>' +
      '<p style="font-size:30px;letter-spacing:8px;font-weight:700;color:#00ff8c;margin:0 0 18px">' + code + '</p>' +
      '<p style="color:#7fa893;font-size:13px;margin:0">10 分钟内有效。</p>' +
      '</div>'
  );
}

/**
 * 新设备登录第二步：凭票据 + 邮件验证码换取会话。
 * 通过后把这台设备记进账户的已知设备列表，以后同一台设备就不用再验证。
 */
async function handleDeviceVerify(env, request) {
  const body = await readJson(request);
  const ticket = String(body.ticket || '').trim();
  if (!/^[a-f0-9]{32}$/.test(ticket)) {
    return json({ ok: false, message: '登录票据无效，请重新登录' }, 400);
  }

  const key = 'devlogin:' + ticket;
  const rec = await env.USERS.get(key, 'json');
  if (!rec) return json({ ok: false, message: '验证已过期，请重新登录' }, 400);

  const user = await getUser(env, rec.username);
  if (!user) return json({ ok: false, message: '账户不存在' }, 404);

  // 重发验证码
  if (body.resend) {
    if (await env.USERS.get('devcooldown:' + ticket)) {
      return json({ ok: false, message: '验证码刚发过，请稍后再试' }, 429);
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    rec.code = code;
    rec.tries = 0;
    await env.USERS.put(key, JSON.stringify(rec), { expirationTtl: DEVLOGIN_TTL });
    await env.USERS.put('devcooldown:' + ticket, '1', { expirationTtl: CODE_COOLDOWN });
    const sent = await sendDeviceCode(env, user, code);
    if (!sent.ok) return json({ ok: false, message: sent.message }, 502);
    return json({ ok: true, message: '验证码已重新发送到 ' + maskEmail(user.email) });
  }

  if (rec.tries >= 5) {
    await env.USERS.delete(key);
    return json({ ok: false, message: '尝试次数过多，请重新登录' }, 400);
  }

  // 无邮箱账户：核对「管理员给的密钥」
  if (rec.mode === 'key') {
    const input = String(body.key || body.code || '').trim();
    if (!input) return json({ ok: false, message: '请输入密钥' }, 400);
    const expected = String(deviceKeys(env)[rec.username] || '');
    const pass = expected && timingSafeEqual(input, expected);
    if (!pass) {
      rec.tries = (rec.tries || 0) + 1;
      await env.USERS.put(key, JSON.stringify(rec), { expirationTtl: DEVLOGIN_TTL });
      return json({ ok: false, message: '你无权访问' }, 403);
    }
  } else {
    const code = String(body.code || '').trim();
    if (!/^\d{6}$/.test(code)) return json({ ok: false, message: '请输入 6 位验证码' }, 400);
    if (!timingSafeEqual(code, String(rec.code || ''))) {
      rec.tries = (rec.tries || 0) + 1;
      await env.USERS.put(key, JSON.stringify(rec), { expirationTtl: DEVLOGIN_TTL });
      return json({ ok: false, message: '验证码不正确' }, 401);
    }
  }

  // 通过：记住设备 + 建会话
  await rememberDevice(env, user.username, rec.deviceId);
  await env.USERS.delete(key);
  await env.USERS.delete('devcooldown:' + ticket);

  const status = accountStatus(user);
  const { cookie } = await createSession(env, user);
  // 两个 Cookie 必须用 Headers.append 分开发 —— 用数组会被拼成一条，device 标记就丢了
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  headers.append('Set-Cookie', cookie);
  headers.append('Set-Cookie', deviceCookie(rec.deviceId));
  return new Response(
    JSON.stringify({
      ok: true,
      message: '验证通过，登录成功',
      user: {
        username: user.username,
        email: user.email,
        isAdmin: isAdminRole(roleOf(user)),
        role: roleOf(user),
        isSuper: roleOf(user) === 'super',
      },
      account: status,
    }),
    { status: 200, headers }
  );
}

/* ========================== 中英文分站 ========================== */

/**
 * 语种偏好 Cookie。只有用户在页面上点了「中文 / English」才会写，
 * 用来盖过地区判断 —— 美国 IP 不想看英文时点一下中文，以后就不再被跳走。
 */
const LANG_COOKIE = 'zrfeng-lang';
const LANG_COOKIE_MAX_AGE = 60 * 60 * 24 * 180; // 半年

/** 读单个 Cookie（不引第三方库，写死这里够用） */
function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return part.slice(i + 1).trim();
    }
  }
  return null;
}

/** 只有「页面」才参与地区跳转，静态资源（js/css/图片/字体…）一律不碰 */
function isPagePath(path) {
  return !/\.(js|css|json|txt|xml|map|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf|zip|gz)$/i.test(path);
}

/** 302 跳转，带 no-store 免得 CDN 把某个地区的结果缓存给所有人 */
function redirectTo(location, cookieValue) {
  const headers = { location, 'cache-control': 'no-store' };
  if (cookieValue) {
    headers['set-cookie'] =
      LANG_COOKIE + '=' + cookieValue + '; Path=/; Max-Age=' + LANG_COOKIE_MAX_AGE + '; SameSite=Lax';
  }
  return new Response(null, { status: 302, headers });
}

/**
 * ?lang=zh / ?lang=en：记住选择，然后跳到去掉该参数的原路径。
 * 中英文页面上的切换链接都指向这里。
 */
function handleLangSwitch(request, url) {
  const want = (url.searchParams.get('lang') || '').toLowerCase();
  if (want !== 'zh' && want !== 'en') return null;
  const clean = new URL(url.toString());
  clean.searchParams.delete('lang');
  return redirectTo(clean.toString(), want);
}

/**
 * 地区跳转：美国 IP 默认进英文站（/en_us/ + 原路径）。
 * 不跳的情况：已经在 /en_us/、用户手动选过中文、非页面请求。
 */
function handleGeoRedirect(request, url) {
  const path = url.pathname;
  if (path === '/en_us' || path.startsWith('/en_us/')) return null;
  if (readCookie(request.headers.get('Cookie'), LANG_COOKIE) === 'zh') return null;

  const country = (request.cf && request.cf.country) || '';
  if (country !== 'US') return null;

  const dest = new URL(url.toString());
  dest.pathname = '/en_us' + (path === '/' ? '/' : path === '/index.html' ? '/' : path);
  // 顺手记下「英文」，后面 /api/* 的提示语就知道该出英文（用户点中文会被 cookie 覆盖）
  return redirectTo(dest.toString(), 'en');
}

/* ---------------------- 接口文案的英文化 ---------------------- */

/**
 * 英文站（/en_us/）用的是同一套 /api/*，所以服务端返回的提示语也要跟着换语种，
 * 否则状态栏、登录报错还是中文。
 *
 * 判定顺序：Cookie（点过「中文 / English」或被地区跳转写过）→ ?lang= → Accept-Language。
 * 没有英文化词条的一律原样返回中文，宁可保留原文也不要给出半截翻译。
 */
function resolveLang(request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('lang') || '').toLowerCase();
  if (q === 'zh' || q === 'en') return q;

  const cookie = readCookie(request.headers.get('Cookie'), LANG_COOKIE);
  if (cookie === 'zh' || cookie === 'en') return cookie;

  const al = (request.headers.get('Accept-Language') || '').toLowerCase();
  if (!al) return 'zh';
  const first = al.split(',')[0].trim();
  return first.startsWith('en') ? 'en' : 'zh';
}

/** 完整匹配的词条（面向普通访客的路径：登录注册、工单、公告、下载门控） */
const EN_MESSAGES = {
  '账号或密码错误': 'Incorrect account or password',
  '请输入账号和密码': 'Please enter your account and password',
  '请输入用户名或邮箱': 'Please enter your username or email',
  '请输入邮箱': 'Please enter your email',
  '请输入密码': 'Please enter your password',
  '邮箱格式不正确': 'Invalid email address',
  '邮箱长度超出限制': 'Email address is too long',
  '密码至少 6 位': 'Password must be at least 6 characters',
  '密码过长': 'Password is too long',
  '密码不正确': 'Incorrect password',
  '密码已重设，请用新密码登录': 'Password reset. Please log in with your new password',
  '用户名需 3-20 位，仅字母数字下划线连字符': 'Username must be 3–20 characters: letters, digits, underscore or hyphen only',
  '该用户名已被注册': 'That username is already taken',
  '该用户名已被占用': 'That username is already taken',
  '该用户名刚被占用，请重新发起修改': 'That username was just taken. Please start the change again',
  '该用户名为系统保留，请换一个': 'That username is reserved. Please choose another',
  '该邮箱已被注册': 'That email is already registered',
  '该邮箱已被其他账户使用': 'That email is used by another account',
  '该邮箱已注销，不可再次注册': 'That email was deleted and cannot be registered again',
  '该邮箱已注销，不可使用': 'That email was deleted and cannot be used',
  '该账户已被封禁': 'This account is banned',
  '该账户已被封禁，请联系管理员': 'This account is banned. Please contact the admin',
  '该账户已被封禁，请先解封再设为管理员': 'This account is banned. Unban it before making it an admin',
  '该账户没有绑定邮箱，无法发送确认邮件': 'This account has no email bound, so no confirmation email can be sent',
  '该账户没有绑定邮箱，无法通过邮箱验证': 'This account has no email bound, so it cannot be verified by email',
  '该账户还没有邮箱，请使用「添加邮箱」': 'This account has no email yet. Use “Add email”',
  '该账户已有邮箱，请使用「更改邮箱」': 'This account already has an email. Use “Change email”',
  '账户不存在': 'Account does not exist',
  '账户已注销': 'Account deleted',
  '账户试用期已到，请联系管理员以激活账户': 'Your trial has ended. Please contact the admin to activate your account',
  '管理员账户不可注销': 'Admin accounts cannot be deleted',
  '试用账户不可注销': 'Trial accounts cannot be deleted',
  '验证码不正确': 'Incorrect verification code',
  '验证码已过期，请重新获取': 'Verification code expired. Please request a new one',
  '验证码刚发过，请稍后再试': 'A code was just sent. Please try again shortly',
  '验证码刚发过，请稍后再试或查看邮箱': 'A code was just sent. Please wait or check your inbox',
  '验证码已发送，请查收邮件（含垃圾箱）': 'Verification code sent. Please check your inbox (including spam)',
  '确认码不正确': 'Incorrect confirmation code',
  '确认码已过期，请重新获取': 'Confirmation code expired. Please request a new one',
  '确认码刚发过，请稍后再试或查看邮箱': 'A code was just sent. Please wait or check your inbox',
  '请输入 6 位验证码': 'Please enter the 6-digit verification code',
  '请输入 6 位确认码': 'Please enter the 6-digit confirmation code',
  '请输入恢复代码': 'Please enter your recovery code',
  '恢复代码不正确': 'Incorrect recovery code',
  '请输入密钥': 'Please enter the key',
  '请输入访问密钥': 'Please enter the access key',
  '验证已过期，请重新登录': 'Verification expired. Please log in again',
  '登录票据无效，请重新登录': 'Invalid login ticket. Please log in again',
  '验证通过，登录成功': 'Verified. You are now logged in',
  '登录成功': 'Logged in',
  '注册成功': 'Registered successfully',
  '尝试次数过多，请重新获取验证码': 'Too many attempts. Please request a new code',
  '尝试次数过多，请重新获取确认码': 'Too many attempts. Please request a new confirmation code',
  '邮件服务未配置，请联系管理员': 'Email service is not configured. Please contact the admin',
  '邮件发送失败': 'Failed to send email',
  '邮件发送异常': 'Email sending error',
  '请先登录': 'Please log in first',
  '请先登录后再下载': 'Please log in before downloading',
  '无权访问，仅管理员可用': 'Access denied. Admins only',
  '工单编号不正确': 'Invalid ticket ID',
  '找不到这条工单': 'Ticket not found',
  '这不是你提交的工单，不能在这里回复': 'This ticket is not yours, so you cannot reply here',
  '请先写点什么再发送': 'Please write something first',
  '请填写标题和正文内容': 'Please fill in both title and body',
  '工单已提交，我会尽快查看。': 'Ticket submitted. I will look into it soon.',
  '回复已发送': 'Reply sent',
  '回复没能保存，请稍后再试': 'Could not save the reply. Please try again later',
  '参数不正确': 'Invalid parameters',
  '不支持的邮箱操作': 'Unsupported email action',
  '不支持的修改类型': 'Unsupported change type',
  '接口不存在': 'Endpoint not found',
  '服务器内部错误': 'Internal server error',
  '请选择开始时间和结束时间': 'Please choose a start and end time',
  '结束时间必须晚于开始时间': 'End time must be later than start time',
  '封禁结束时间必须晚于开始时间': 'Ban end time must be later than start time',
  '维护时段最长 30 天': 'A maintenance window cannot exceed 30 days',
  '访问密钥长度需在 4–64 个字符之间': 'Access key must be 4–64 characters',
  '没能记录，请稍后再试': 'Could not save it. Please try again later',
  '缺少文件内容': 'Missing file content',
  '缺少用户名': 'Missing username',
  '账户异常': 'Account restricted',
  '账户正常': 'Account active',
  '登录以享受服务': 'Log in to use this site',
  '未激活，试用期已到': 'Trial period over',
};

/** 带可变尾部/前缀的词条：命中前缀后拼上剩下的原文 */
const EN_PREFIXES = [
  ['这是一台新设备，验证码已发送到 ', 'This is a new device. A verification code was sent to '],
  ['验证码已重新发送到 ', 'Verification code re-sent to '],
  ['验证码已发送到 ', 'Verification code sent to '],
  ['确认码已发送到 ', 'Confirmation code sent to '],
  ['维护时间已设置（', 'Maintenance scheduled ('],
  ['已清空 ', 'Cleared '],
  ['标题至少要 ', 'Title must be at least '],
  ['正文至少要 ', 'Body must be at least '],
  ['正文最多 ', 'Body must be at most '],
  ['回复太长了，最多 ', 'Reply is too long (max '],
  ['警告内容最多 ', 'Warning text is too long (max '],
];

/** 试用期倒计时这类带数字的标签，用正则单独处理（尾部还有量词「天」） */
const EN_LABEL_RULES = [
  [/^未激活，试用期仅剩(\d+)天$/, (m) => 'Inactive, trial ends in ' + m[1] + ' days'],
  [/^未激活，试用期仅剩(\d+)天/, (m) => 'Inactive, trial ends in ' + m[1] + ' days'],
];

/** 单条文案英文化；翻不出来就原样返回中文 */
function localizeText(text, lang) {
  if (lang !== 'en') return text;
  const s = String(text);
  const exact = EN_MESSAGES[s];
  if (exact) return exact;
  for (const [re, fn] of EN_LABEL_RULES) {
    const m = s.match(re);
    if (m) return fn(m);
  }
  for (const [pre, en] of EN_PREFIXES) {
    if (s.startsWith(pre)) return en + s.slice(pre.length);
  }
  return s;
}

/**
 * 把 /api/* 的 JSON 响应里用户会看到的文案换成英文。
 * 只动 message / error / detail / hint 和 account.label 这几个字段，其余原样。
 * 不是 JSON、或者语种是中文，直接原响应返回（零开销穿透）。
 */
async function localizeResponse(res, request) {
  const lang = resolveLang(request);
  if (lang !== 'en') return res;
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return res;

  let data = null;
  try {
    data = await res.clone().json();
  } catch {
    return res;
  }
  if (!data || typeof data !== 'object') return res;

  let changed = false;
  for (const key of ['message', 'error', 'detail', 'hint']) {
    if (typeof data[key] === 'string') {
      const out = localizeText(data[key], lang);
      if (out !== data[key]) {
        data[key] = out;
        changed = true;
      }
    }
  }
  if (data.account && typeof data.account === 'object' && typeof data.account.label === 'string') {
    const out = localizeText(data.account.label, lang);
    if (out !== data.account.label) {
      data.account.label = out;
      changed = true;
    }
  }
  if (!changed) return res;

  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(data), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/* ========================== 主入口 ========================== */

async function handleRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const method = request.method;

    // 所有 API 都不缓存
    if (path.startsWith('/api/')) {
      // 诊断接口：不需要任何密钥即可访问，用于确认绑定与配置是否就绪。
      // 只报告「有没有」，绝不回显任何密钥内容。
      if (path === '/api/health' && method === 'GET') {
        const report = {
          ok: true,
          kv: { bound: !!env.USERS, working: false, error: null },
          secrets: {
            SESSION_SECRET: !!env.SESSION_SECRET,
            ADMIN_USERNAME: !!env.ADMIN_USERNAME,
            ADMIN_PASSWORD: !!env.ADMIN_PASSWORD,
            ADMIN_EMAIL: !!env.ADMIN_EMAIL,
            TRIAL_ACCOUNT: !!env.TRIAL_ACCOUNT,
            TRIAL_PASSWORD: !!env.TRIAL_PASSWORD,
            RESEND_API_KEY: !!env.RESEND_API_KEY,
            MAIL_FROM: !!env.MAIL_FROM,
            TURNSTILE_SECRET: !!env.TURNSTILE_SECRET,
          },

        };

        // 真正读写一次 KV，确认绑定可用（而不只是存在）
        if (env.USERS) {
          try {
            const probe = 'health:' + Date.now();
            await env.USERS.put(probe, 'ok', { expirationTtl: 60 });
            const back = await env.USERS.get(probe);
            await env.USERS.delete(probe);
            report.kv.working = back === 'ok';
            if (!report.kv.working) report.kv.error = '写入成功但读取不一致';
          } catch (e) {
            report.kv.error = String(e && e.message ? e.message : e).slice(0, 200);
          }
        } else {
          report.kv.error = '未绑定 USERS，请检查 wrangler.toml 的 kv_namespaces';
        }

        // 检查站内下载文件是否已上传
        const novel = await readNovelFile(env);
        report.novelFile = {
          uploaded: !!novel,
          name: novel ? novel.name : null,
          size: novel ? Number(novel.size) || 0 : 0,
        };

        // 整体是否可对外服务
        report.ready = report.kv.working && !!env.SESSION_SECRET;
        if (!report.ready && report.novelFile.uploaded) report.ready = false;

        const missing = [];
        if (!report.kv.working) missing.push('KV 绑定(USERS)');
        if (!env.SESSION_SECRET) missing.push('SESSION_SECRET');
        report.missing = missing;
        // 文件没上传不影响站点运行，只作为提示
        report.warnings = report.novelFile.uploaded ? [] : ['站内下载文件尚未上传'];

        return json(report);
      }

      // SESSION_SECRET 必须存在，否则签名不安全
      if (!env.SESSION_SECRET) {
        return json(
          { ok: false, message: '服务端未配置 SESSION_SECRET，请先完成部署配置' },
          500
        );
      }

      try {
        if (path === '/api/config' && method === 'GET') {
          // 前端据此决定用人机验证组件还是算术题
          return json({
            ok: true,
            turnstile: !!env.TURNSTILE_SECRET,
            turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
            suffixes: ALLOWED_SUFFIXES,
            mailReady: !!env.RESEND_API_KEY,
          });
        }

        if (path === '/api/captcha' && method === 'GET') {
          if (env.TURNSTILE_SECRET) {
            return json({ ok: true, mode: 'turnstile' });
          }
          const c = await issueCaptcha(env);
          return json({ ok: true, mode: 'math', ...c });
        }

        if (path === '/api/email-check' && method === 'POST') {
          const b = await readJson(request);
          return json(emailHint(b.email));
        }

        if (path === '/api/send-code' && method === 'POST') {
          return await handleSendCode(env, request, ip);
        }
        if (path === '/api/register' && method === 'POST') {
          return await handleRegister(env, request, ip);
        }
        if (path === '/api/login' && method === 'POST') {
          return await handleLogin(env, request, ip);
        }
        // 新设备登录第二步：凭票据 + 邮件验证码
        if (path === '/api/login/verify' && method === 'POST') {
          return await handleDeviceVerify(env, request);
        }
        // 维护期间：工作人员凭访问密钥进入预览模式
        if (path === '/api/maintenance/unlock' && method === 'POST') {
          return await handleMaintUnlock(env, request);
        }

        // 找回密码：恢复代码 / 邮箱验证码
        if (path === '/api/recover/code' && method === 'POST') {
          return await handleRecoverByCode(env, request);
        }
        if (path === '/api/recover/email/request' && method === 'POST') {
          return await handleRecoverByEmailRequest(env, request, ip);
        }
        if (path === '/api/recover/email/confirm' && method === 'POST') {
          return await handleRecoverByEmailConfirm(env, request);
        }
        // 提交工单：不需要登录（被封禁的人就是靠这里联系管理员）
        if (path === '/api/ticket' && method === 'POST') {
          return await handleTicketSubmit(env, request, ip);
        }
        if (path === '/api/logout' && method === 'POST') {
          return await handleLogout(env, request);
        }
        if (path === '/api/me' && method === 'GET') {
          const s = await getSession(env, request);
          if (!s) {
            return json({ ok: true, loggedIn: false, account: accountStatus(null) });
          }
          const u = await sessionUser(env, s);
          return json({
            ok: true,
            loggedIn: true,
            user: {
              // 用户名 / 邮箱都以实时记录为准：会话里存的是登录那一刻的快照，
              // 用户改过邮箱或用户名后，快照就过期了。
              username: (u && u.username) || s.username,
              email: (u && u.email) || "",
              // 只回给本人；控制台里显示，方便抄下来保存
              recoveryCode: (u && u.recoveryCode) || "",
              isAdmin: !!(u && isAdminRole(roleOf(u))),
              verified: !!(u && u.verified),
              isTrial: !!(u && u.isTrial),
              // 权限层级：super=主管理员，sub=副管理员，user=普通用户
              role: roleOf(u),
              isSuper: roleOf(u) === 'super',
              // 能否自助注销：由服务端判定，前端只用来决定是否显示按钮
              canDelete: !!(u && !u.isAdmin && !u.isTrial && u.email),
              // 能否在控制台自助修改用户名 / 密码（都需要邮箱验证码）
              canChangeUsername: !!(u && roleOf(u) !== 'super' && u.email && !banState(u, Date.now()).banned),
              canChangePassword: !!(u && u.email && !banState(u, Date.now()).banned),
              // 没有邮箱的账户可以「添加邮箱」来激活自己
              canAddEmail: !!(u && !u.email && !banState(u, Date.now()).banned),
              // 已有邮箱的账户可以「更改邮箱」（先验旧、再验新）
              canChangeEmail: !!(u && u.email && !banState(u, Date.now()).banned),
            },
            account: accountStatus(u),
          });
        }
        // 状态栏轻量接口：只返回状态，不含任何用户隐私
        if (path === '/api/status' && method === 'GET') {
          const s = await getSession(env, request);
          const u = s ? await sessionUser(env, s) : null;
          const devTouched = !deviceIdOf(request);
          return json({
            ok: true,
            loggedIn: !!s,
            username: u ? u.username : s ? s.username : null,
            isAdmin: !!(u && isAdminRole(roleOf(u))),
            account: accountStatus(u),
            // 账户偏好（亮/暗色）：换设备登录时前端据此询问是否套用。
            // 只给已登录用户，且只回传主题名，不含任何其它信息。
            prefTheme: await (async () => {
              const un = u ? u.username : s ? s.username : null;
              if (!un) return null;
              const p = await getPref(env, un);
              return p && (p.theme === 'light' || p.theme === 'dark') ? p.theme : null;
            })(),
            // 账户警告：只有登录用户才有；没看过的警告前端会弹一次
            warning: u ? await warningState(env, u.username) : null,
            // 维护时段：所有页面据此决定是否弹出「正在维护服务」。
            // 持有工作人员通行证的人：维护照实下发（导航页的 Offline 灯要靠它），
            // 但加 unlocked: true —— 弹窗看到它就不弹。
            maintenance: await (async () => {
              const mm = await getMaintenance(env);
              const st = maintenanceState(mm, Date.now());
              if (st.active && (await maintUnlocked(env, request, mm))) {
                return Object.assign({}, st, { unlocked: true });
              }
              return st;
            })(),
          }, 200, devTouched ? { 'Set-Cookie': deviceCookie(randomHex(16)) } : undefined);
        }
        // 线路自检：把 Cloudflare 眼里「你是谁」原样回给调用者自己，
        // 用来确认某个 VPN 线路到底落在哪个 ASN / 运营商上。
        if (path === '/api/netcheck' && method === 'GET') {
          const hit = await detectProxy(request, env);
          const cf = request.cf || {};
          const extra = await getProxyRules(env);
          const asn = Number(cf.asn) || 0;
          const org = String(cf.asOrganization || '');
          let verdict = hit.detected ? 'proxy' : 'clean';
          let hint;
          if (hit.detected) {
            hint = '这条线路已被判定为代理（命中方式：' + hit.via + '），注册/登录会被封号。';
          } else if (asn === 13335) {
            hint = '这是 Cloudflare WARP 出口，目前默认放行。若要一并封禁，开启 VPN_BLOCK_CF_WARP。';
          } else {
            hint = '这条线路目前没有被判定为代理。请把下面 asn 与 org 两行原样发给管理员，'
              + '即可把它加进名单（无需重新部署）。';
          }
          if (verdict === 'clean') await noteSeenLine(env, asn, org);
          return json({
            ok: true,
            ip: request.headers.get('CF-Connecting-IP') || '',
            asn,
            org,
            country: cf.country || null,
            region: cf.region || null,
            city: cf.city || null,
            colo: cf.colo || null,
            httpProtocol: cf.httpProtocol || null,
            tlsVersion: cf.tlsVersion || null,
            vpnBlockEnabled: vpnBlockOn(env),
            verdict,
            via: hit.detected ? hit.via : null,
            hint,
            rules: {
              staticAsns: PROXY_ASNS.size,
              kvAsns: [...extra.asns],
              kvKeywords: extra.keywords,
              kvAllowAsns: [...extra.allow],
            },
          });
        }

        // 管理员：查看 / 追加 VPN 规则（不用重新部署就能加线路）
        if (path === '/api/admin/vpn-rules' && (method === 'GET' || method === 'POST')) {
          const guard = await requireAdmin(env, request);
          if (guard.error) return guard.error;
          const cur = (await env.USERS.get('vpn:rules', 'json')) || { asns: [], keywords: [] };
          if (method === 'GET') {
            const seen = (await env.USERS.get('vpn:seen', 'json')) || {};
            const seenList = Object.values(seen)
              .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
              .slice(0, 50);
            // 地址栏直接加规则：?addAsn=14061&keyword=xxx&allowAsn=4134
            const q = url.searchParams;
            const hasParam = ['addAsn', 'keyword', 'allowAsn', 'removeAsn'].some((k) => q.has(k));
            if (hasParam) {
              const asns0 = new Set((cur.asns || []).map(Number).filter((n) => n > 0));
              const kws0 = new Set((cur.keywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean));
              const allow0 = new Set((cur.allowAsns || []).map(Number).filter((n) => n > 0));
              if (q.has('addAsn')) {
                const n = Number(q.get('addAsn'));
                if (!Number.isFinite(n) || n <= 0) return json({ ok: false, message: 'addAsn 不合法' }, 400);
                asns0.add(n);
              }
              if (q.has('removeAsn')) asns0.delete(Number(q.get('removeAsn')));
              if (q.has('allowAsn')) {
                const n = Number(q.get('allowAsn'));
                if (!Number.isFinite(n) || n <= 0) return json({ ok: false, message: 'allowAsn 不合法' }, 400);
                allow0.add(n);
              }
              if (q.has('keyword')) {
                const t = String(q.get('keyword')).trim().toLowerCase();
                if (t.length < 3) return json({ ok: false, message: 'keyword 至少 3 个字符' }, 400);
                kws0.add(t);
              }
              const saved = { asns: [...asns0], keywords: [...kws0], allowAsns: [...allow0], at: Date.now(), by: guard.session.username };
              await env.USERS.put('vpn:rules', JSON.stringify(saved));
              return json({ ok: true, saved: true, rules: { asns: saved.asns, keywords: saved.keywords, allowAsns: saved.allowAsns }, seen: seenList });
            }
            return json({ ok: true, rules: { asns: cur.asns || [], keywords: cur.keywords || [], allowAsns: cur.allowAsns || [] }, seen: seenList });
          }
          const body = await readJson(request);
          const asns = new Set((cur.asns || []).map(Number).filter((n) => n > 0));
          const kws = new Set((cur.keywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean));
          const allow = new Set((cur.allowAsns || []).map(Number).filter((n) => n > 0));
          if (body.asn !== undefined) {
            const n = Number(body.asn);
            if (!Number.isFinite(n) || n <= 0 || n > 4294967295) {
              return json({ ok: false, message: 'asn 不合法' }, 400);
            }
            asns.add(n);
          }
          if (body.keyword !== undefined) {
            const t = String(body.keyword).trim().toLowerCase();
            if (t.length < 3 || t.length > 40) return json({ ok: false, message: 'keyword 需 3-40 字符' }, 400);
            kws.add(t);
          }
          if (body.allowAsn !== undefined) {
            const n = Number(body.allowAsn);
            if (!Number.isFinite(n) || n <= 0) return json({ ok: false, message: 'allowAsn 不合法' }, 400);
            allow.add(n);
          }
          if (body.removeAllowAsn !== undefined) allow.delete(Number(body.removeAllowAsn));
          if (body.removeAsn !== undefined) asns.delete(Number(body.removeAsn));
          if (body.removeKeyword !== undefined) kws.delete(String(body.removeKeyword).trim().toLowerCase());
          const next = { asns: [...asns], keywords: [...kws], allowAsns: [...allow], at: Date.now(), by: guard.session.username };
          await env.USERS.put('vpn:rules', JSON.stringify(next));
          return json({ ok: true, rules: { asns: next.asns, keywords: next.keywords, allowAsns: next.allowAsns } });
        }

        // 账户偏好：读写当前登录用户的主题偏好
        if (path === '/api/pref' && method === 'GET') {
          const s = await getSession(env, request);
          if (!s) return json({ ok: false, error: '未登录' }, 401);
          const p = await getPref(env, s.username);
          return json({
            ok: true,
            pref: p && (p.theme === 'light' || p.theme === 'dark')
              ? { theme: p.theme, at: p.at || null }
              : null,
          });
        }
        if (path === '/api/pref' && method === 'POST') {
          const s = await getSession(env, request);
          if (!s) return json({ ok: false, error: '未登录' }, 401);
          let body = {};
          try { body = await request.json(); } catch (e) { body = {}; }
          const theme = String((body && body.theme) || '');
          if (theme !== 'light' && theme !== 'dark') {
            return json({ ok: false, error: 'theme 只能是 light 或 dark' }, 400);
          }
          const cur = await getPref(env, s.username);
          // 和已存的一样就不写 KV：省写入次数，也避免无意义的更新时间
          const p = cur && cur.theme === theme ? cur : await putPref(env, s.username, { theme });
          return json({ ok: true, pref: { theme: p.theme, at: p.at || Date.now() } });
        }
        if (path === '/api/downloads' && method === 'GET') {
          return await handleDownloads(env, request);
        }
        // 站内文件直接下载（仍需登录）
        if (path === '/api/novel/download' && method === 'GET') {
          return await handleNovelDownload(env, request);
        }
        if (path === '/api/admin/novel' && method === 'POST') {
          return await handleAdminUploadNovel(env, request);
        }

        // 自助注销：第一步验密码并发邮件，第二步凭确认码真正删除
        if (path === '/api/account/delete/request' && method === 'POST') {
          return await handleDeleteRequest(env, request);
        }
        if (path === '/api/account/delete/confirm' && method === 'POST') {
          return await handleDeleteConfirm(env, request);
        }

        // 修改用户名 / 密码：同样是「先发邮件确认码，再二次确认」
        if (path === '/api/account/change/request' && method === 'POST') {
          return await handleChangeRequest(env, request);
        }
        if (path === '/api/account/change/confirm' && method === 'POST') {
          return await handleChangeConfirm(env, request);
        }

        // 邮箱：添加（激活账户）/ 更改（先验旧邮箱，再验新邮箱）
        if (path === '/api/account/email/request' && method === 'POST') {
          return await handleEmailRequest(env, request);
        }
        if (path === '/api/account/email/confirm' && method === 'POST') {
          return await handleEmailConfirm(env, request);
        }

        // 管理员控制台
        if (path === '/api/admin/users' && method === 'GET') {
          return await handleAdminUsers(env, request);
        }
        if (path === '/api/admin/activate' && method === 'POST') {
          return await handleAdminActivate(env, request);
        }
        if (path === '/api/admin/extend' && method === 'POST') {
          return await handleAdminExtend(env, request);
        }
        if (path === '/api/admin/notices/read' && method === 'POST') {
          return await handleAdminNoticesRead(env, request);
        }
        // 工单：管理员查看 / 标记已读 / 删除
        if (path === '/api/admin/tickets' && method === 'GET') {
          return await handleAdminTickets(env, request);
        }
        if (path === '/api/admin/tickets/read' && method === 'POST') {
          return await handleAdminTicketsRead(env, request);
        }
        if (path === '/api/admin/tickets/delete' && method === 'POST') {
          return await handleAdminTicketsDelete(env, request);
        }
        if (path === '/api/admin/tickets/reply' && method === 'POST') {
          return await handleAdminTicketReply(env, request);
        }

        // 通知板块：公开公告 + 我的通知/我的工单 + 用户回复工单
        if (path === '/api/notices' && method === 'GET') {
          return await handleNotices(env, request);
        }
        if (path === '/api/my/notifications' && method === 'GET') {
          return await handleMyNotifications(env, request);
        }
        if (path === '/api/ticket/reply' && method === 'POST') {
          return await handleTicketReply(env, request);
        }
        if (path === '/api/admin/notices' && method === 'POST') {
          return await handleAdminNoticePost(env, request);
        }
        if (path === '/api/admin/notices/delete' && method === 'POST') {
          return await handleAdminNoticeDelete(env, request);
        }
        if (path === '/api/admin/maintenance' && method === 'POST') {
          return await handleAdminMaintenance(env, request);
        }
        if (path === '/api/admin/ban' && method === 'POST') {
          return await handleAdminBan(env, request);
        }
        if (path === '/api/admin/role' && method === 'POST') {
          return await handleAdminRole(env, request);
        }
        // 账户警告：管理员手填内容发给某个账户；被警告的人确认「我知道了」后不再弹
        if (path === '/api/admin/warn' && method === 'POST') {
          return await handleAdminWarn(env, request);
        }
        if (path === '/api/warnings/seen' && method === 'POST') {
          return await handleWarningsSeen(env, request);
        }

        return json({ ok: false, message: '接口不存在' }, 404);
      } catch (e) {
        return json({ ok: false, message: '服务器内部错误', detail: String(e).slice(0, 200) }, 500);
      }
    }

    // 非 API：先处理语种与地区跳转，再原样交给静态资源
    if (method === 'GET' || method === 'HEAD') {
      if (isPagePath(path)) {
        const switched = handleLangSwitch(request, url);
        if (switched) return switched;
        const geo = handleGeoRedirect(request, url);
        if (geo) return geo;
      }
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not Found', { status: 404 });
}

export default {
  async fetch(request, env) {
    const res = await handleRequest(request, env);
    return await localizeResponse(res, request);
  },
};
