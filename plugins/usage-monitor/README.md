# usage-monitor

Amp plugin for balance visibility and proactive usage alerts.

## Features

- Runs `amp usage --no-color` and parses Free + Individual balances.
- Auto refresh on `session.start` and `agent.end`.
- Threshold alerts for Amp Free balance at `$8`, `$5`, `$2`, `$1`.
- One-time alert when Individual balance becomes negative.
- Periodic summary notification every 10 minutes when values changed.
- Command palette actions:
  - `Usage Monitor: Show usage now`
  - `Usage Monitor: Open usage settings`

## Install

```bash
mkdir -p ~/.amp/plugins
cp plugins/usage-monitor/usage-monitor.ts ~/.amp/plugins/
PLUGINS=all amp
```

## Notes

- This plugin uses notifications instead of status-line rendering.
- Reason: public plugin API currently has no stable status-line surface in `ctx.ui`.
