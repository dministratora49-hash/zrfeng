/**
 * zrfeng.top 后端（Cloudflare Worker）
 * ---------------------------------------------------------------------------
 * 提供：注册、登录、邮箱验证码、人机验证、下载门控。
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

/**
 * 管理员与试用账户的账户名 / 密码全部来自 Cloudflare 密钥，
 * 不写死在代码里 —— 否则会随公开仓库一起泄露。
 */
const adminUsername = (env) => String(env.ADMIN_USERNAME || '').trim().toLowerCase();
const adminEmail = (env) => String(env.ADMIN_EMAIL || '').trim().toLowerCase();
const trialUsername = (env) => String(env.TRIAL_ACCOUNT || '').trim().toLowerCase();

/**
 * 主管理员的二次身份验证。
 * 问题与答案都从 Cloudflare 密钥读取 —— 答案绝不写进代码，
 * 因为 worker.js 是公开仓库的一部分。
 */
const adminVerifyAnswer = (env) => String(env.ADMIN_VERIFY_ANSWER || '').trim();
const adminVerifyQuestion = (env) =>
  String(env.ADMIN_VERIFY_QUESTION || '').trim() || '请回答管理员验证问题';

/** 这个会话是否需要（且尚未通过）管理员二次验证 */
function needAdminVerify(env, user, session) {
  if (!user || roleOf(user) !== 'super') return false;
  if (!adminVerifyAnswer(env)) return false; // 没配答案就不启用
  return !(session && session.adminVerified === true);
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

/**
 * 计算账户状态。前端状态栏完全依赖这个结果。
 *
 *   guest   —— 未登录           红点「登录以享受服务」
 *   admin   —— 管理员           黄点「未激活，试用期仅剩-1天」（永不到期）
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

  // 管理员（主 / 副）：显示为 -1 天，含义是永不到期
  if (user.isAdmin) {
    return {
      state: 'admin',
      dot: 'yellow',
      label: '未激活，试用期仅剩-1天',
      activated: false,
      days: -1,
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
      // 文案保持简洁；具体封禁时段由前端按**本地时间**显示（见 status.js）
      label: 'You are banned（账户已被封禁）',
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
        // 主管理员需要额外回答问题（若密钥里配了答案）；这里先记成「未通过」
        adminVerified: !needAdminVerify(env, user, null),
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
  await putUser(env, user);
  await env.USERS.delete('code:' + email);

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

  // 新设备登录验证：账号有邮箱、且这台设备从没在该账户上成功登录过 → 先发邮件验证码
  const deviceId = deviceIdOf(request) || randomHex(16);
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
  // 主管理员二次验证：配了答案就必须先答对，否则所有管理接口一律拒绝
  if (needAdminVerify(env, user, session)) {
    return {
      error: json(
        {
          ok: false,
          needAdminVerify: true,
          message: '请先完成管理员身份验证',
          question: adminVerifyQuestion(env),
        },
        403
      ),
    };
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
  const users = [];
  for (const k of list.keys) {
    const u = await env.USERS.get(k.name, 'json');
    if (!u) continue;
    const st = accountStatus(u);
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
    maintenance: maintenanceState(await getMaintenance(env), Date.now()),
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
const MAINT_KEY = 'config:maintenance';

/** 维护时段最长允许 30 天，防止误填出一个「永久维护」 */
const MAINT_MAX_MS = 30 * 86400000;

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
  return { start: m.start, end: m.end, setBy: m.setBy || null, setAt: m.setAt || null };
}

/**
 * 把维护时段换算成「此刻是否在维护中」。
 *   active     —— 现在正处于 [start, end) 之内：所有页面弹窗
 *   startsInMs —— 还没开始，距离开始还有多久
 *   remainingMs—— 维护中，距离结束还有多久（到点自动关弹窗）
 */
function maintenanceState(m, now) {
  if (!m) {
    return { set: false, active: false, start: null, end: null, remainingMs: null, startsInMs: null, ended: false };
  }
  const active = now >= m.start && now < m.end;
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
    await env.USERS.delete(MAINT_KEY);
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

  const m = { start, end, setBy: guard.session.username, setAt: now };
  await env.USERS.put(MAINT_KEY, JSON.stringify(m));

  const st = maintenanceState(m, now);
  const human = st.active ? '维护已开始' : '维护将于稍后自动开始';
  return json({ ok: true, message: '维护时间已设置（' + human + '）', maintenance: st });
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

/**
 * 管理员二次身份验证：回答密钥里配置的问题。
 * 通过后把当前会话标记为已通过，之后管理接口才放行。
 */
async function handleAdminVerify(env, request) {
  const session = await getSession(env, request);
  if (!session) return json({ ok: false, message: '请先登录', needLogin: true }, 401);

  const user = await sessionUser(env, session);
  if (!user || roleOf(user) !== 'super') {
    return json({ ok: false, message: '只有主管理员需要此验证' }, 403);
  }

  const expected = adminVerifyAnswer(env);
  if (!expected) return json({ ok: true, message: '未配置验证问题，无需验证' });

  const body = await readJson(request);
  const answer = String(body.answer || '').trim();
  if (!answer) return json({ ok: false, message: '请输入答案' }, 400);
  if (!timingSafeEqual(answer, expected)) {
    return json({ ok: false, message: '答案不正确' }, 401);
  }

  session.adminVerified = true;
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)session=([a-f0-9]{64})/);
  if (m) {
    await env.USERS.put('session:' + m[1], JSON.stringify(session), { expirationTtl: SESSION_TTL });
  }
  return json({ ok: true, message: '验证通过' });
}

/* ========================== 新设备登录验证 ========================== */

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

  const code = String(body.code || '').trim();
  if (!/^\d{6}$/.test(code)) return json({ ok: false, message: '请输入 6 位验证码' }, 400);

  if (rec.tries >= 5) {
    await env.USERS.delete(key);
    return json({ ok: false, message: '尝试次数过多，请重新登录' }, 400);
  }
  if (!timingSafeEqual(code, String(rec.code || ''))) {
    rec.tries = (rec.tries || 0) + 1;
    await env.USERS.put(key, JSON.stringify(rec), { expirationTtl: DEVLOGIN_TTL });
    return json({ ok: false, message: '验证码不正确' }, 401);
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

/* ========================== 主入口 ========================== */

export default {
  async fetch(request, env) {
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
              // 主管理员是否需要先回答二次验证问题（问题文案来自密钥，前端只负责显示）
              needAdminVerify: needAdminVerify(env, u, s),
              adminVerifyQuestion: needAdminVerify(env, u, s) ? adminVerifyQuestion(env) : null,
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
            // 维护时段：所有页面据此决定是否弹出「正在维护服务」
            maintenance: maintenanceState(await getMaintenance(env), Date.now()),
          }, 200, devTouched ? { 'Set-Cookie': deviceCookie(randomHex(16)) } : undefined);
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
        // 管理员二次身份验证
        if (path === '/api/admin/verify' && method === 'POST') {
          return await handleAdminVerify(env, request);
        }
        if (path === '/api/admin/notices/read' && method === 'POST') {
          return await handleAdminNoticesRead(env, request);
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

        return json({ ok: false, message: '接口不存在' }, 404);
      } catch (e) {
        return json({ ok: false, message: '服务器内部错误', detail: String(e).slice(0, 200) }, 500);
      }
    }

    // 非 API：交给静态资源
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not Found', { status: 404 });
  },
};
