# macOS Setup Guide

[简体中文](SETUP.zh-CN.md) · [Windows guide](../windows/SETUP.md)

The macOS port keeps the whole pipeline — streaming ASR, teleprompter answers,
resume/JD grounding — but two platform realities differ from Windows:

1. **System audio comes from a bundled helper.** Electron's `audio: 'loopback'`
   source is Windows-only, so on macOS 14.2+ the other-party channel uses
   `mc-system-audio`, a small helper that records what the Mac is playing through
   a Core Audio process tap. It never opens the microphone, and no virtual
   audio device is needed (below).
2. **Stealth is best-effort.** Recent ScreenCaptureKit clients may still
   capture the window; full invisibility is not guaranteed on macOS.

Engineering details live in the [port SDD](macos-port-sdd.md).

## Requirements

| Component | Requirement |
|---|---|
| OS | Apple-silicon macOS 14+ |
| Runtime | Node.js ≥ 20 and npm |
| LLM | An installed and signed-in Codex CLI, or an OpenAI-compatible API key |
| Local streaming ASR *(default)* | Python 3.10/3.11 in a project `.venv`; Apple MPS with CPU fallback |
| System-audio capture | macOS 14.2+ (built in; allow “System Audio Recording” on first start) |
| Cloud ASR *(optional)* | Alibaba Cloud DashScope API key, or a MiMo key |

## Install & run

```bash
git clone https://github.com/Barryshen1/MeetingCopilot.git
cd MeetingCopilot
npm ci             # postinstall applies patches/ (transformers.js patch — do not remove)
npm run build
npm start
```

## Audio: the other party = what the Mac plays

▶ Start records whatever the Mac is playing — the meeting app, a video — through
the bundled `mc-system-audio` helper. It never opens the microphone, and no
BlackHole or Multi-Output device is needed. Your own voice reaches the
transcript only through the separate **🎤** channel, labelled “Me”.

On the first start macOS asks you to let MeetingCopilot record system audio. If
you declined, enable it under System Settings → Privacy & Security → Screen &
System Audio Recording. Requires macOS 14.2+; `npm run build` compiles the
helper with `swiftc` (Apple Command Line Tools).

## Local streaming FunASR (default ASR backend)

Validated project-local setup on Apple silicon:

```bash
# from the repo root
python3.11 -m venv .venv
.venv/bin/pip install -r requirements-funasr.txt
npm start
```

When running from source, the app discovers the project `.venv` automatically.
The packaged app does not contain that environment: set **Settings →
Transcription (ASR) → FunASR Python path** to the absolute path of the repo's
`.venv/bin/python`. Saving checks that the path exists and runs Python 3; errors
appear in Settings. If left blank, discovery tries `MC_FUNASR_PYTHON` → the
resource directory's `.venv/bin/python` → `python3` → `python`. `--device auto`
tries CUDA, then Apple MPS, then CPU; accelerator initialization failures retry
on CPU automatically. Only the selected FunASR model is loaded to keep memory
bounded on 8 GB machines — switching models restarts the sidecar. The selected
model downloads from ModelScope on first run (~880 MB for paraformer, ~1.7 GB
for Nano). The default cache is `models/modelscope` under the app data directory;
`MODELSCOPE_CACHE` can override it.

## Stealth limits

The `Stealth` toggle applies Electron content protection, but newer
**ScreenCaptureKit** clients may still capture the app window. In-app choices,
including General and Coding Test, now stay inside the main window. The macOS
Chinese input candidate panel, menu-bar menus, file pickers, permission
dialogs, and region-selection overlay may still appear in a live full-display
share.

During sharing, use an English input source and **Command+Shift+S** to capture
the window you are working in and ask. **Command+B** hides or shows the main
window. 📷 captures only that window, so MeetingCopilot never appears in it and
is not hidden or flashed for it; Region briefly hides the main window. The app
cannot control another app's live share. Check the result in your meeting app's
preview before sharing.

## Data locations

- Settings / sessions / materials: `~/Library/Application Support/MeetingCopilot/` (plain JSON)
- API keys: encrypted at rest via the macOS Keychain (`safeStorage`)
