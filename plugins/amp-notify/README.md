# amp-notify

Amp plugin — sends macOS notification when agent tasks complete via iTerm2 OSC 9.

## Supported Environment

**macOS + iTerm2 + tmux** — this is the only tested and working combination.

| Setup | Status |
|-------|--------|
| iTerm2 + tmux | ✅ Works |
| iTerm2 without tmux | ⚠️ TTY detection unreliable, usually fails silently |
| Ghostty / Terminal.app / others | ❌ Not supported |
| Linux / Windows | ❌ macOS only |
| Remote executor | ❌ Skipped |

tmux requires `set -g allow-passthrough all`.

## Features

- Notifies on `agent.end` (done / error / interrupted)
- OSC 9 with DCS passthrough → bypasses macOS Notification Center
- Auto-detects tmux pane TTY via process tree + `tmux list-panes`
- Shows project name + last user prompt in notification

## Install

```bash
cp plugins/amp-notify/amp-notify.ts ~/.amp/plugins/
PLUGINS=all amp
```
