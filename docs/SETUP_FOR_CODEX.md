# 给 Codex 的 MeetingCopilot macOS 安装与配置指南

这份文件供收到安装包的人交给**自己 Mac 上的 Codex**执行。适用范围：Apple 芯片、macOS 14 或更新版本。发送人会提供一个共享 ZIP，并另行告知这个 ZIP 的 SHA-256 校验值。解压后会直接看到 `MeetingCopilot.app`、本文件 `SETUP_FOR_CODEX.md` 和项目的 `LICENSE`。应用使用临时签名，未经过 Apple 公证；安装包不包含 Codex CLI、BlackHole、Python 或本地语音模型。

## 先把任务交给你的 Codex

把发送人提供的 ZIP 解压后，将解压出的本文件所在文件夹交给你自己的 Codex，并把下面这段话发给它：

> 请阅读同文件夹的 `SETUP_FOR_CODEX.md`，在**我的 Mac** 上安装并配置 MeetingCopilot。先核对机器、安装包和现有 MeetingCopilot 数据，再安装应用；用**我的** Codex 登录配置 AI 回答，验证文字与安全测试画面的截图问答。配置阿里云新加坡 Qwen-Audio 3.1 流式语音转录时，先提醒我向发送人索取他愿意共享的通用 API Key 和对应工作空间的 WebSocket 地址，再指导我在本机 MeetingCopilot 设置中填写；不要让我把 Key 发到 Codex 聊天。如我要转录电脑里会议或视频的声音，再设置 BlackHole 音频路由并做实测。请保留我已有的应用数据，不导入发送人的 Codex 账号、会话或资料。需要我输入密码、登录或授予 macOS 权限时，让我在官方网站或系统窗口自行操作。最后报告每一项实际验证结果及未完成的步骤。

下面是 Codex 应按顺序执行的步骤。**“已安装”“已登录”“已授权”都要在这台 Mac 上验证，不能根据发送人的电脑推断。**

## 1. 检查安装包与现有数据

1. 运行 `uname -m` 和 `sw_vers -productVersion`。本包只面向 `arm64`、macOS 14+。若条件不符，停止安装并说明原因。
2. 找到发送人交付的**外层 ZIP** 和单独提供的 SHA-256 校验值。对 ZIP 的实际路径运行 `shasum -a 256`，与发送人的值逐字比对，**通过后再安装 `.app`**。不要把 ZIP 名称中的版本号当作校验值。
3. 检查本机是否已有 MeetingCopilot，以及 `~/Library/Application Support/MeetingCopilot/` 是否已有设置或会话。若已有应用，先退出并备份原 `.app`；保留应用数据目录，不覆盖其中的 `settings.json`、`sessions.json`、导入资料、模型或钥匙串凭据。本分支与同名应用可能共用该数据目录。
4. 解压后把 `MeetingCopilot.app` 放到固定的“应用程序”位置，再从该位置启动；不要每次从临时解压文件夹运行。不要修改或重新签名 `.app`。

这份个人构建使用临时签名，未经 Apple 公证。首次打开若出现“无法验证开发者”一类提示，在**确认来源和哈希正确之后**，由本人按 [Apple 的“仍要打开”步骤](https://support.apple.com/102445) 在“系统设置 → 隐私与安全性”操作。若系统提示应用**已损坏或包含恶意软件**，不要绕过提示；重新核对交付文件。不要关闭整个 Mac 的安全检查，也不要用 `xattr`、`spctl` 或 `tccutil` 批量绕过保护。

## 2. 用你自己的 Codex 登录回答服务

Codex 桌面应用已登录，不等于终端里的 **Codex CLI** 已安装或已登录。MeetingCopilot 需要可运行的 CLI。先在终端检查：

```sh
command -v codex
codex --version
codex login status
```

本分支需要 Codex CLI **0.139.0 或更新版本**。如果 CLI 缺失或太旧，按照 [OpenAI 官方 Codex CLI 安装说明](https://learn.chatgpt.com/docs/codex/cli)选择这台 Mac 适用的安装方式，然后重新检查。若未登录，运行 `codex login`，由本人在浏览器用**自己的 ChatGPT/OpenAI 账号**完成登录；`codex login status` 应显示已登录的认证方式。CLI 的认证说明见 [OpenAI 官方文档](https://learn.chatgpt.com/docs/auth)。不要复制另一台电脑的 `~/.codex/auth.json`、`CODEX_HOME` 或 API Key。

1. 首次打开 MeetingCopilot 时选择中文界面和 **“Codex CLI、高级配置与本地模式”**，进入主窗口。
2. 打开 **设置 → AI 回答后端 → Codex CLI**，点击 **刷新状态**。确认显示“已安装”“已登录”；如有账号邮箱，确认是本人的账号。刷新只读取状态，不生成回答。
3. 在 **Codex 模型** 中优先选择状态列表里实际可用的模型，选择该模型支持的**推理强度**。新配置预填 `gpt-6-sol` / `low`；只有该账号能用且连接测试成功，才保留它。也可以选“使用 Codex CLI 默认模型”。无需改动全局 Codex 配置。
4. 设 **界面语言 = 中文**，**回答语言 = 自动**（也可由本人选“中”或“EN”），点击 **保存**。重新打开设置，点 Codex 的 **测试连接**。此按钮会发起一次真实生成请求，消耗该账号额度；记录成功或具体错误。若 Finder 启动的应用找不到 CLI，运行 `command -v codex`，将得到的**可执行文件完整路径**填进“Codex 高级设置 → Codex 可执行文件路径”，保存后刷新、重测。
5. 在主窗口用不含个人信息的文字输入，例如“请用一句话解释什么是递归”，确认右栏出现回答。失败时先检查 CLI 状态、模型权限、网络和测试连接错误；**Codex 测试成功不能证明语音转录已配置**。

## 3. 验证截图问答

先打开一张不含个人信息的测试画面，并关掉可能包含私密内容的其他窗口。标题栏启用**多模态 / 截图**，点 📷 或按默认 **Command+Shift+S**；应用会截取**鼠标所在的整块显示器**。需要局部画面时再使用“框选”。确认所选 Codex 模型支持图片：文字“测试连接”不会检查视觉能力。

首次截图时由本人在 **系统设置 → 隐私与安全性 → 屏幕与系统音频录制**中开启 **MeetingCopilot 的屏幕录制**权限；“仅系统音频录制”不足以授权截图。按 macOS 提示退出并重新打开固定安装位置的 `.app`，再用同一测试画面重试。将来换用签名不同的新构建时，macOS 可能要求重新授权。详见 [Apple 的屏幕录制权限说明](https://support.apple.com/guide/mac-help/mchld6aa7d23/mac)。无需向聊天发送系统密码或真实屏幕截图。

## 4. 配置语音转录（ASR）

Codex CLI 只负责 AI 回答和图片理解，**不会把声音转成文字**。如果目前只用文字与截图，到第 3 步就可先使用；要转录会议或视频，再完成本节和下一节。

安装包没有本地 FunASR 的 Python 环境或模型。可在 **设置 → 转录（ASR）**选择一种独立方案：

| 方案 | 要准备什么 | 操作 |
|---|---|---|
| 云端实时转录 | 发送人另行提供的阿里云新加坡 API Key 和对应工作空间地址；音频会发到其阿里云服务 | 选“云端流式”，填写同地域 Key 和地址，保存并测试 |
| 本地 FunASR | Python 环境、依赖与模型下载；安装包不代装 | 按[项目的 macOS 本地 ASR 指南](https://github.com/Barryshen1/MeetingCopilot/blob/main/docs/macos/SETUP.zh-CN.md)配置解释器与模型，再在设置中指定 Python 路径 |

若选择本分支支持的**阿里云新加坡 Qwen-Audio 3.1 流式转录**：

1. **Codex 先提醒收件人向发送人索取**他愿意共享的阿里云新加坡 Qwen-Audio 3.1 流式 ASR 通用 API Key，以及与这把 Key 对应的工作空间 WebSocket 地址（格式如 `wss://…ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference`）。发送人通过双方信任的私密渠道提供；安装包和本文件不包含 Key。若尚未收到，Codex 应将 ASR 标为“待配置”，继续完成其他设置。
2. 收件人在 MeetingCopilot 选择“云端流式” → “阿里云新加坡 Qwen-Audio 3.1 流式”，在应用设置框中填写收到的 WebSocket 地址和 Key，设转录语言“自动”，保存。Codex 不要要求收件人将 Key 粘贴到聊天、命令行或安装文件，也不要读取、回显或记录 Key。
3. 重新打开设置并点该 ASR 的“测试连接”；它会发送一段很短的应用内合成测试音频，可能消耗发送人的服务额度。确认测试成功；若出现 `REGION_MISMATCH` 或 `PERMISSION_DENIED`，请发送人核对 Key、模型与地址是否在同一地域及工作空间。费用和免费额度由发送人在服务商控制台确认。

保存 Key 时如果 macOS 弹出“MeetingCopilot Safe Storage”钥匙串授权，由本人在系统窗口判断并操作。若应用提示密钥只能以弱加密方式保存，先暂停保存并告知发送人。**Key 只输入 MeetingCopilot 的设置框，不贴进 Codex 聊天或交付包。** 收件人使用发送人的阿里云工作空间与配额；转录音频会发送到该服务。发送人可为这台 Mac 单独创建一把 Key，方便日后停用。

## 5. 如需转录电脑里的声音，配置 BlackHole

macOS 版从选定的**音频输入设备**采集“对方”的声音；单选 Mac 内置麦克风并不能稳定获取会议软件的系统输出。若要转录电脑里的会议或视频：

1. 由本人从 [BlackHole 官方项目](https://github.com/ExistentialAudio/BlackHole)安装 **BlackHole 2ch**，完成系统所需的安装授权；若安装后设备未出现，重启 Mac。
2. 在 macOS **音频 MIDI 设置**中创建“多输出设备”，勾选实际耳机/扬声器与 BlackHole 2ch；把实际播放设备设为主设备，并按需给 BlackHole 启用漂移校正。然后在“系统设置 → 声音 → 输出”中选这个多输出设备。参见 [Apple 的多输出设备步骤](https://support.apple.com/guide/audio-midi-setup/ams7c093f372/mac)。
3. 在 MeetingCopilot **设置 → 对方音频输入**选 **BlackHole 2ch**，保存。让电脑播放一段没有隐私内容的中/英文测试音频，点主窗口 **▶ 开始**。首次录音时由本人授予 MeetingCopilot [麦克风权限](https://support.apple.com/guide/mac-help/mchla1b1e1fe/mac)（虚拟音频输入也使用这一权限）。观察音量与左栏转录内容；点 **■ 停止**后恢复原本的系统输出设备。
4. 若无字幕，分别检查系统输出是否为多输出设备、MeetingCopilot 输入是否为 BlackHole、ASR 连接测试是否成功、音量是否非零。**AI 回答测试成功不代表 ASR 或音频路由成功。**

## 6. 收尾检查与隐私

Codex 最后应逐项报告：安装包哈希与 Mac 兼容性；`.app` 固定安装位置；CLI 版本和登录状态（不要输出令牌）；所选模型及推理强度；中文界面和回答语言；文字回答；截图权限与测试；ASR 方案及连接测试；若启用 BlackHole，实际转录和已恢复的系统输出设备。未实测的项目写“未验证”，不要写“完成”。

设置、会话和导入资料保存在**你自己 Mac** 的 `~/Library/Application Support/MeetingCopilot/`，Codex 登录由 Codex 自行管理。云端 ASR 会收到采集的音频；AI 回答服务会收到提问、所选参考资料和主动提交的截图。使用屏幕共享前要在目标会议软件做一次实际预览：macOS 的 ScreenCaptureKit 仍可能录到 MeetingCopilot 窗口，中文输入法候选栏、系统授权框和文件选择器也可能出现在共享画面中。**“隐身”不保证这些内容不可见。**

项目内的更多说明：[Codex CLI 配置](https://github.com/Barryshen1/MeetingCopilot/blob/main/docs/CODEX_CLI.zh-CN.md) · [macOS 安装说明](https://github.com/Barryshen1/MeetingCopilot/blob/main/docs/user/INSTALL_MACOS.zh-CN.md) · [故障排查](https://github.com/Barryshen1/MeetingCopilot/blob/main/docs/user/TROUBLESHOOTING.zh-CN.md)。
