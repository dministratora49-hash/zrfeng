# zrfeng.top 🍃

> 一个 13 岁学生用一台手机完成的个人网站。

**在线访问：[www.zrfeng.top](https://www.zrfeng.top)**

## ✨ 这是什么

我的个人站点，包含：

| 页面 | 地址 | 说明 |
|------|------|------|
| 🏠 主站 | [www.zrfeng.top](https://www.zrfeng.top) | 门户与公告 |
| 🧭 导航 | [www.zrfeng.top/guide/](https://www.zrfeng.top/guide/) | 上网起点 |
| ⏰ 原子钟 | [www.zrfeng.top/time/](https://www.zrfeng.top/time/) | NTP同步·毫秒级·自动校准 |
| 👤 关于 | [www.zrfeng.top/aboutme/](https://www.zrfeng.top/aboutme/) | 开发者信息 |
| ☕ 赞助 | [www.zrfeng.top/sponsorship/](https://www.zrfeng.top/sponsorship/) | 支持我 |
| ✉️ 联系 | [www.zrfeng.top/contact/](https://www.zrfeng.top/contact/) | 联系邮箱 |
| 📚 资源库 | [www.zrfeng.top/file/](https://www.zrfeng.top/file/) | 资源聚合与分类 |
| 📖 小说 | [www.zrfeng.top/file/novel/](https://www.zrfeng.top/file/novel/) | 在线阅读 |
| 💗 言情小说 | [www.zrfeng.top/file/novel/romancenovel/](https://www.zrfeng.top/file/novel/romancenovel/) | 《听潮》·登录后可下载 |
| 🔐 登录 / 注册 | [www.zrfeng.top/login/](https://www.zrfeng.top/login/) | 邮箱验证码注册 |
| 🖥️ 控制台 | [www.zrfeng.top/console/](https://www.zrfeng.top/console/) | 账户状态与激活管理 |

## 📊 账户状态栏

每个页面顶部都有一条状态栏，颜色和文案由服务端 `/api/status` 计算后下发
（前端不自行判断，改本地时间绕不过试用期）：

| 圆点 | 身份 | 状态栏文案 | 右上角 |
|------|------|-----------|--------|
| 🔴 红 | 未登录 | 登录以享受服务（点击去登录） | — |
| 🟡 黄 | 试用账户 `42` | 未激活，试用期仅剩 **X天 HH:MM:SS**（逐秒递减） | 控制台 / 登出 |
| 🟡 黄 | 试用到期 | 未激活，试用期已到 + **You are blocked** 弹窗 | 登出 |
| 🟡 黄 | 管理员 `admin` | 未激活，试用期仅剩 **-1** 天（永不到期） | 控制台 / 登出 |
| 🟢 绿 | 已完成邮箱验证 | 账户正常 | **控制台** / 登出 |

- **试用账户**：用户名 `42`，密码 `424242`，自动创建，试用期 7 天；
- **倒计时精确到秒**：服务端下发剩余毫秒，前端换算成本地截止时刻逐秒递减
  （用「剩余量」而非绝对时间戳，客户端时钟不准也不会算错）；归零即弹窗拦截；
- **激活**＝完成电子邮件验证，激活后圆点变绿、下载不再受限；
- 试用到期后**无法下载**（服务端返回 403），须由管理员在控制台激活或续期；
- 管理员可在 `/console/` 查看全部账户、激活 / 取消激活、续 7 天。

## 🗑️ 注销账户

在 `/console/` 里，普通用户可以注销自己的账户，需**两步确认**：

1. **第一步**：输入当前密码 → 系统向绑定邮箱发送 **6 位确认码**（10 分钟有效）；
2. **第二步**：输入确认码 → 账户才真正删除。

规则与保护：

- 注销后该邮箱进入**永久不可再注册**名单（注册与发验证码都会被拦下）；
- 账户记录、邮箱索引与所有登录会话一并清除；
- **管理员**与**试用账户**不可注销（`42` 是公开的共享演示号，避免被任意注销）；
- 确认码连错 5 次即失效，同一账户 60 秒内只能发一次；
- 每次注销都会给管理员留一条通知：控制台显示「**最近注销 N 人**」，
  点右侧「**已读**」后该消息消失；之后再有人注销会重新出现。

## 🔧 维护时间

管理员在 `/console/` 的「维护时间」面板里选一个**时间段**（开始 → 结束）：

- **开始时间一到**：所有页面自动弹出「**正在维护服务**」弹窗；
- **结束时间一到**：弹窗自动关闭。

细节：

- 弹窗里显示维护时段和「预计剩余 X天 HH:MM:SS」的秒级倒计时；
- 面板还有「立即开始 · 30 分钟 / 1 小时 / 2 小时」快捷按钮，手机上一点就好；
- 时间到点由前端自动切换，最迟 60 秒内所有已打开的页面都会跟上；
- **管理员不受弹窗阻挡**（弹窗上多了「进入控制台」和「管理员关闭」），
  否则维护一开始管理员会被自己的弹窗锁在外面；
- 维护时段最长 30 天，且必须「结束晚于开始」；
- 只弹提示，不拦截接口 —— 如果你想让维护期间连下载也停掉，说一声即可。

## 🔐 登录与下载

下载链接**不存放在网页源码里**，而是保存在 Cloudflare 的服务端密钥中，
由 Worker 在确认登录后下发。因此：

- 未登录时源码里看不到任何网盘地址，只能跳转登录页；
- 登录 / 注册成功后跳转**主站首页**（不是小说页）；
- 注册需要邮箱验证码，仅支持 `.com` `.cn` `.net` `.top` 结尾的邮箱；
- 发送验证码前需通过人机验证（算术题，配了 Turnstile 则用 Turnstile）；
- 密码以 PBKDF2-SHA256 加盐哈希存储，会话用 HttpOnly Cookie。

## 🛠️ 技术栈

- 纯 HTML / CSS / JavaScript（无框架，手写）
- [Cloudflare Workers](https://workers.cloudflare.com/)：静态资产托管 + 后端接口
- Cloudflare KV：存放用户、会话与验证码
- [Resend](https://resend.com/) 发送邮箱验证码
- Cloudflare DNS + 全球 CDN
- 腾讯企业邮箱

## 📱 特别之处

整个网站——从写代码、配置 DNS 到部署上线——
**全部在一台 鸿蒙Harmony 手机上完成**，没有使用电脑。

## 🚀 本地运行

纯静态页面，无需构建：

```bash
# 直接打开 index.html
# 或者起个本地服务器：
python -m http.server 8000
```

## 📁 目录结构

```
├── index.html        # 主站
├── aboutme/          # 关于开发者
├── guide/            # 导航页
├── time/             # NTP 原子钟
├── sponsorship/      # 赞助页
│   ├── alipay/       # 支付宝（维护中）
│   └── wechatpay/    # 微信支付（维护中）
├── contact/          # 联系我们
├── login/            # 登录 / 注册
├── console/          # 控制台（账户激活管理）
├── file/             # 资源库
│   └── novel/        # 小说
│       └── romancenovel/  # 言情小说《听潮》
├── status.js         # 全站账户状态栏
├── worker.js         # 后端：注册/登录/验证码/下载门控/账户状态
└── wrangler.toml     # Cloudflare 部署配置
```

## ⭐ 支持我

如果这个项目对你有启发：

[![Star](https://img.shields.io/badge/-给个Star-ffd700?style=for-the-badge&logo=github)](https://github.com/dministratora49-hash/zrfeng/stargazers)

或者访问 zrfeng.top 点个赞也是支持 🍃

---

*© 2026 zrfeng · 用心手写，不用电脑*
