# @kiki/daemon

Kiki 本地执行节点。把你的电脑注册成 Kiki 云端的执行机：云端编排器通过反向隧道把任务派发到本机，由本机的 Claude CLI 实际执行。

## 依赖

- **Node.js >= 20**（这是一段 Node 程序，必须有 JS 运行时；`npx` 本身也来自 Node）。
- 本机已配置可用的 **Claude CLI**。

> 没装 Node？macOS 用 `brew install node`，或访问 https://nodejs.org 下载安装包。

## 快速连接（前台运行）

```bash
npx @kiki/daemon@latest run \
  --server-url https://<your-kiki-domain> \
  --api-key sk_machine_xxx
```

终端保持打开即在运行，关闭终端进程结束。适合首次联调。

## 后台常驻 + 开机自启（推荐）

```bash
# 建议先全局安装，获得稳定的可执行路径
npm i -g @kiki/daemon

kiki-daemon install \
  --server-url https://<your-kiki-domain> \
  --api-key sk_machine_xxx
```

`install` 会在当前系统注册后台服务：

| 平台 | 机制 | 行为 |
|------|------|------|
| macOS | LaunchAgent (`~/Library/LaunchAgents/com.kiki.daemon.plist`) | 后台运行、崩溃自动拉起、登录自启 |
| Linux | systemd user unit (`~/.config/systemd/user/kiki-daemon.service`) | 后台运行、崩溃自动重启、`enable-linger` 后开机自启 |
| Windows | 暂未自动支持 | 请用任务计划程序 / NSSM 注册 `run` 命令 |

安装后可关闭终端，daemon 在后台常驻。

### 管理

```bash
kiki-daemon status      # 查看是否已安装 / 运行中
kiki-daemon uninstall   # 停止并移除后台服务
```

数据目录固定为 `~/.kiki/data`，日志在 `~/.kiki/runtime/logs/`。

> 安全提示：`install` 会把 `--api-key` 写入服务配置文件（仅当前用户可读）。轮换密钥后请重新 `install`。

## 本地开发构建

```bash
npm install
npm run build   # esbuild 打包 src/cli.ts -> dist/cli.cjs（除 better-sqlite3 外全部内联）
```

## 发布到 npm

**前置条件**

1. [npm 账号](https://www.npmjs.com/signup) 已登录：`npm login`
2. 拥有 `@kiki` 作用域权限（在 [npm 创建组织 `kiki`](https://www.npmjs.com/org/create)，或将账号加入该组织）

**本地发布**

```bash
./scripts/publish-daemon.sh
```

**GitHub Actions 发布**

1. 在 GitHub 仓库 Settings → Secrets 添加 `NPM_TOKEN`（npm Access Token，类型 Automation）
2. Actions →「Publish @kiki/daemon」→ Run workflow

或打 tag 触发：

```bash
git tag daemon-v0.1.0
git push origin daemon-v0.1.0
```
