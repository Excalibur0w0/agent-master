#!/bin/sh
# Claude Code hook for agent-master. `am start --kind claude` registers it via
# --settings; it records the agent's lifecycle on its tmux pane as @am_* options.
[ -n "${TMUX_PANE:-}" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
# Debugging aid: `am start --env AM_HOOK_LOG=/path/to/file` appends every raw hook input there.
[ -n "${AM_HOOK_LOG:-}" ] && printf '%s\n' "$input" >> "$AM_HOOK_LOG"

eval "$(printf '%s' "$input" | jq -r '@sh "ev=\(.hook_event_name // "") sid=\(.session_id // "") tp=\(.transcript_path // "") turn=\(.prompt_id // "") aid=\(.agent_id // "") tool=\(.tool_name // "") nt=\(.notification_type // "") src=\(.source // "")"' 2>/dev/null)" || exit 0

# Subagents (including Claude's own background helpers) carry agent_id and
# must never change the pane's state.
[ -z "$aid" ] || exit 0

p=$TMUX_PANE
now=$(date +%s)
# tmux drops a trailing ";" from an argument unless it is escaped.
esc() { case $1 in *\;) printf '%s\\;' "${1%;}" ;; *) printf '%s' "$1" ;; esac; }
# Permission requests carry no tool_use_id, so a request and the tool's completion
# are paired by a checksum of tool name + input (digits only: safe in a tmux format).
ident=
case "$ev" in
  PreToolUse | PermissionRequest | PostToolUse | PostToolUseFailure)
    ident=$(printf '%s' "$input" | jq -c --arg tool "$tool" '[.tool_name // "", (.tool_input // null)] | walk(if type == "object" then (to_entries | sort_by(.key) | from_entries) else . end)' | cksum | tr ' ' '-') ;;
esac

set -- set-option -p -t "$p" @am_event "$ev"
case "$ev" in
  SessionStart)
    set -- "$@" \; set-option -p -t "$p" @am_session "$(esc "$sid")" \; set-option -p -t "$p" @am_transcript "$(esc "$tp")"
    # Auto-compaction restarts the session mid-turn; only real starts mean idle.
    [ "$src" = compact ] || set -- "$@" \; set-option -p -t "$p" @am_state idle \; set-option -p -t "$p" @am_detail "" \
      \; set-option -p -t "$p" @am_pending "" \; set-option -p -t "$p" @am_ts "$now" ;;
  UserPromptSubmit)
    # Where this turn starts in the transcript: reads and interrupt checks only scan past it.
    offset=0
    [ -f "$tp" ] && offset=$(wc -c < "$tp" | tr -d ' ')
    # @am_seq only ever moves here, so `am prompt` can tell its prompt was accepted.
    set -- "$@" \; set-option -p -t "$p" @am_state working \; set-option -p -t "$p" @am_detail "" \
      \; set-option -p -t "$p" @am_pending "" \; set-option -p -t "$p" @am_ts "$now" \
      \; set-option -p -t "$p" @am_turn "$(esc "$turn")" \; set-option -p -t "$p" @am_offset "$offset" \
      \; set-option -p -t "$p" @am_transcript "$(esc "$tp")" \; set-option -p -F -t "$p" @am_seq '#{e|+:#{@am_seq},1}' ;;
  PreToolUse | PermissionRequest)
    # PreToolUse is registered only for tools that wait on the user.
    set -- "$@" \; set-option -p -t "$p" @am_state blocked \; set-option -p -t "$p" @am_detail "$(esc "$tool")" \
      \; set-option -p -t "$p" @am_pending "$ident" \; set-option -p -t "$p" @am_ts "$now" ;;
  PostToolUse | PostToolUseFailure)
    # A parallel tool finishing must not hide a permission dialog that is still open:
    # leave "blocked" only when the tool that asked (same name and input) is the one that finished.
    set -- "$@" \; if-shell -F -t "$p" "#{||:#{!=:#{@am_state},blocked},#{==:#{@am_pending},$ident}}" \
      "set-option -p -t $p @am_state working ; set-option -p -t $p @am_detail '' ; set-option -p -t $p @am_pending '' ; set-option -p -t $p @am_ts $now" ;;
  Stop | StopFailure | Notification | SessionEnd)
    case "$ev" in
      Notification) [ "$nt" = idle_prompt ] || exit 0; state=idle ;;
      SessionEnd) state=exited ;;
      *) state=idle ;;
    esac
    set -- "$@" \; set-option -p -t "$p" @am_state "$state" \; set-option -p -t "$p" @am_detail "" \
      \; set-option -p -t "$p" @am_pending "" \; set-option -p -t "$p" @am_ts "$now" ;;
esac
exec tmux "$@"
