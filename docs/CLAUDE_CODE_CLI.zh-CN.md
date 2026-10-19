# 使用 Claude Code CLI 生成 AI 回答

Claude Code CLI 是本分支默认的 AI 回答后端，复用本机 Claude Code 的登录状态，进行流式回答、翻译、会话总结和截图问答。无需在 MeetingCopilot 中粘贴 API Key；仍会消耗你的 Claude 订阅额度或 API 用量。

## 1. 安装并登录

先检查安装与登录状态：

```sh
claude --version
claude auth status
```

如果找不到 `claude`，请按 [Claude Code 官方安装指南](https://docs.claude.com/en/docs/claude-code/setup) 安装，然后登录：

```sh
claude auth login
```

在浏览器中完成登录。凭证由 Claude Code 管理，MeetingCopilot 不读取、复制或保存。应用环境中的 `claude setup-token` 令牌（`CLAUDE_CODE_OAUTH_TOKEN`）或 `ANTHROPIC_API_KEY` 同样可用。

## 2. 在 MeetingCopilot 中使用

1. 新配置默认就是 **Claude Code CLI**；已有配置也会自动切换一次，包括原来使用 Codex CLI 的配置（Codex 设置会保留）。只有使用 API 后端并保存了 AI 回答或视觉 API Key 的配置保持不变；这种情况请打开 **设置**，把 **AI 回答后端** 改为 **Claude Code CLI**。
2. 检查 **已安装** 和 **已登录**。**刷新状态** 只运行 `claude --version` 和 `claude auth status`，不会生成回答。
3. 选择模型：Claude Opus 5.5（`claude-opus-5-5`，默认）、Claude Sonnet 5.5、Claude Haiku 5.5、Claude Fable 5.1、自定义模型 ID 或别名，或使用 CLI 默认模型。推理强度默认 `low`；`medium`、`high`、`xhigh`、`max` 回答更慢。回答区的 **Claude 模型** 按钮可直接跳到这两个选项。
4. 点击 **保存**，再点击 **测试连接**。测试会实际生成一小段文本；生成成功后，服务状态才会标为已连接。更改模型、推理强度或可执行文件会清除原有验证结果。

自动查找失败时，在终端运行 `command -v claude`，把完整路径填入 **Claude Code 高级设置 → Claude Code 可执行文件路径**。Finder 启动的应用不会继承 shell 的 PATH，所以 MeetingCopilot 会依次检查 `~/.local/bin/claude`、`/usr/local/bin/claude`、`/opt/homebrew/bin/claude`、`~/.claude/local/claude`、`~/.npm-global/bin/claude`，再检查 PATH。Windows 上检查 `%USERPROFILE%\.local\bin\claude.exe`、npm 安装位置和 PATH（尽力支持）。

## 3. 截图问答

标题栏的 **截图开／关** 控制截图问答。开启后，Claude Code 会收到截图和问题，不需要额外视觉 API Key。文本连接测试不会验证图片能力。

## 常见问题

- **未找到 CLI：** 检查 `command -v claude`，然后手动填写可执行文件路径。
- **未登录／提示 “OAuth session expired”：** 运行 `claude auth login`，再刷新状态或重试。
- **已登录但测试失败：** 查看返回的错误，检查模型权限、用量限制和网络。
- **首字较慢：** 每次回答都会启动一个新的 `claude` 进程（约 1–2 秒）。可降低推理强度或换用更快的模型。
- **没有转写内容：** 语音转写单独配置；Claude Code 测试不代表音频正常。

## 集成方式

每次请求运行一次 `claude -p`，并带上 `--tools ""`、`--no-session-persistence`、`--strict-mcp-config`、`--setting-sources ""`、`--disable-slash-commands` 和 `--safe-mode`：不使用工具、MCP 服务器、技能、插件、hooks 或 `CLAUDE.md`，也不保存会话。对话通过标准输入作为一条 stream-json 消息发送（图片为 base64 块），之前的轮次以带标签的对话记录附上。进程在 MeetingCopilot 自己的空目录 `claude-code-workspace` 中运行，不会进入你的项目；取消或超过三分钟时会被终止。MeetingCopilot 不修改你的 Claude Code 设置。从 Claude Code 会话内启动应用时混入的变量（`CLAUDECODE`、除 `CLAUDE_CODE_OAUTH_TOKEN` 外的 `CLAUDE_CODE_*`、`CLAUDE_AGENT_SDK_*`、`ANTHROPIC_BASE_URL`）不会传给子进程。

## 开发者冒烟检查

在仓库根目录运行：

```sh
npm run smoke:claude -- --live --image
```

检查 CLI 查找与登录、依赖对话历史的流式回答，以及使用 `resources/test-image.png` 的图片输入。只发送合成测试文本和测试图片。去掉 `--live --image` 则只检查安装与登录。可选环境变量：`MC_CLAUDE_BINARY`、`MC_CLAUDE_MODEL`、`MC_CLAUDE_EFFORT`、`MC_CLAUDE_SMOKE_DIR`。
