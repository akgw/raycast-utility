import { Color, Icon } from "@raycast/api";
import path from "path";
import dayjs from "dayjs";
import type { SessionEntry, SessionStatus } from "./state";

export const STATUS_LABEL: Record<SessionStatus, string> = {
  waiting: "承認待ち",
  running: "実行中",
  done: "完了",
  idle: "待機中",
};

export const STATUS_COLOR: Record<SessionStatus, Color> = {
  waiting: Color.Red,
  running: Color.Blue,
  done: Color.Green,
  idle: Color.SecondaryText,
};

export const STATUS_ICON: Record<SessionStatus, Icon> = {
  waiting: Icon.ExclamationMark,
  running: Icon.Circle,
  done: Icon.Checkmark,
  idle: Icon.Clock,
};

/** メニューバーの title に使う絵文字。macOS のメニューバーは絵文字をカラーで描画する。 */
export const STATUS_EMOJI: Record<SessionStatus, string> = {
  waiting: "🚨",
  running: "🏃‍➡️",
  done: "🏁",
  idle: "⚪",
};

const TITLE_MAX_LEN = 35;

/**
 * ユーザーが打っていない UI ノイズ([Image #N] やスラッシュコマンドのタグ)を落とし、空白を正規化する。
 * hook 側(update-state.sh)の jq `clean` と同じルール。
 */
function cleanText(text: string | undefined, maxLen = 200): string {
  if (!text) return "";
  return text
    .replace(/\[Image #\d+\]/g, "")
    .replace(/<command-message>[^<]*<\/command-message>/g, "")
    .replace(/<\/?command-name>/g, "")
    .replace(/<\/?command-args>/g, "")
    .replace(/<local-command-[a-z-]+>[^<]*<\/local-command-[a-z-]+>/g, "")
    .replace(/<\/?local-command-[a-z-]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/** hook が拾ってしまうシステム由来のメッセージは表示に使わない */
function isNoise(text: string | undefined): boolean {
  if (!text) return true;
  return /^\s*(<task-notification>|<system-reminder>)/.test(text);
}

export function formatRelativeTime(iso: string): string {
  const diffSec = dayjs().diff(dayjs(iso), "second");
  if (diffSec < 5) return "たった今";
  if (diffSec < 60) return `${diffSec}秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}時間前`;
  return `${Math.floor(diffHour / 24)}日前`;
}

export function folderNameOf(session: SessionEntry): string {
  return path.basename(session.cwd) || session.cwd;
}

/** メニュー行のタイトル: フォルダ名 — セッションタイトル(35文字で省略) */
export function displayTitle(session: SessionEntry): string {
  const folder = folderNameOf(session);
  if (isNoise(session.sessionTitle)) return folder;
  const title = cleanText(session.sessionTitle);
  if (!title) return folder;
  const shortened = title.length <= TITLE_MAX_LEN ? title : `${title.slice(0, TITLE_MAX_LEN)}…`;
  return `${folder} — ${shortened}`;
}
