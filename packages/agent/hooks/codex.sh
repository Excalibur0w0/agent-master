#!/bin/sh
# Codex hook for agent-master. `am start --kind codex` registers it with -c
# overrides; it records the agent's lifecycle on its tmux pane as @am_* options.
[ -n "${TMUX_PANE:-}" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
# Debugging aid: `am start --env AM_HOOK_LOG=/path/to/file` appends every raw hook input there.
[ -n "${AM_HOOK_LOG:-}" ] && printf '%s\n' "$input" >> "$AM_HOOK_LOG"

eval "$(printf '%s' "$input" | jq -r '@sh "ev=\(.hook_event_name // "") sid=\(.session_id // "") tp=\(.transcript_path // "") turn=\(.turn_id // "") aid=\(.agent_id // "") tool=\(.tool_name // "")"' 2>/dev/null)" || exit 0

# Events from Codex's own subagents must not change the parent pane. Codex
# documents agent_id only for SubagentStart/Stop; if it is absent elsewhere,
# subagent turns can still leak through (see README "已知限制").
[ -z "$aid" ] || exit 0

p=$TMUX_PANE
now=$(date +%s)
esc() { case $1 in *\;) printf '%s\\;' "${1%;}" ;; *) printf '%s' "$1" ;; esac; }
# Permission requests carry no tool_use_id, so a request and the tool's completion
# are paired by a checksum of tool name + input (digits only: safe in a tmux format).
# For Bash, Codex adds tool_input.description (the approval prompt) to PermissionRequest
# only; other tools keep it, preferring a missed pairing (stays blocked until Stop)
# over clearing the wrong request.
ident=
case "$ev" in
  PreToolUse | PermissionRequest | PostToolUse | PostToolUseFailure)
    ident=$(printf '%s' "$input" | jq -c --arg tool "$tool" '[.tool_name // "", (.tool_input // null | if $tool == "Bash" and type == "object" then del(.description) else . end)] | walk(if type == "object" then (to_entries | sort_by(.key) | from_entries) else . end)' | cksum | tr ' ' '-') ;;
esac

set -- set-option -p -t "$p" @am_event "$ev"
case "$ev" in
  SessionStart)
    # Arrives lazily with the first prompt, so it only records identity.
    set -- "$@" \; set-option -p -t "$p" @am_session "$(esc "$sid")" \; set-option -p -t "$p" @am_transcript "$(esc "$tp")" ;;
  UserPromptSubmit)
    offset=0
    [ -f "$tp" ] && offset=$(wc -c < "$tp" | tr -d ' ')
    set -- "$@" \; set-option -p -t "$p" @am_state working \; set-option -p -t "$p" @am_detail "" \
      \; set-option -p -t "$p" @am_pending "" \; set-option -p -t "$p" @am_ts "$now" \
      \; set-option -p -t "$p" @am_turn "$(esc "$turn")" \; set-option -p -t "$p" @am_offset "$offset" \
      \; set-option -p -t "$p" @am_session "$(esc "$sid")" \; set-option -p -t "$p" @am_transcript "$(esc "$tp")" \
      \; set-option -p -F -t "$p" @am_seq '#{e|+:#{@am_seq},1}' ;;
  PermissionRequest)
    set -- "$@" \; set-option -p -t "$p" @am_state blocked \; set-option -p -t "$p" @am_detail "$(esc "$tool")" \
      \; set-option -p -t "$p" @am_pending "$ident" \; set-option -p -t "$p" @am_ts "$now" ;;
  PostToolUse)
    set -- "$@" \; if-shell -F -t "$p" "#{||:#{!=:#{@am_state},blocked},#{==:#{@am_pending},$ident}}" \
      "set-option -p -t $p @am_state working ; set-option -p -t $p @am_detail '' ; set-option -p -t $p @am_pending '' ; set-option -p -t $p @am_ts $now" ;;
  Stop | Interrupt | SessionEnd)
    case "$ev" in
      Interrupt) state=idle detail=interrupted ;;
      SessionEnd) state=exited detail= ;;
      *) state=idle detail= ;;
    esac
    set -- "$@" \; set-option -p -t "$p" @am_state "$state" \; set-option -p -t "$p" @am_detail "$detail" \
      \; set-option -p -t "$p" @am_pending "" \; set-option -p -t "$p" @am_ts "$now" ;;
esac
exec tmux "$@"
