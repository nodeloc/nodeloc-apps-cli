# nodeloc-apps

在本地开发社区 app，然后提交到论坛审核发布。

app 是一个导出若干 handler 的 JS 模块，handler 跑在论坛服务端的沙箱里。这个 CLI 负责本地那一半：登录、打包、在只有你能看见的私有安装上试跑、提交审核、看日志。

配套的论坛插件：[nodeloc/discourse-apps](https://github.com/nodeloc/discourse-apps) —— 完整的作者指南（`ctx` 字段、组件表、权限对照、排错）在它的 [docs/authoring.md](https://github.com/nodeloc/discourse-apps/blob/main/docs/authoring.md)。

## 安装

需要 **Node.js 22 或更高**。

```bash
git clone https://github.com/nodeloc/nodeloc-apps-cli.git
cd nodeloc-apps-cli
npm install -g .
```

## 登录

```bash
nodeloc-apps login --site https://你的论坛
```

终端打印一个校验码和一个链接。在浏览器里打开，**核对页面上的码和终端里的一致**（不一致就直接关掉，说明这个批准请求不是你发起的），点「批准」，终端自己就拿到了凭据。

凭据存在 `~/.config/nodeloc-apps/credentials.json`，仅本人可读。这把 key 只能发布你自己的 app，站上别的事一件都干不了。再次 `login` 会让上一把立即失效。

在 CI 或没有浏览器的机器上，改用环境变量（在论坛作者页点「生成 key」拿到），它们优先于存下来的凭据：

```bash
export NODELOC_APPS_SITE=https://你的论坛
export NODELOC_APPS_API_KEY=...
export NODELOC_APPS_API_USERNAME=你的用户名
```

## 用法

```bash
nodeloc-apps init my-game --template counter   # counter | race
cd my-game

nodeloc-apps dev        # 打包 + 静态检查，不上传
nodeloc-apps playtest   # 推到只有你能看见的私有安装，改文件自动重推
nodeloc-apps upload --note "加了排行榜"
nodeloc-apps logs --limit 50
```

| 命令 | 作用 |
|---|---|
| `login --site <url>` | 通过浏览器登录 |
| `whoami` | 当前身份 |
| `logout` | 忘掉本机凭据 |
| `init <slug> [--template counter\|race]` | 在 `./<slug>` 建项目 |
| `dev` | 打包并检查，不上传 |
| `playtest` | 推到私有安装，监听改动自动重推 |
| `upload [--note "..."]` | 提交审核 |
| `logs [--limit N]` | 看每次调用的 handler、结果、耗时、错误码 |

`dev` 会把相对 import 内联成单个模块，并提前拦掉服务端一定会拒的写法：缺 `render` 导出、`eval`、`node:` 内建、浏览器全局、`fetch`（沙箱没有网络）。

## 项目结构

```
my-game/
  app.json        # 平台读的那几个字段
  src/main.js     # 入口
```

```jsonc
{
  "slug": "my-game",
  "name": "My game",
  "entry": "src/main.js",
  "scopes": ["kv"],
  "surface": "blocks",     // blocks | webview
  "placement": "single",   // single | many
  "triggers": []
}
```

`placement` 值得想清楚：`single` 表示全站只应存在一处（有共享排行榜的都属于此类，因为每个安装的共享区是独立的，放两处等于把榜劈成两半）；`many` 适合投票、倒计时、骰子这类每处一份才合理的东西。

## 开发本 CLI

```bash
npm test
```

## License

MIT
