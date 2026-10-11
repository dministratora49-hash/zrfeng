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
| 📚 资源库 | [www.zrfeng.top/file/](https://www.zrfeng.top/file/) | 资源聚合与分类 |
| 📖 小说 | [www.zrfeng.top/file/novel/](https://www.zrfeng.top/file/novel/) | 在线阅读 |

## 🛠️ 技术栈

- 纯 HTML / CSS / JavaScript（无框架，手写）
- [Cloudflare Workers](https://workers.cloudflare.com/) 静态资产托管
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
├── file/             # 资源库
│   └── novel/        # 小说
└── wrangler.toml     # Cloudflare 部署配置
```

## ⭐ 支持我

如果这个项目对你有启发：

[![Star](https://img.shields.io/badge/-给个Star-ffd700?style=for-the-badge&logo=github)](https://github.com/dministratora49-hash/zrfeng/stargazers)

或者访问 zrfeng.top 点个赞也是支持 🍃

---

*© 2026 zrfeng · 用心手写，不用电脑*
