# usage-stats

A Claude Code mod that shows your usage in a pane beside the chat: total tokens with a daily trend, active days, your current and best streak, peak hour, favorite model, and a contribution grid of the last 26 weeks. Switch between all time, the last 30 days and the last 7 days.

In the Claude desktop app the pane opens on its own when a session starts. In a terminal, run `/usage-stats` to open it.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install usage-stats --marketplace kuroega/claude-usage-stats
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```bash
claude plugin install usage-stats --marketplace kuroega/claude-usage-stats
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `kuroega/claude-usage-stats`, then **Add plugin**.

## How it works

The mod reads the session transcripts Claude Code keeps on your machine, under `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`). A small `awk` script (`scripts/scan.awk`) reduces each transcript to hourly totals, and those totals are cached by each file's modification time, so only transcripts that changed are read again. The stats refresh after every turn.

Nothing leaves your machine: the mod reads local files and draws the pane, and makes no network requests.

- **Total tokens** count input, output and cache tokens.
- **Messages** are model replies plus your own prompts.
- **Streak** is the run of consecutive days with activity, ending today (or yesterday, before today's first message).

Requires macOS or another system with `/usr/bin/awk`.
