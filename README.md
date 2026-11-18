# Agent Bridge for Codex

Agent Bridge 让 Codex 把任务派发给 Hermes、DeepSeek Harness（DSH）或 Antigravity，跟踪交付，并根据验收证据记录通过或发起返工。v0.4.0 增加了 Antigravity CLI（`agy`）接入，支持逐任务选择模型和思考强度。

## 配置

安装 Codex 桌面端及 CLI、Node.js 24+ 和 npm，并确保 Codex 能在 PATH 中找到 `node`。克隆本仓库后，选择至少一种执行端，并从相应模板复制出项目根目录的 `bridge.local.json`。

- **Hermes** 使用 [Hermes 模板](bridge.example.json)。启动支持 HTTP Runs 的 Hermes API 服务，配置 `baseUrl` 和 `HERMES_API_KEY`，或者用 `apiKeyFile` 指向本机凭据。直接读取 Hermes YAML 时加上 `"apiKeyFormat": "hermes_yaml"`。`baseUrl` 填主机根地址或配置文件前缀 `/p/<profile>`。
- **DSH** 使用 [DSH 模板](bridge.deepseek.example.json)。将 `command`、DSH `bin.js` 参数和 `DSH_HOME` 换成本机路径。模板使用 DSH 的 `headless --json` 和 `opencode-go` 的 `deepseek-v4.1-flash`。将自己的 `OPENCODE_GO_API_KEY` 配置到 Codex 进程可读取的环境中。若使用 DSH 的本机凭据文件，可将 [模型 patch](config/dsh-opencode-go.patch.yml) 复制成 `config/dsh-opencode-go.local.yml`，在副本中添加 `credentials` 配置并更新 `--patch` 参数。首次接入可运行 `npm run check:dsh-model` 检查最终 DSH 配置。
- **Antigravity** 安装 [官方 CLI](https://antigravity.google/docs/getting-started) 并通过 `agy` 登录，使用 [Antigravity 模板](bridge.antigravity.example.json)。将 `command` 指向本机可执行文件的绝对路径，`cwd` 指向已创建的项目目录或 Git worktree。需要捕获源码和预览时，把交付目录加入 `artifactRoots`。用 `agy models` 查看当前账号可用的模型变体。

同时启用多个执行端时，将它们放入同一个 `agents` 数组。密钥、本机配置和任务数据保存在各自的机器上。

## 安装到 Codex

在项目根目录执行以下命令。`plugin:prepare` 会编译 MCP 服务并生成指向当前目录的本地 marketplace。

```powershell
npm ci
npm run probe
npm run plugin:prepare
codex plugin marketplace add ./local-marketplace
codex plugin add codex-agent-bridge@agent-bridge-local
```

安装后新建一个本地 Codex 聊天。可以说「让 Antigravity 用 Gemini 4 Argon、Medium 思考强度做一版项目看板，交付源码和浏览器预览，由你验收」。`npm run probe` 对 DSH 和 Antigravity 检查启动路径，模型和凭据由真实任务验证。

插件和看板共用本机任务后台。默认看板地址为 `http://127.0.0.1:4318/`，也可在聊天中让 Agent Bridge 打开看板。移动源码目录后，在新目录重新运行 `npm run plugin:prepare` 并安装。

已有安装升级时，等任务结束后在旧源码目录运行 `npm run service:stop`。拉取新版后按上述命令重新构建并安装插件，再新开 Codex 聊天加载工具定义。

## Antigravity 派单

模板的 `agyDefaults` 设为 `gemini-4-hydrogen` 和 `high`。`task_submit` 顶层的 `model` 和 `reasoningEffort` 可以分别覆盖默认值。比如只传 `"reasoningEffort": "medium"`，模板就会使用 Hydrogen Medium。需要同时选择两项时，可传 `"model": "gemini-4-argon", "reasoningEffort": "low"`。带强度后缀的模型 ID 需要与所选强度一致。

参数在入队时随任务保存。在 `task_get` 的 `attempts[].agySelection` 中可查看该次尝试的派单参数。返工沿用上一轮参数，显式传入 `useLatestDefaults` 时使用当前默认值。配置文件里的默认值在后台重启后生效。

一个 Antigravity Agent 绑定一个工作目录，同一配置一次执行一个任务。项目之间可分别配置 Agent ID 和工作目录。Antigravity CLI 管理登录和工具权限。需要允许工作区文件编辑时，可在该 Agent 的 `args` 中加入 `["--mode", "accept-edits"]`。Codex 可在收到交付后捕获源码、打开预览，并按真实结果验收。

v0.4.0 已在 Windows 上通过真实派单验证默认 Hydrogen High、显式 Argon Low、只改强度得到 Hydrogen Medium，以及只改模型得到 Argon High。验收核对了 CLI 会话记录里的实际模型变体。

## 开发检查

`npm run typecheck` 检查类型，`npm test` 运行本地回归。任务报告需要独立验收，任务中写明的执行范围由各 Agent 的实际权限和沙箱执行。
