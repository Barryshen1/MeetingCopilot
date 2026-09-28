# 使用 Codex CLI 生成 AI 回答

此分支支持复用本机 Codex CLI 登录，进行流式回答、翻译、会话总结和截图问答。无需在 MeetingCopilot 中另填 AI 回答 API Key；仍会消耗你的 Codex 账户额度或 API 用量。

## 1. 在 macOS 上安装并登录

要求 **Codex CLI 0.139.0 或更新版本**。如果已经安装，先检查版本与登录状态：

```sh
codex --version
codex login status
```

已安装 Node.js 和 npm 时，使用以下命令安装或更新 CLI：

```sh
npm install -g @openai/codex
codex login
```

在浏览器中完成登录。凭证由 Codex 管理，MeetingCopilot 不复制 CLI 的登录凭证。其他安装和登录方式见 [Codex CLI 官方指南](https://developers.openai.com/codex/cli/)。

## 2. 在 MeetingCopilot 中选择 Codex

1. 首次启动时，在方案页选择 **Codex CLI、高级配置与本地模式**。无需输入 API Key 即可进入主界面。
2. 打开 **设置**，将 **AI 回答后端** 切换到 **Codex CLI**。
3. 检查 **已安装** 和 **已登录**。**刷新状态** 只读取安装、账户及可用模型信息，不会生成回答。
4. 保留 **使用 Codex CLI 默认模型**、选择 CLI 返回的模型，或输入自定义模型 ID。推理强度可保持默认，也可选择该模型支持的选项。
5. 点击 **保存**，重新打开设置，点击 **测试连接**。测试会实际生成一小段文本并消耗账户额度；生成成功后，AI 回答服务才会标为已连接。

也可以先测试未保存的配置。测试结果仅对应当前填写的内容；保存后再次测试，才能在服务状态中记录验证结果。切换后端、模型、推理强度或可执行文件会清除原有验证结果。切回 API 后端时，原有端点、模型和已保存的 Key 会保留。

自动查找失败时，在终端运行：

```sh
command -v codex
```

将完整路径填入 **Codex 高级设置 → Codex 可执行文件路径**，然后刷新。此字段接受可执行文件路径，不接受带参数的命令。

Finder 启动的应用不会继承终端的完整环境。MeetingCopilot 会额外检查常见的 Homebrew、npm 和 nvm 安装位置。对于 npm 安装，它会直接运行包内的原生 Codex 程序，不需要通过 shell 查找 Node.js。安装在其他位置时可手动指定路径。如果终端使用自定义 `CODEX_HOME`，启动 MeetingCopilot 时也需带上相同环境，Codex 才能找到相同的登录和配置。

## 3. 提问与截图

未配置语音转写时也可以手动提问。截图问答需要先在标题栏开启 **多模态**，再点击截图按钮或使用截图快捷键。Codex 会收到所选图片和问题，不需要额外视觉 API Key。请使用支持图片的 Codex 模型；文本连接测试不会验证图片能力。

回答会逐步显示。点击 **停** 可以取消当前回答。更高的推理强度可能增加等待时间。

## 语音转写需要单独配置

Codex CLI 提供 AI 回答服务，不负责音频转写。请在设置中选择 ASR 后端：云端 ASR 仍需其对应的凭证，本地 ASR 需要相关运行环境和模型。macOS 会议声音的采集方式见 [macOS 音频配置](macos/SETUP.zh-CN.md)，需要时配置并选择虚拟音频输入。

## 常见问题

- **未找到 CLI：** 检查 `command -v codex`，然后手动填写可执行文件路径。
- **未登录：** 执行 `codex login` 并完成登录，再刷新状态。
- **已安装、已登录，但测试失败：** 查看返回的错误，检查模型权限、账户额度、网络和 CLI 版本。检测到安装不代表请求一定能成功。
- **自定义模型或推理强度被拒绝：** 使用刷新状态返回的模型及推理强度，或恢复默认值。
- **截图失败：** 确认所选模型支持图片，并检查 macOS 是否授予应用屏幕录制权限。
- **没有转写内容：** 单独检查 ASR 和音频输入；Codex 测试成功不代表音频采集或转写正常。

## 集成方式

应用通过标准输入/输出连接 `codex app-server`，并保留进程供后续请求使用。每次请求使用独立的临时线程，传入 MeetingCopilot 提供的对话。集成禁用代理工具，并拒绝交互式工具及权限请求。提示词、所选上下文和截图会发送到 Codex 配置的服务商进行推理。MeetingCopilot 仍会在本机保存自己的会议会话。

身份验证继续使用原来的 CLI 目录（`CODEX_HOME`，或 Codex 默认目录）。已登录的 CLI 进程自行读取和维护登录状态；MeetingCopilot 不读取、复制或保存其令牌。运行时配置通过子进程参数传入，不编辑你的 Codex 配置文件。

MeetingCopilot 将 CLI 的 SQLite 状态和日志保存在自己的 `codex-workspace/cli-runtime/` 目录中；macOS 上位于 `~/Library/Application Support/MeetingCopilot/` 内。应用先使用一个空的自有目录初始化这份状态，再使用原 CLI 目录和同一份独立状态启动已登录进程。这样可以避免将已有 Codex 聊天历史导入 MeetingCopilot 的运行环境。MeetingCopilot 不移动或改写原有的 Codex 会话文件和数据库。不同版本的可执行文件使用各自的运行目录。

## 开发者冒烟检查

在仓库根目录完成 `npm ci` 后运行：

```sh
npx vite-node tools/codex-smoke.ts --live --image
```

检查包含 CLI 查找与登录、带历史对话的流式文本回答，以及使用 `resources/test-image.png` 的图片输入。只发送合成测试文本和测试图片，不录音、不截取屏幕，也不读取会议会话。两次生成请求会消耗 Codex 账户额度。去掉 `--live --image` 可仅检查安装、登录和模型列表，不生成文本。

可选环境变量：`MC_CODEX_BINARY` 指定可执行文件，`MC_CODEX_MODEL` 指定模型，`MC_CODEX_SMOKE_DIR` 指定已存在的临时测试工作区父目录。脚本结束时会清理该工作区。

开发参考：[Codex app server](https://learn.chatgpt.com/docs/app-server)。
