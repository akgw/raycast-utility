#!/usr/bin/env bash
# Claude Code hook for the "claude-sessions" Raycast menu bar extension.
# Reads one hook-event JSON on stdin and updates state.json (default:
# ~/.claude/raycast-sessions/state.json, override with CLAUDE_SESSIONS_STATE_DIR).
#
# Registered events and what they do:
#   UserPromptSubmit  status=running, record lastPrompt
#   Notification      permission_prompt / elicitation_* / agent_needs_input -> status=waiting
#                     idle_prompt -> keep existing status/updatedAt untouched
#   Stop              status=done, or running while backgroundTasks > 0
#   PreToolUse[Agent] backgroundTasks += 1 (main thread only)
#   SubagentStop      backgroundTasks -= 1 (min 0)
#   SessionEnd        delete the entry
#
# Never blocks the hook chain: every path exits 0.
set -euo pipefail

STATE_DIR="${CLAUDE_SESSIONS_STATE_DIR:-$HOME/.claude/raycast-sessions}"
STATE_FILE="$STATE_DIR/state.json"
RETENTION_DAYS=7

# --- helpers -------------------------------------------------------------------

now_iso() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# $1: jq path expression on $INPUT, printed with -r ("" when missing)
input_field() { printf '%s' "$INPUT" | jq -r "$1 // \"\""; }

# $1: jq filter applied to state.json; remaining args are passed to jq (--arg etc.)
write_state() {
  local filter="$1" tmp
  shift
  tmp=$(mktemp "${STATE_DIR}/state.json.XXXXXX")
  if jq "$@" "$filter" "$STATE_FILE" > "$tmp"; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
  fi
}

# jq definitions shared by title/prompt cleanup: drop UI noise the user never typed.
JQ_CLEAN='
  def clean:
    gsub("\\[Image #[0-9]+\\]"; "")
    | gsub("<command-message>[^<]*</command-message>"; "")
    | gsub("</?command-name>"; "")
    | gsub("</?command-args>"; "")
    | gsub("<local-command-[a-z-]+>[^<]*</local-command-[a-z-]+>"; "")
    | gsub("</?local-command-[a-z-]+>"; "")
    | gsub("\\s+"; " ")
    | ltrimstr(" ") | rtrimstr(" ")
    | .[0:200];
  def is_noise:
    test("^<task-notification>|^<system-reminder>");
'

# Walk up from our parent until the `claude` process shows up (hooks are spawned as
# claude -> sh -c -> bash script). Prints the PID, or nothing if not found.
resolve_claude_pid() {
  local pid="$PPID" cmd first second i
  for i in 1 2 3 4 5 6 7 8; do
    [ -z "$pid" ] || [ "$pid" -le 1 ] && return 0
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    [ -z "$cmd" ] && return 0
    first=$(printf '%s' "$cmd" | awk '{print $1}')
    second=$(printf '%s' "$cmd" | awk '{print $2}')
    if [ "${first##*/}" = "claude" ] || [ "${second##*/}" = "claude" ]; then
      printf '%s' "$pid"
      return 0
    fi
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
  done
}

# Sets STATUS and KEEP_STATUS (1 = do not overwrite existing status/updatedAt).
derive_status() {
  KEEP_STATUS=0
  case "$EVENT" in
    UserPromptSubmit) STATUS="running" ;;
    Stop)
      local bg
      bg=$(jq -r --arg sid "$SESSION_ID" '.sessions[$sid].backgroundTasks // 0' "$STATE_FILE")
      if [ "${bg:-0}" -gt 0 ]; then STATUS="running"; else STATUS="done"; fi ;;
    Notification)
      case "$NOTIFICATION_TYPE" in
        permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input) STATUS="waiting" ;;
        idle_prompt) STATUS="idle"; KEEP_STATUS=1 ;;
        "")
          # Older Claude Code without notification_type: fall back to the message text.
          if printf '%s' "$MESSAGE" | grep -qi "permission"; then STATUS="waiting"; else STATUS="idle"; KEEP_STATUS=1; fi ;;
        *) STATUS="idle" ;;
      esac ;;
    *) STATUS="idle" ;;
  esac
}

# The session title is the first real user message in the transcript. It never
# changes, so the (potentially large) transcript is read only until recorded.
extract_title() {
  local existing
  existing=$(jq -r --arg sid "$SESSION_ID" '.sessions[$sid].sessionTitle // empty' "$STATE_FILE")
  if [ -n "$existing" ]; then printf '%s' "$existing"; return 0; fi
  [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ] || return 0
  head -50 "$TRANSCRIPT_PATH" 2>/dev/null | jq -rs "$JQ_CLEAN"'
    [.[] | select(.type == "user" and ((.isMeta // false) != true) and (.message.role? == "user"))]
    | map(
        .message.content as $c
        | if ($c | type) == "string" then $c
          elif ($c | type) == "array" then ([$c[] | select(.type == "text") | .text] | join(" "))
          else empty end
      )
    | map(select(. != null and . != "" and (is_noise | not)) | clean)
    | map(select(. != ""))
    | (.[0] // "")
  ' 2>/dev/null || true
}

# Cleaned lastPrompt for UserPromptSubmit; empty for other events or noise.
extract_prompt() {
  [ "$EVENT" = "UserPromptSubmit" ] || return 0
  local prompt
  prompt=$(input_field '.prompt')
  [ -n "$prompt" ] || return 0
  printf '%s' "$prompt" | jq -Rrs "$JQ_CLEAN"' if is_noise then "" else clean end' 2>/dev/null || true
}

# --- event handlers ------------------------------------------------------------

handle_session_end() {
  write_state 'del(.sessions[$sid])' --arg sid "$SESSION_ID"
}

# Only Agent calls from the main thread count; a hook firing inside a subagent
# carries agent_id and is ignored so nested agents don't inflate the counter.
handle_pre_tool_use() {
  [ "$(input_field '.tool_name')" = "Agent" ] && [ -z "$(input_field '.agent_id')" ] || return 0
  write_state '
    .sessions[$sid] //= {} |
    .sessions[$sid].backgroundTasks = ((.sessions[$sid].backgroundTasks // 0) + 1) |
    .sessions[$sid].updatedAt = $now
  ' --arg sid "$SESSION_ID" --arg now "$(now_iso)"
}

handle_subagent_stop() {
  write_state '
    if .sessions[$sid] then
      .sessions[$sid].backgroundTasks = ([(.sessions[$sid].backgroundTasks // 0) - 1, 0] | max) |
      .sessions[$sid].updatedAt = $now
    else . end
  ' --arg sid "$SESSION_ID" --arg now "$(now_iso)"
}

# UserPromptSubmit / Notification / Stop: refresh the whole entry.
handle_status_event() {
  local claude_pid title prompt cutoff
  NOTIFICATION_TYPE=$(input_field '.notification_type')
  MESSAGE=$(input_field '.message')
  TRANSCRIPT_PATH=$(input_field '.transcript_path')
  derive_status
  claude_pid=$(resolve_claude_pid)
  title=$(extract_title)
  prompt=$(extract_prompt)
  cutoff=$(( $(date -u +%s) - RETENTION_DAYS * 24 * 60 * 60 ))

  write_state '
    .sessions[$sid] //= {} |
    .sessions[$sid].cwd = (if $cwd != "" then $cwd else .sessions[$sid].cwd end) |
    .sessions[$sid].backgroundTasks //= 0 |
    (if $keep == "1"
       then (.sessions[$sid].status //= $status | .sessions[$sid].updatedAt //= $now)
       else (.sessions[$sid].status = $status | .sessions[$sid].updatedAt = $now)
     end) |
    (if $pid != "" then .sessions[$sid].pid = ($pid | tonumber) else . end) |
    (if $prompt != "" then .sessions[$sid].lastPrompt = $prompt else . end) |
    (if $event == "Notification" and $ntype != "" then .sessions[$sid].lastNotificationType = $ntype else . end) |
    (if $event == "Notification" and $message != "" then .sessions[$sid].lastNotification = $message else . end) |
    (if $transcript != "" then .sessions[$sid].transcriptPath = $transcript else . end) |
    (if $title != "" then .sessions[$sid].sessionTitle = $title else . end) |
    .sessions |= with_entries(select((.value.updatedAt | fromdateiso8601? // 0) >= $cutoff))
  ' \
    --arg sid "$SESSION_ID" \
    --arg cwd "$CWD" \
    --arg status "$STATUS" \
    --arg keep "$KEEP_STATUS" \
    --arg pid "$claude_pid" \
    --arg prompt "$prompt" \
    --arg ntype "$NOTIFICATION_TYPE" \
    --arg message "$MESSAGE" \
    --arg now "$(now_iso)" \
    --arg event "$EVENT" \
    --arg transcript "$TRANSCRIPT_PATH" \
    --arg title "$title" \
    --argjson cutoff "$cutoff"
}

# --- main ----------------------------------------------------------------------

main() {
  INPUT=$(cat)
  EVENT=$(input_field '.hook_event_name')
  SESSION_ID=$(input_field '.session_id')
  CWD=$(input_field '.cwd')
  mkdir -p "$STATE_DIR"
  [ -n "$EVENT" ] && [ -n "$SESSION_ID" ] || return 0

  [ -f "$STATE_FILE" ] || echo '{"sessions":{}}' > "$STATE_FILE"

  case "$EVENT" in
    SessionEnd)   handle_session_end ;;
    PreToolUse)   handle_pre_tool_use ;;
    SubagentStop) handle_subagent_stop ;;
    *)            handle_status_event ;;
  esac
}

main
exit 0
