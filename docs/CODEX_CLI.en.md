# Use Codex CLI for AI answers

This fork can use your local Codex CLI login for streamed answers, translations, session summaries, and screenshot questions. You do not need to paste a separate AI answer API key into MeetingCopilot. Your Codex account limits or API billing still apply.

## 1. Install and sign in on macOS

Use **Codex CLI 0.139.0 or newer**. If you already have it, check the version and login before installing anything:

```sh
codex --version
codex login status
```

With Node.js and npm installed, this installs or updates the CLI:

```sh
npm install -g @openai/codex
codex login
```

Complete the sign-in flow in your browser. Authentication stays with Codex; MeetingCopilot does not copy the CLI's credentials. See the [official Codex CLI guide](https://developers.openai.com/codex/cli/) for installation and account options.

## 2. Select Codex in MeetingCopilot

1. On first launch, choose **Codex CLI, advanced setup and local modes** on the setup plan page. This opens the main window without requiring API keys.
2. Open **Settings** and change **AI answer backend** to **Codex CLI**.
3. Check **Installed** and **Signed in**. **Refresh status** reads installation, account, and available model information; it does not generate a response.
4. Keep **Use the Codex CLI default model**, pick a model returned by your CLI, or enter a custom model ID. Choose a reasoning effort supported by that model, or leave the CLI default.
5. Click **Save**, reopen Settings, and click **Test connection**. This sends a small generation request and uses your account allowance. Only a successful generation marks AI answers as connected.

You can test a draft before saving it. That result applies to the draft; save and test again to record verification in Service status. Changing backend, model, reasoning effort, or executable clears the previous saved verification. Switching back to the API backend retains its endpoint, model, and stored key.

If detection fails, run this in Terminal:

```sh
command -v codex
```

Paste the full executable path into **Advanced Codex settings → Codex executable path**, then refresh. This field takes an executable path, not a command with arguments.

Finder launches do not inherit your terminal's full environment. MeetingCopilot also checks common Homebrew, npm, and nvm installation locations. For npm installations, it runs the package's native Codex executable, so the app does not need to find Node.js through your shell. An explicit path is useful for other installation locations. If your terminal uses a custom `CODEX_HOME`, launch MeetingCopilot with that same environment so Codex can find the same login and configuration.

## 3. Ask questions and use screenshots

Typed questions work independently of transcription. For screenshot questions, enable **Vision** in the title bar, then use the screenshot button or configured screenshot hotkey. Codex receives the selected image and question; no separate vision API key is required. Choose a Codex model that accepts images. The text connection test does not establish image support.

Answers stream as they arrive. **Stop** cancels the active answer. Increasing reasoning effort can increase response time.

## Speech recognition is separate

Codex CLI supplies the AI answer backend; it does not transcribe audio. Select an ASR backend in Settings. Cloud ASR still needs its own credentials; local ASR needs the relevant runtime and models. For meeting audio on macOS, follow the [macOS audio setup](macos/SETUP.md), including selection of a virtual audio input where needed.

## Troubleshooting

- **CLI not found:** verify `command -v codex`, then set the executable path explicitly.
- **Not signed in:** run `codex login`, complete sign-in, and refresh status.
- **Installed and signed in, but the test fails:** read the returned error. Check model access, account allowance, network connectivity, and CLI version. Installation alone does not prove service availability.
- **Custom model or effort rejected:** choose a model and effort returned by Refresh status, or restore both defaults.
- **Default model requires a newer CLI:** the default option uses your global CLI configuration. Select a model returned by Refresh status, or update Codex CLI before using the newer model.
- **Screenshot fails:** verify that the chosen model accepts images and macOS has granted the app screen recording permission.
- **No transcript:** check ASR and audio input settings separately; a successful Codex test does not test audio capture or transcription.

## Integration notes

The app communicates with `codex app-server` over standard input/output and keeps the process available for subsequent requests. Each request uses a separate ephemeral thread and the conversation supplied by MeetingCopilot. The integration disables agent tools and rejects interactive tool/permission requests. Prompts, selected context, and screenshots are sent to the provider configured in Codex for inference. MeetingCopilot continues to save its own meeting sessions locally.

Authentication remains in the original CLI home (`CODEX_HOME`, or Codex's default home). The authenticated CLI process reads and maintains its own login; MeetingCopilot does not read, copy or store its tokens. Runtime overrides are passed to the child process without editing your Codex configuration file.

MeetingCopilot keeps the CLI's SQLite state and logs under its own `codex-workspace/cli-runtime/` directory. On macOS this is inside `~/Library/Application Support/MeetingCopilot/`. It first initializes that state using an empty app-owned home, then starts the authenticated process with the original CLI home and the same private state directory. This avoids importing existing Codex chat history into MeetingCopilot's runtime. Your existing Codex session files and database are not moved or rewritten by MeetingCopilot. Each executable version receives a separate runtime directory.

## Developer smoke check

From the repository root, after `npm ci`:

```sh
npx vite-node tools/codex-smoke.ts --live --image
```

This checks CLI discovery and login, streamed text with conversation history, and image input using `resources/test-image.png`. It sends only synthetic test text and the fixture image; it does not record audio, capture your screen or load meeting sessions. The two generation requests use your Codex account allowance. Run without `--live --image` to check discovery, login and the model list without generating text.

Optional environment variables: `MC_CODEX_BINARY` selects an executable, `MC_CODEX_MODEL` selects a model, and `MC_CODEX_SMOKE_DIR` selects an existing parent directory for the temporary test workspace. The script cleans up that workspace when it finishes.

Developer reference: [Codex app server](https://learn.chatgpt.com/docs/app-server).
