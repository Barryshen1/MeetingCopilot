# 在 macOS 安装本个人分支

本分支支持在本机构建 Apple 芯片 `.app` 和 ZIP。应用使用 **ad-hoc 临时签名**，**未经过 Apple 公证**，不需要 Apple Developer 签名凭据。下面的命令不会发布版本，也不会安装音频驱动、Python、模型或 Codex CLI。

[English](INSTALL_MACOS.en.md) · [Codex CLI 配置](../CODEX_CLI.zh-CN.md)

## 环境要求

| 项目 | 要求 |
|---|---|
| 系统 | Apple 芯片，macOS 14+ |
| 构建工具 | Node.js ≥ 20、npm、Apple Command Line Tools（运行 `xcode-select -p` 可检查） |
| AI 回答 | 已安装并登录的 Codex CLI，或 OpenAI 兼容 API 服务 |
| 语音转录 | 云端 ASR key，或单独配置的本地 ASR 环境及模型 |
| 会议 / 系统音频 | 通过 [BlackHole](https://github.com/ExistentialAudio/BlackHole) 等输入设备路由；单独使用麦克风录到的是房间声音 |

## 构建应用

```bash
git clone https://github.com/Barryshen1/MeetingCopilot.git
cd MeetingCopilot
npm ci             # 自动应用必需的 patches/ 补丁
npm run dist:mac:dir
npm run install:mac   # 安装到 /Applications，并移除 release/ 里的构建副本
open -a /Applications/MeetingCopilot.app
```

`npm run install:mac` 会先确认应用已退出，再把 `release/mac-arm64/MeetingCopilot.app` 复制到 `/Applications`（可用 `MC_INSTALL_DIR` 改为其他文件夹），校验签名、向系统登记这一份，然后删除 `release/` 中的 `.app` 构建副本。运行 `npm run dist:mac` 还会在 `release/` 生成 `MeetingCopilot-<version>-mac-arm64-adhoc.zip`，安装脚本不会删除 ZIP。

**安装在内置磁盘上。** 这是约 650 MB 的 Electron 应用；放在 USB 机械移动硬盘上时，硬盘一忙，从点击到出现窗口实测要 40–75 秒，看起来像“打不开”；放在内置 SSD 上不到 1 秒。应用数据目录可以留在外置盘。

**只保留一份 `.app`。** 每个 `MeetingCopilot.app`（包括备份、解压出的副本和 `release/` 构建）都以同一个应用标识登记，会在 Spotlight / 启动台里重复出现，系统“打开 MeetingCopilot”时也可能启动旧副本。需要回滚备份时，打包成 ZIP：`ditto -c -k --keepParent /Applications/MeetingCopilot.app ~/MeetingCopilot-backup.zip`。

构建保留 hardened runtime，并对应用及辅助程序进行临时签名。授权文件允许 Electron 的 JIT、加载自带库和音频输入，但不会代替用户授予麦克风或屏幕录制权限；macOS 仍会请求授权。

首次启动会进入配置向导。使用 Codex 时，可选择 **Codex CLI、高级配置与本地模式**，再按 [Codex CLI 指南](../CODEX_CLI.zh-CN.md) 配置。语音转录独立设置，未配置转录时也可以输入文字提问。

## 从源码运行

完成 `npm ci` 后运行：

```bash
npm run build
npm start
```

开发时使用 `npm run dev` 启用热更新。开发模式下给 Electron 的授权，可能需要在打包后的 MeetingCopilot 中重新授予。

## 音频路由与权限

默认情况下（「对方音频输入」= **系统声音**，macOS 14.2+），对方发言直接从 Mac 正在播放的声音录制，不经过麦克风，也不需要 BlackHole；第一次开始时按提示允许 MeetingCopilot 录制系统音频。若想改用 BlackHole 等输入设备采集会议 / 系统声音：

1. 单独安装 [BlackHole](https://github.com/ExistentialAudio/BlackHole)。
2. 在 **音频 MIDI 设置** 中建立同时包含耳机和 BlackHole 的多输出设备。
3. 将系统输出或会议软件输出设为该多输出设备。
4. 在 MeetingCopilot 的 **设置 → 对方音频输入** 中选择 BlackHole。
5. 点击 **开始**，出现提示时允许麦克风权限，并检查音量条和转录文字。

麦克风权限适用于包括虚拟设备在内的音频输入。需要记录自己的发言时，还可单独启用麦克风通道。

截图问答需要 **屏幕录制** 权限（部分 macOS 版本称为 **屏幕与系统音频录制**）。按提示在 **系统设置 → 隐私与安全性** 中授权；如果系统要求，退出并重新打开 MeetingCopilot。这项权限本身不会配置会议音频路由。

详细路由及本地 Python 配置见 [macOS 配置指南](../macos/SETUP.zh-CN.md)。

## 会议记录

点 **■ 停止** 后，MeetingCopilot 会把本会话的转录导出成 Markdown，默认保存在 `~/Documents/MeetingCopilot 会议记录/`，文件名形如 `2026-10-02 1503 会议名.md`。会议记录只包含转录（时间、说话人、原文），不包含 AI 回复和翻译。同一会话再次停止时会覆盖同一个文件。转录栏的 **导出** 按钮可随时手动导出；在 设置 → 会议记录 中可以关闭自动导出或更改保存位置。

## 数据与限制

- 设置、会话、资料和模型位于 `~/Library/Application Support/MeetingCopilot/`。API key 通过 Electron `safeStorage` 和 macOS 钥匙串保存；Codex CLI 自行管理登录。
- 应用标识为 `io.github.barryshen1.meetingcopilot`。本分支沿用 `MeetingCopilot` 数据文件夹，因此会与使用相同文件夹的上游安装共享数据。
- 临时签名适合本机个人构建。公开分发需要另行配置正式签名和公证。
- 采集保护只能尽力而为，新版 ScreenCaptureKit 客户端仍可能录到窗口。
- 本地 FunASR 需要自己的 Python 环境和模型；本地 Whisper 在 macOS 使用 CPU。本构建不会自动安装或验证这些后端。

## 相关文档

- [Codex CLI 配置](../CODEX_CLI.zh-CN.md)
- [快速开始](QUICK_START.zh-CN.md)
- [API key 配置](API_KEYS.zh-CN.md)
- [故障排查](TROUBLESHOOTING.zh-CN.md)
