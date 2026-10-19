# Use Claude Code CLI for AI answers

Claude Code CLI is this fork's default AI answer backend. It uses your local Claude Code sign-in for streamed answers, translations, session summaries, and screenshot questions. You do not paste an API key into MeetingCopilot. Your Claude subscription limits or API billing still apply.

## 1. Install and sign in

Check the installation and sign-in first:

```sh
claude --version
claude auth status
```

If `claude` is missing, install it by following the [official Claude Code setup guide](https://docs.claude.com/en/docs/claude-code/setup). Then sign in:

```sh
claude auth login
```

Complete the sign-in in your browser. Authentication stays with Claude Code; MeetingCopilot does not read, copy or store its credentials. A token from `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`) or an `ANTHROPIC_API_KEY` in the app's environment also works.

## 2. Use Claude Code in MeetingCopilot

1. New profiles already use **Claude Code CLI**, and an existing profile switches to it automatically once, including one that used Codex CLI (its Codex settings are kept). Only a profile on the API backend with a saved LLM or vision API key stays where it is; for that one, open **Settings** and choose **AI answer backend → Claude Code CLI**.
2. Check **Installed** and **Signed in**. **Refresh status** runs `claude --version` and `claude auth status`; it does not generate a response.
3. Pick a model: Claude Opus 5.5 (`claude-opus-5-5`, the default), Claude Sonnet 5.5, Claude Haiku 5.5, Claude Fable 5.1, a custom model ID or alias, or the CLI default. Pick an effort (`low` by default; `medium`, `high`, `xhigh`, `max` answer more slowly). The answer panel's **Claude model** button jumps straight to these pickers.
4. Click **Save**, then **Test connection**. This sends a small generation request. Only a successful generation marks AI answers as connected in Service status. Changing the model, effort or executable clears the previous verification.

If detection fails, run `command -v claude` in Terminal and paste the full path into **Advanced Claude Code settings → Claude Code executable path**. Finder-launched apps do not inherit your shell's PATH, so MeetingCopilot checks `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, `~/.claude/local/claude`, `~/.npm-global/bin/claude`, then PATH. On Windows it checks `%USERPROFILE%\.local\bin\claude.exe`, the npm installation and PATH (best effort).

## 3. Screenshots

The title bar's **Shots on/off** button controls screenshot questions. Turn it on; Claude Code receives the captured image and question, with no separate vision API key. The text connection test does not verify image support.

## Troubleshooting

- **CLI not found:** verify `command -v claude`, then set the executable path.
- **Not signed in / "OAuth session expired":** run `claude auth login`, then refresh status or retry.
- **Signed in, but the test fails:** read the returned error; check model access, usage limits and network.
- **Slow first words:** each answer starts a fresh `claude` process (about 1–2 seconds). Lower the effort or use a faster model.
- **No transcript:** speech recognition is configured separately; a Claude Code test does not test audio.

## Integration notes

Each request runs `claude -p` once with `--tools ""`, `--no-session-persistence`, `--strict-mcp-config`, `--setting-sources ""`, `--disable-slash-commands` and `--safe-mode`: no tools, MCP servers, skills, plugins, hooks or `CLAUDE.md`, and no saved session. The conversation is sent on standard input as one stream-json message (images as base64 blocks); earlier turns are included as a labeled transcript. The process runs in MeetingCopilot's own empty `claude-code-workspace` folder, never in your projects, and is stopped on cancel or after three minutes. MeetingCopilot does not edit your Claude Code settings. Variables that leak in when the app is launched from inside a Claude Code session (`CLAUDECODE`, `CLAUDE_CODE_*` except `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_AGENT_SDK_*`, `ANTHROPIC_BASE_URL`) are removed from the child's environment.

## Developer smoke check

From the repository root:

```sh
npm run smoke:claude -- --live --image
```

This checks discovery and sign-in, a streamed answer that depends on conversation history, and image input using `resources/test-image.png`. It sends only synthetic text and the fixture image. Without `--live --image` it only checks installation and sign-in. Optional: `MC_CLAUDE_BINARY`, `MC_CLAUDE_MODEL`, `MC_CLAUDE_EFFORT`, `MC_CLAUDE_SMOKE_DIR`.
