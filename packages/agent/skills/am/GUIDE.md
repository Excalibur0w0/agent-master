# am

The user explicitly asked you to coordinate other coding agents with `am`.{{REQUEST}} If it is unclear what to delegate, to which agent kind, or where, ask before starting anything.

`am` starts each coding agent in its own detached tmux session (`am-<name>`) and drives it. The user can open that session at any time (`am open <name>`, or `prefix + s` in tmux) and take over.

## Before you start

Run `am list`. If the command is not found, tell the user (`am install` in the agent-master repo sets it up) and stop. Reuse an idle agent you started earlier instead of starting another one.

Run every `am` command on its own, without pipes, `&&` or shell wrappers: users commonly allow only commands that start with `am`, and anything else stops for their approval.

After `am start`, tell the user the session name so they can watch it. Never run `am open` yourself: it switches the user's own terminal.

## Workflow

```bash
am start reviewer --kind codex                 # claude | codex | opencode; returns once it accepts input
am prompt reviewer - --wait --timeout 600000 <<'EOF'
Review the uncommitted changes in /path/to/repo. Report only actionable bugs, with file:line.
EOF
am read reviewer                               # its final message for that task
am stop reviewer                               # when you no longer need it
```

| Command | Purpose |
| --- | --- |
| `am start <name> --kind K [--cwd DIR] [--model M] [-- native args]` | Launch the agent in tmux session `am-<name>`. Default cwd is yours. |
| `am prompt <name> <text\|-> [--wait] [--timeout MS]` | Submit a task (`-` reads stdin). `--wait` returns once it is `idle` or `blocked`. |
| `am wait <name> [--until idle,blocked] [--timeout MS]` | Wait for a state. |
| `am status <name>` / `am list` | Current state; `detail` explains `blocked` (e.g. the command awaiting approval). |
| `am read <name>` | Final message of its latest turn. |
| `am interrupt <name>` | Stop its current turn. |
| `am approve <name>` / `am deny <name>` | Answer a pending permission request (see rules). |
| `am keys <name> <key>...` | Raw tmux keys (`Enter`, `Escape`, `C-c`) for UI the commands above do not cover. |
| `am stop <name>` | Close the agent and its session. |

Add `--json` to any command for machine-readable output. Names match `[a-z][a-z0-9_-]{0,31}`; a pane id such as `%12` also works.

States: `starting`, `idle` (ready for input), `working`, `blocked` (waiting for a human decision), `exited`, `unknown`.

## Rules

- **Give full context.** The other agent cannot see your conversation. State the goal, the paths, and the expected output format in the prompt.
- **Always pass `--timeout` with `--wait`.** Your own tool call has a time limit. On timeout the task may still be running: check `am status`, do not resend it.
- **Never approve or deny on the user's behalf.** When an agent is `blocked`, run `am status <name>`, tell the user what it is asking for, and let them decide (they can answer in the agent's session or tell you to run `am approve`/`am deny`). Only approve yourself if the user explicitly authorized that kind of action.
- **`prompt_stalled` means the agent did not confirm receipt.** Do not blindly resend; check `am status` and tell the user to look at the agent's session.
- **First start may need the user.** Claude asks once to trust a new folder, and Codex asks once to trust am's hooks. If `am start` warns about this or times out, ask the user to answer it in the agent's session (`am open <name>`).
- **Long results:** `am read` returns only the final message. For long output, ask the agent to write it to a file and read the file.
- **Only stop agents you started.** Each agent spends its own model quota; do not start more than the task needs.
