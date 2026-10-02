# macOS 部署指南

[English](SETUP.md) · [Windows 指南](../windows/SETUP.zh-CN.md)

macOS 版保留了完整链路——流式转录、提词式回答、简历/JD 贴合——但有两个平台差异：

1. **系统声音由内置小组件录制。** Electron 的 `audio: 'loopback'` 仅支持 Windows。在 macOS 14.2 及以上，「对方」通道使用随应用打包的 `mc-system-audio`：它通过 Core Audio 进程音频捕获录制 Mac 正在播放的声音，不会打开麦克风。也可以改选 BlackHole 等输入设备（见下文）。
2. **隐身是尽力而为。** 新版 ScreenCaptureKit 客户端仍可能捕获窗口，macOS 上无法保证完全隐身。

工程细节见 [移植 SDD](macos-port-sdd.md)。

## 环境要求

| 组件 | 要求 |
|---|---|
| 操作系统 | Apple 芯片 macOS 14+ |
| 运行时 | Node.js ≥ 20 与 npm |
| 大模型 | 已安装并登录的 Codex CLI，或 OpenAI 兼容 API key |
| 本地流式转录（默认） | 项目 `.venv` 里的 Python 3.10/3.11；Apple MPS，自动 CPU 回退 |
| 系统声音采集 | [BlackHole](https://github.com/ExistentialAudio/BlackHole)（或同类虚拟音频设备） |
| 云端转录（可选） | 阿里云百炼（DashScope）key，或 MiMo key |

## 安装与启动

```bash
git clone https://github.com/Barryshen1/MeetingCopilot.git
cd MeetingCopilot
npm ci             # postinstall 自动应用 patches/（transformers.js 补丁，勿删）
npm run build
npm start
```

## 音频：把会议声音接进 MeetingCopilot

**默认：系统声音。** 设置 → 音频设备 →「对方音频输入」选**系统声音**时，点 ▶ 开始会录制 Mac 正在播放的所有声音（会议软件、视频等），不会打开麦克风；你自己的声音只会通过单独的 **🎤** 通道进入转录。第一次开始时，macOS 会请你允许 MeetingCopilot 录制系统音频（系统设置 → 隐私与安全性 → 屏幕与系统音频录制）。需要 macOS 14.2+；`npm run build` 会用 `swiftc`（Apple Command Line Tools）编译这个小组件。

**备选：BlackHole。** 如果想经虚拟设备采集会议软件：

1. **安装 BlackHole**（2 声道版即可）：
   ```bash
   brew install blackhole-2ch
   ```
   安装后重启 macOS，让 Core Audio 加载新设备。
2. **创建多输出设备**，保证你自己还能听到会议声音：打开**音频 MIDI 设置** → `+` → *创建多输出设备* → 同时勾选你的扬声器/耳机**和** BlackHole 2ch。将扬声器设为主设备，并为 BlackHole 开启漂移校正。
3. **把系统输出指向它**：系统设置 → 声音 → 输出 → 选择该多输出设备。此后声音照常从扬声器播放，同时镜像进 BlackHole。
4. **在 MeetingCopilot 里选中 BlackHole**：打开 **设置 → 音频设备**，先将「对方音频输入」设为 *BlackHole 2ch*，再点 **▶ 开始**。首次使用时需授权麦克风。

将多输出设备设为默认输出时，macOS 可能暂时禁用全局音量键；可在「音频 MIDI 设置」调节扬声器音量，或结束转写后把默认输出切回扬声器。

该通道已关闭回声消除/降噪/自动增益，虚拟设备的 PCM 原样进入转录；独立的 **🎤** 通道仍保留正常麦克风处理，用于你自己的声音。

## 本地流式 FunASR（默认转录后端）

Apple 芯片上已验证的项目内环境：

```bash
# 在仓库根目录执行
python3.11 -m venv .venv
.venv/bin/pip install -r requirements-funasr.txt
npm start
```

源码运行时应用会自动发现项目 `.venv`。安装版的资源目录不包含项目 `.venv`，请在 **设置 → 转录（ASR）→ FunASR Python 路径** 填入仓库环境中 `.venv/bin/python` 的绝对路径。保存时会检查路径是否存在、是否能运行 Python 3；错误会显示在设置页。留空时依次尝试 `MC_FUNASR_PYTHON` → 资源目录 `.venv/bin/python` → `python3` → `python`。`--device auto` 依次尝试 CUDA、Apple MPS、CPU；加速器初始化失败自动退回 CPU。应用只加载当前选中的一个 FunASR 模型，控制 8 GB 机型的内存占用——切换模型会重启引擎。选中的模型首次运行时从 ModelScope 自动下载（paraformer 约 880 MB，Nano 约 1.7 GB），默认缓存于应用数据目录的 `models/modelscope`（可用 `MODELSCOPE_CACHE` 覆盖）。

## 隐身限制

「隐身」开关会应用 Electron 内容保护，但基于新版 **ScreenCaptureKit** 的共享软件仍可能拍到应用窗口，不能保证完全隐身。普通、Coding Test 等应用内选项现在留在主窗口内；macOS 中文输入法候选栏、菜单栏菜单、文件选择器、系统授权弹窗和框选覆盖窗口仍可能出现在实时全屏共享中。

共享时建议切换到英文输入法，用 **Command+Shift+S** 直接截取鼠标所在显示器并提问；**Command+B** 用于隐藏/呼出主窗口。截图前应用会暂时隐藏自己的主窗口，但无法控制其他软件正在共享的画面。开始共享前，先用所选会议软件做一次实际预览。

## 数据位置

- 设置 / 会话 / 资料：`~/Library/Application Support/MeetingCopilot/`（纯 JSON）
- API key：经 macOS 钥匙串（`safeStorage`）加密落盘
