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

/** 人机验证票据有效期（秒） */
const CAPTCHA_TTL = 5 * 60;

/** PBKDF2 迭代次数。Workers 免费版 CPU 有限，不宜过高 */
const PBKDF2_ITERATIONS = 15000;

/** 保留用户名，不允许注册 */
const RESERVED = new Set(['admin', 'administrator', 'root', 'system', 'zrfeng']);

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

  const user = await findByLogin(env, account);
  if (!user) return json({ ok: false, message: '账号或密码错误' }, 401);

  const hash = await hashPassword(password, user.salt);
  if (!timingSafeEqual(hash, user.hash)) {
    return json({ ok: false, message: '账号或密码错误' }, 401);
  }

  const { cookie } = await createSession(env, user);
  return json(
    {
      ok: true,
      message: '登录成功',
      user: { username: user.username, email: user.email, isAdmin: !!user.isAdmin },
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

/**
 * 下载链接 —— 只有登录用户才能拿到。
 * 链接来自密钥 DOWNLOAD_LINKS，不在公开仓库里。
 */
async function handleDownloads(env, request) {
  const session = await getSession(env, request);
  if (!session) {
    return json({ ok: false, message: '请先登录后再下载', needLogin: true }, 401);
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

  return json({ ok: true, links, user: { username: session.username, isAdmin: !!session.isAdmin } });
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
          return json(
            s
              ? { ok: true, loggedIn: true, user: { username: s.username, email: s.email, isAdmin: !!s.isAdmin } }
              : { ok: true, loggedIn: false }
          );
        }
        if (path === '/api/downloads' && method === 'GET') {
          return await handleDownloads(env, request);
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
