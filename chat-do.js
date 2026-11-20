/* ============================================================================
 * 聊天室 Durable Object
 * ----------------------------------------------------------------------------
 * 界面与交互移植自 Syntrx888/ChatterBox（Vue3 + Socket.IO + SQLite），
 * 但后端不能照搬：Cloudflare Workers 没有 Node 运行时，Socket.IO 的协议跑不了，
 * 所以这里改用 Workers 原生 WebSocket + Durable Object。
 *
 * Durable Object 为什么合适：它是「单线程强一致」的，正好当聊天室的唯一真相源 ——
 * 消息广播、在线人数、撤回消息都在同一个实例里算，不会出现两个连接同时读到
 * 不同状态的问题。
 *
 * 消息本体存在 KV（env.USERS），DO 只负责「谁在线」「怎么广播」：
 *   · 新连接进来 → 从 KV 拉历史消息给他
 *   · 有人发消息 → 写 KV，再广播给所有连接
 *   · 管理员撤回 → 删 KV，再广播删除事件
 *
 * 鉴权：连接建立时由 Worker 校验 session，通过后把用户名塞进 query，
 *       DO 只认 Worker 传来的连接 —— 客户端自己声明的身份一律不信。
 * ============================================================================ */

/** 单条消息最大字数 */
const TEXT_MAX = 500;
/** 昵称最大字数 */
const NAME_MAX = 24;
/** 同一账户两次发言的最小间隔（毫秒） */
const COOLDOWN_MS = 1500;
/** 同一 IP 每分钟最多发多少条 */
const IP_PER_MIN = 20;
/** 内存里保留的历史消息条数 */
const HISTORY_MAX = 100;

/** 从 KV 读历史消息（倒序存的，取回来要反一下） */
async function listHistory(env) {
  const all = await env.USERS.list({ prefix: 'chat:', limit: 300 });
  const out = [];
  for (const k of all.keys) {
    const rec = await env.USERS.get(k.name, 'json');
    if (rec && rec.text) {
      out.push({
        id: k.name.slice('chat:'.length),
        at: Number(rec.at) || 0,
        name: String(rec.name || ''),
        text: String(rec.text || ''),
        admin: !!rec.admin,
        account: rec.account || '',
      });
    }
  }
  out.sort((a, b) => (a.at > b.at ? 1 : a.at < b.at ? -1 : 0));
  return out.slice(-HISTORY_MAX);
}

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** @type {Map<WebSocket, {name:string, account:string, admin:boolean}>} */
    this.sockets = new Map();
    /** 每个账户上次发言时间 */
    this.lastPost = new Map();
  }

  /** WebSocket 升级请求：Worker 已经验过 session，这里直接接管 */
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const url = new URL(request.url);
    // 身份由 Worker 校验后写进 query，客户端自己声明的一律不信
    const name = String(url.searchParams.get('name') || '').slice(0, NAME_MAX);
    const account = String(url.searchParams.get('account') || '').slice(0, 64);
    const isAdmin = url.searchParams.get('admin') === '1';

    if (!name) {
      return new Response('Unauthorized', { status: 401 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server);
    this.sockets.set(server, { name, account, admin: isAdmin });

    // 新人进来：先把历史消息发给他，再广播「有人上线」
    try {
      const history = await listHistory(this.env);
      server.send(JSON.stringify({ type: 'history', messages: history }));
    } catch {
      server.send(JSON.stringify({ type: 'history', messages: [] }));
    }
    this.broadcastOnline();

    return new Response(null, { status: 101, webSocket: client });
  }

  /** 发给所有连接 */
  broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const ws of this.sockets.keys()) {
      try {
        ws.send(data);
      } catch {
        /* 连接已经没了，清理时会移除 */
      }
    }
  }

  /** 当前在线的人（同名只算一个） */
  memberNames() {
    const names = [];
    for (const info of this.sockets.values()) {
      if (info.name && names.indexOf(info.name) === -1) names.push(info.name);
    }
    return names;
  }

  /** 广播在线状态：人数 + 名单（Chatterbox 的成员列表就是这么来的） */
  broadcastOnline() {
    this.broadcast({
      type: 'online',
      online: this.sockets.size,
      members: this.memberNames(),
    });
  }

  /** 有人发消息（Worker 校验完身份后调 DO 的内部接口） */
  async post(payload) {
    const text = String(payload.text || '').trim();
    if (!text) return { ok: false, message: '消息不能为空' };
    if (Array.from(text).length > TEXT_MAX) {
      return { ok: false, message: '消息太长了，最多 ' + TEXT_MAX + ' 个字' };
    }

    const account = String(payload.account || '');
    const who = account ? 'u:' + account.toLowerCase() : 'd:' + String(payload.device || 'anon');

    // 同一人 1.5 秒一条
    const now = Date.now();
    const last = this.lastPost.get(who) || 0;
    if (now - last < COOLDOWN_MS) {
      return { ok: false, message: '发得太快了，缓一缓再发' };
    }

    // 同一个 IP 每分钟 20 条
    const ip = String(payload.ip || '');
    if (ip) {
      const ipKey = 'chatip:' + ip + ':' + Math.floor(now / 60000);
      try {
        const n = Number(await this.env.USERS.get(ipKey)) || 0;
        if (n >= IP_PER_MIN) {
          return { ok: false, message: '发送过于频繁，请稍后再试' };
        }
        await this.env.USERS.put(ipKey, String(n + 1), { expirationTtl: 120 });
      } catch {
        /* 读不到就不拦 */
      }
    }

    // 时间戳严格递增：同一毫秒连发两条也能保证顺序稳定
    const all = await listHistory(this.env);
    const lastAt = all.reduce((mx, m) => Math.max(mx, Number(m.at) || 0), 0);
    const at = Math.max(now, lastAt + 1);
    const id = String(at).padStart(15, '0') + '-' + Math.random().toString(16).slice(2, 8);

    const rec = { at, name: String(payload.name || ''), text, who };
    if (account) rec.account = account;
    if (payload.admin) rec.admin = true;

    try {
      await this.env.USERS.put('chat:' + id, JSON.stringify(rec));
    } catch {
      return { ok: false, message: '消息没能保存，请稍后再试' };
    }

    this.lastPost.set(who, now);

    // 只留最近 300 条
    const keep = [id].concat(all.map((m) => m.id));
    for (const old of keep.slice(300)) {
      try {
        await this.env.USERS.delete('chat:' + old);
      } catch {
        /* 忽略 */
      }
    }

    this.broadcast({
      type: 'message',
      message: {
        id,
        at,
        name: rec.name,
        text,
        admin: !!rec.admin,
        account: rec.account || '',
      },
    });

    return { ok: true, id, at };
  }

  /** 管理员撤回某条消息 */
  async revoke(payload) {
    const id = String(payload.id || '');
    if (!id) return { ok: false, message: '参数不正确' };
    try {
      await this.env.USERS.delete('chat:' + id);
    } catch {
      /* 忽略 */
    }
    this.broadcast({ type: 'deleted', id });
    return { ok: true };
  }

  /** 管理员清空整个聊天室 */
  async clear() {
    const all = await listHistory(this.env);
    let n = 0;
    for (const m of all) {
      try {
        await this.env.USERS.delete('chat:' + m.id);
        n++;
      } catch {
        /* 忽略 */
      }
    }
    this.broadcast({ type: 'cleared' });
    return { ok: true, message: '已清空 ' + n + ' 条消息', deleted: n };
  }

  /** 当前在线人数 */
  async stats() {
    return { ok: true, online: this.sockets.size };
  }

  /** WebSocket 生命周期回调 */
  webSocketMessage(ws, message) {
    // 客户端发来的消息一律当作「请求发送」，但真正写库前必须由 Worker 鉴权，
    // 所以这里不直接落库 —— Worker 会调 post()。
    let data = null;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (!data || data.type !== 'ping') {
      // 非 ping 的都忽略：发送走 HTTP 接口（带 session Cookie），便于做限流与鉴权
    }
  }

  webSocketClose(ws) {
    this.sockets.delete(ws);
    this.broadcastOnline();
  }

  webSocketError(ws) {
    this.sockets.delete(ws);
  }
}
