/**
 * zrfeng.top 后端（Cloudflare Worker）
 * ---------------------------------------------------------------------------
 * 提供：注册、登录、邮箱验证码、人机验证、下载门控。
 *
 * ⚠️ 重要安全约定
 * 本文件会提交到**公开仓库**，任何人可见。因此：
 *   - 下载链接存放在环境变量（密钥）DOWNLOAD_LINKS 里，绝不写进本文件；
 *   - 管理员密码存放在密钥 ADMIN_PASSWORD；
 *   - 邮件 API Key、会话签名密钥同理，全部走密钥。
 * 本文件里出现的任何明文密码/链接都等于公开。
 *
 * 需要的绑定与密钥（在 Cloudflare 控制台或 wrangler 里配置）：
 *   KV 命名空间绑定  USERS
 *   密钥 DOWNLOAD_LINKS     JSON 数组，形如 [{"name":"小飞机网盘","url":"...","pwd":""}]
 *   密钥 ADMIN_PASSWORD     管理员密码（不设则用 admin@123）
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

/** 注销确认码有效期（秒）：10 分钟 */
const DELCODE_TTL = 10 * 60;

/** 人机验证票据有效期（秒） */
const CAPTCHA_TTL = 5 * 60;

/** PBKDF2 迭代次数。Workers 免费版 CPU 有限，不宜过高 */
const PBKDF2_ITERATIONS = 15000;

/** 保留用户名，不允许注册 */
const RESERVED = new Set(['admin', 'administrator', 'root', 'system', 'zrfeng', '42']);

/** 试用账户天数（未激活账户的倒计时） */
const TRIAL_DAYS = 7;

/** 试用账户的用户名与密码 */
const TRIAL_ACCOUNT = '42';
const TRIAL_PASSWORD = '424242';

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
 * 计算账户状态。前端状态栏完全依赖这个结果。
 *
 *   guest   —— 未登录           红点「登录以享受服务」
 *   admin   —— 管理员           黄点「未激活，试用期仅剩-1天」（永不到期）
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

  // 管理员：显示为 -1 天，含义是永不到期
  if (user.isAdmin) {
    return { state: 'admin', dot: 'yellow', label: '未激活，试用期仅剩-1天', activated: false, days: -1, remainingMs: null };
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

/** 确保试用账户 42 存在（用户名 42 / 密码 424242） */
async function ensureTrial(env) {
  const existing = await env.USERS.get('user:' + TRIAL_ACCOUNT, 'json');
  if (existing) return existing;

  const salt = randomHex(16);
  const hash = await hashPassword(TRIAL_PASSWORD, salt);
  const now = Date.now();
  const user = {
    username: TRIAL_ACCOUNT,
    email: '',
    salt,
    hash,
    isAdmin: false,
    verified: false,
    isTrial: true,
    trialStart: now,
    createdAt: now,
  };
  await env.USERS.put('user:' + TRIAL_ACCOUNT, JSON.stringify(user));
  return user;
}

/** 确保管理员账户存在（首次访问时创建） */
async function ensureAdmin(env) {
  const existing = await env.USERS.get('user:admin', 'json');
  if (existing) return existing;

  const password = env.ADMIN_PASSWORD || 'admin@123';
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const admin = {
    username: 'admin',
    email: (env.ADMIN_EMAIL || 'admin@zrfeng.top').toLowerCase(),
    salt,
    hash,
    isAdmin: true,
    verified: true,
    createdAt: Date.now(),
  };
  await env.USERS.put('user:admin', JSON.stringify(admin));
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
  if (RESERVED.has(username)) {
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

  // admin 首次登录时自动建号
  if (account === 'admin' || account === 'admin@zrfeng.top') await ensureAdmin(env);
  // 试用账户 42 首次登录时自动建号
  if (account === TRIAL_ACCOUNT) await ensureTrial(env);

  const user = await findByLogin(env, account);
  if (!user) return json({ ok: false, message: '账号或密码错误' }, 401);

  const hash = await hashPassword(password, user.salt);
  if (!timingSafeEqual(hash, user.hash)) {
    return json({ ok: false, message: '账号或密码错误' }, 401);
  }

  const status = accountStatus(user);
  const { cookie } = await createSession(env, user);
  return json(
    {
      ok: true,
      message: '登录成功',
      user: { username: user.username, email: user.email, isAdmin: !!user.isAdmin },
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

/** 踢掉某个账户的全部会话 */
async function deleteUserSessions(env, username) {
  let removed = 0;
  try {
    const list = await env.USERS.list({ prefix: 'session:', limit: 1000 });
    for (const k of list.keys) {
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
 * 链接来自密钥 DOWNLOAD_LINKS，不在公开仓库里。
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

  let links = [];
  if (env.DOWNLOAD_LINKS) {
    try {
      links = JSON.parse(env.DOWNLOAD_LINKS);
    } catch {
      return json({ ok: false, message: '下载配置有误，请联系管理员' }, 500);
    }
  }
  if (!Array.isArray(links)) links = [];

  return json({
    ok: true,
    links,
    user: { username: session.username, isAdmin: !!session.isAdmin },
    account: status,
  });
}

/* ========================== 管理员控制台 ========================== */

/** 要求当前会话是管理员，否则返回 null */
async function requireAdmin(env, request) {
  const session = await getSession(env, request);
  if (!session) return { error: json({ ok: false, message: '请先登录', needLogin: true }, 401) };
  const user = await sessionUser(env, session);
  if (!user || !user.isAdmin) {
    return { error: json({ ok: false, message: '无权访问，仅管理员可用' }, 403) };
  }
  return { session, user };
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
    });
  }
  // 管理员在前，其余按创建时间倒序
  users.sort((a, b) => (b.isAdmin ? 1 : 0) - (a.isAdmin ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0));

  const stats = {
    total: users.length,
    active: users.filter((u) => u.state === 'active').length,
    trial: users.filter((u) => u.state === 'trial').length,
    blocked: users.filter((u) => u.state === 'blocked').length,
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
  if (username === 'admin') {
    return json({ ok: false, message: '管理员账户无需激活' }, 400);
  }

  const user = await getUser(env, username);
  if (!user) return json({ ok: false, message: '账户不存在' }, 404);

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
  if (username === 'admin') return json({ ok: false, message: '管理员账户永不到期' }, 400);

  const user = await getUser(env, username);
  if (!user) return json({ ok: false, message: '账户不存在' }, 404);

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
            DOWNLOAD_LINKS: !!env.DOWNLOAD_LINKS,
            ADMIN_PASSWORD: !!env.ADMIN_PASSWORD,
            RESEND_API_KEY: !!env.RESEND_API_KEY,
            MAIL_FROM: !!env.MAIL_FROM,
            TURNSTILE_SECRET: !!env.TURNSTILE_SECRET,
          },
          downloadLinks: { configured: false, count: 0, valid: false },
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

        // 检查 DOWNLOAD_LINKS 是否是合法 JSON 数组
        if (env.DOWNLOAD_LINKS) {
          try {
            const parsed = JSON.parse(env.DOWNLOAD_LINKS);
            report.downloadLinks.valid = Array.isArray(parsed);
            report.downloadLinks.count = Array.isArray(parsed) ? parsed.length : 0;
            report.downloadLinks.configured = true;
          } catch {
            report.downloadLinks.configured = true;
            report.downloadLinks.valid = false;
          }
        }

        // 整体是否可对外服务
        report.ready = report.kv.working && !!env.SESSION_SECRET && report.downloadLinks.valid;

        const missing = [];
        if (!report.kv.working) missing.push('KV 绑定(USERS)');
        if (!env.SESSION_SECRET) missing.push('SESSION_SECRET');
        if (!report.downloadLinks.valid) missing.push('DOWNLOAD_LINKS');
        report.missing = missing;

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
              username: s.username,
              email: s.email,
              isAdmin: !!s.isAdmin,
              verified: !!(u && u.verified),
              isTrial: !!(u && u.isTrial),
              // 能否自助注销：由服务端判定，前端只用来决定是否显示按钮
              canDelete: !!(u && !u.isAdmin && !u.isTrial && u.email),
            },
            account: accountStatus(u),
          });
        }
        // 状态栏轻量接口：只返回状态，不含任何用户隐私
        if (path === '/api/status' && method === 'GET') {
          const s = await getSession(env, request);
          const u = s ? await sessionUser(env, s) : null;
          return json({
            ok: true,
            loggedIn: !!s,
            username: s ? s.username : null,
            isAdmin: !!(u && u.isAdmin),
            account: accountStatus(u),
            // 维护时段：所有页面据此决定是否弹出「正在维护服务」
            maintenance: maintenanceState(await getMaintenance(env), Date.now()),
          });
        }
        if (path === '/api/downloads' && method === 'GET') {
          return await handleDownloads(env, request);
        }

        // 自助注销：第一步验密码并发邮件，第二步凭确认码真正删除
        if (path === '/api/account/delete/request' && method === 'POST') {
          return await handleDeleteRequest(env, request);
        }
        if (path === '/api/account/delete/confirm' && method === 'POST') {
          return await handleDeleteConfirm(env, request);
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
        if (path === '/api/admin/maintenance' && method === 'POST') {
          return await handleAdminMaintenance(env, request);
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
