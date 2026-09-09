# Claude Sessions

Claude Code のセッション状態をメニューバーに表示する Raycast 拡張。

表示: `🚨承認待ち 🏃‍➡️実行中 🏁完了` の件数。メニューを開くとセッション一覧、クリックでそのセッションが動いているウィンドウ/タブへ切り替え。

## Setup

### 1. hook

```bash
mkdir -p ~/.claude/hooks/claude-sessions
cp hooks/update-state.sh ~/.claude/hooks/claude-sessions/update-state.sh
```

`~/.claude/settings.json` の `hooks` に以下を追加（`UserPromptSubmit` / `Notification` / `Stop` / `SessionEnd` / `SubagentStop` は matcher なし、`PreToolUse` は matcher `Agent`）。

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/claude-sessions/update-state.sh" }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/claude-sessions/update-state.sh" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/claude-sessions/update-state.sh" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/claude-sessions/update-state.sh" }] }],
    "SubagentStop":     [{ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/claude-sessions/update-state.sh" }] }],
    "PreToolUse":       [{ "matcher": "Agent", "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/claude-sessions/update-state.sh" }] }]
  }
}
```

状態は `~/.claude/raycast-sessions/state.json` に書かれる。

### 2. extension

```bash
npm install
npx ray develop
```

Raycast で「Claude Sessions」を実行するとメニューバーに常駐する（10 秒間隔で更新）。

### 3. 設定

Raycast の拡張設定「ターミナルアプリ」で Claude Code を動かしているアプリを選ぶ（既定: Visual Studio Code）。VS Code はウィンドウ、iTerm2 / Terminal はタブまで切り替える（初回に Raycast の Automation 権限ダイアログが出る）。それ以外のアプリは前面化のみ。

## Development

```bash
npx ray lint
npx ray build -e dist
```
