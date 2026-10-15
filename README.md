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
| 🟡 黄 | 试用账户 `42` | 未激活，试用期仅剩 N 天（逐日递减） | 控制台 / 登出 |
| 🟡 黄 | 试用到期 | 未激活，试用期已到 + **You are blocked** 弹窗 | 登出 |
| 🟡 黄 | 管理员 `admin` | 未激活，试用期仅剩 **-1** 天（永不到期） | 控制台 / 登出 |
| 🟢 绿 | 已完成邮箱验证 | 账户正常 | **控制台** / 登出 |

- **试用账户**：用户名 `42`，密码 `424242`，自动创建，试用期 7 天；
- **激活**＝完成电子邮件验证，激活后圆点变绿、下载不再受限；
- 试用到期后**无法下载**（服务端返回 403），须由管理员在控制台激活或续期；
- 管理员可在 `/console/` 查看全部账户、激活 / 取消激活、续 7 天。

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
