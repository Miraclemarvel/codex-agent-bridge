# Agent Bridge for Codex

Agent Bridge 让 Codex 将任务派发给 Hermes 或 DeepSeek Harness（DSH），跟踪交付，并根据验收证据记录通过或发起返工。v0.3.1 已在 Windows 上通过 Codex 原生插件验证 Hermes 和 DSH 的任务闭环。

## 配置

安装 Codex 桌面端及 CLI、Node.js 24+ 和 npm，并确保 Codex 能在 PATH 中找到 `node`。克隆本仓库后，选择至少一种执行端，并从相应模板复制出项目根目录的 `bridge.local.json`。

- **Hermes** 使用 [Hermes 模板](bridge.example.json)。启动支持 HTTP Runs 的 Hermes API 服务，配置 `baseUrl` 和 `HERMES_API_KEY`，或者用 `apiKeyFile` 指向本机凭据。直接读取 Hermes YAML 时加上 `"apiKeyFormat": "hermes_yaml"`。`baseUrl` 填主机根地址或配置文件前缀 `/p/<profile>`。
- **DSH** 使用 [DSH 模板](bridge.deepseek.example.json)。将 `command`、DSH `bin.js` 参数和 `DSH_HOME` 换成本机路径。模板使用 DSH 的 `headless --json` 和 `opencode-go` 的 `deepseek-v4.1-flash`。将自己的 `OPENCODE_GO_API_KEY` 配置到 Codex 进程可读取的环境中。若使用 DSH 的本机凭据文件，可将 [模型 patch](config/dsh-opencode-go.patch.yml) 复制成 `config/dsh-opencode-go.local.yml`，在副本中添加 `credentials` 配置并更新 `--patch` 参数。首次接入可运行 `npm run check:dsh-model` 检查最终 DSH 配置。

同时启用两种执行端时，将两个 Agent 配置放入同一个 `agents` 数组。密钥、实际配置和任务数据保存在各自的机器上。

## 安装到 Codex

在项目根目录执行以下命令。`plugin:prepare` 会编译 MCP 服务并生成指向当前目录的本地 marketplace。

```powershell
npm ci
npm run probe
npm run plugin:prepare
codex plugin marketplace add ./local-marketplace
codex plugin add codex-agent-bridge@agent-bridge-local
```

安装后新建一个本地 Codex 聊天。可以说「用 Agent Bridge 让 DSH 计算 1 到 5 的和，跟踪任务并独立验收」，或换成已配置的 Hermes。`npm run probe` 对 DSH 只检查启动路径，模型凭据由真实任务验证。

插件和看板共用本机任务后台。默认看板地址为 `http://127.0.0.1:4318/`，也可在聊天中让 Agent Bridge 打开看板。移动源码目录后，在新目录重新运行 `npm run plugin:prepare` 并安装。

## 开发检查

`npm run typecheck` 检查类型，`npm test` 运行本地回归。任务报告需要独立验收，任务中写明的执行范围由各 Agent 的实际权限和沙箱执行。
