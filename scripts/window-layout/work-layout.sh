#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Work Layout
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🖥️

# Documentation:
# @raycast.description ウルトラワイドを2x3で分割: Slack 左上 / ブラウザ 左下 / Ghostty 右2/3
# @raycast.author akgw
# @raycast.authorURL https://raycast.com/akgw

BROWSER="Google Chrome"  # Arc を使うなら "Arc" に変更

place() {
  open -a "$1"
  sleep 0.4
  open -g "raycast://extensions/raycast/window-management/$2"
  sleep 0.4
}

place "Slack"    "top-left-sixth"
place "$BROWSER" "bottom-left-sixth"
place "Ghostty"  "last-two-thirds"
