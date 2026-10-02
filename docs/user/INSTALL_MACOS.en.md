# Installing this personal fork on macOS

This fork supports local Apple-silicon `.app` and ZIP builds. These builds use **ad-hoc signing** and are **not Apple-notarized**. They need no Apple Developer signing credentials. The commands below do not publish a release or install audio drivers, Python, models or Codex CLI.

[简体中文](INSTALL_MACOS.zh-CN.md) · [Codex CLI setup](../CODEX_CLI.en.md)

## Requirements

| Item | Requirement |
|---|---|
| OS | macOS 14+ on Apple silicon |
| Build tools | Node.js ≥ 20, npm and Apple's Command Line Tools (`xcode-select -p` checks for them) |
| AI answers | Installed, signed-in Codex CLI, or an OpenAI-compatible API provider |
| Transcription | A cloud ASR key, or a separately configured local ASR environment and model |
| Meeting/system audio | Audio routed to an input such as [BlackHole](https://github.com/ExistentialAudio/BlackHole); a microphone alone records your room |

## Build the app

```bash
git clone https://github.com/Barryshen1/MeetingCopilot.git
cd MeetingCopilot
npm ci             # applies the required patches/ automatically
npm run dist:mac:dir
npm run install:mac   # installs to /Applications and removes the release/ build copy
open -a /Applications/MeetingCopilot.app
```

`npm run install:mac` checks that the app is not running, copies `release/mac-arm64/MeetingCopilot.app` to `/Applications` (set `MC_INSTALL_DIR` for another folder), verifies the signature, registers that copy with macOS, and then deletes the `.app` build copy under `release/`. `npm run dist:mac` also creates `MeetingCopilot-<version>-mac-arm64-adhoc.zip` under `release/`; the install script keeps the ZIP.

**Install on the internal disk.** This is a ~650 MB Electron app. Launched from a busy USB hard disk it took 40–75 s before a window appeared, which looks like the app does not open; from the internal SSD it opens in under a second. The app data folder can stay on an external disk.

**Keep exactly one `.app`.** Every `MeetingCopilot.app` (backups, extracted copies, and `release/` builds included) registers under the same bundle id, appears again in Spotlight / Launchpad, and "open MeetingCopilot" may start an old copy. For a rollback backup, make a ZIP instead: `ditto -c -k --keepParent /Applications/MeetingCopilot.app ~/MeetingCopilot-backup.zip`.

The build retains hardened runtime and signs the app and its helpers ad hoc. The entitlements allow Electron's JIT, loading its bundled libraries, and microphone access. They do not grant microphone or screen-recording consent; macOS still asks you.

The first launch opens the setup wizard. For Codex, choose **Codex CLI, advanced setup and local modes**, then follow [Codex CLI setup](../CODEX_CLI.en.md). Speech recognition is configured separately. You can ask typed questions before setting up transcription.

## Run from source

After `npm ci`, use:

```bash
npm run build
npm start
```

For development with hot reload, run `npm run dev`. Permissions granted to Electron in this mode may need to be granted again to the packaged MeetingCopilot app.

## Audio routing and permissions

The macOS app uses an ordinary audio input for the other party's speech. To route meeting/system audio through BlackHole:

1. Install [BlackHole](https://github.com/ExistentialAudio/BlackHole) separately.
2. In **Audio MIDI Setup**, create a Multi-Output Device containing your headphones and BlackHole.
3. Select that Multi-Output Device as the system output, or as the meeting app's output.
4. In MeetingCopilot, select BlackHole as **Settings → Other-party audio input**.
5. Press **Start**, allow microphone access if prompted, and check the audio level and transcript.

Microphone permission covers audio input devices, including virtual ones. You may also enable a separate microphone channel for your own voice.

Screenshot Q&A requires **Screen Recording** permission (called **Screen & System Audio Recording** on some macOS versions). Grant it under **System Settings → Privacy & Security** when requested, and quit and reopen MeetingCopilot if macOS asks. This permission alone does not configure meeting audio routing.

Full routing and local Python setup: [macOS setup](../macos/SETUP.md).

## Data and limitations

- Settings, sessions, materials and model data are stored in `~/Library/Application Support/MeetingCopilot/`. API keys use Electron `safeStorage` with macOS Keychain; Codex CLI manages its own login.
- The app bundle identifier is `io.github.barryshen1.meetingcopilot`. The fork retains the `MeetingCopilot` data folder, so it shares data with any existing upstream installation using that folder.
- Ad-hoc signing is suitable for this local personal build. Public distribution requires a separate signing and notarization setup.
- Capture protection is best-effort: modern ScreenCaptureKit clients may capture the window.
- Local FunASR requires its own Python environment and model. Local Whisper uses CPU on macOS. This build does not install or validate those backends for you.

## Related documents

- [Codex CLI setup](../CODEX_CLI.en.md)
- [Quick start](QUICK_START.en.md)
- [API key setup](API_KEYS.en.md)
- [Troubleshooting](TROUBLESHOOTING.en.md)
