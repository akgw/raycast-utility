import { STATUS_EMOJI } from "./format";
import type { SessionStatus } from "./state";

/** title に出す status とその順序。待機中(idle)はほぼ発生しないため出さない。 */
const MENU_BAR_TITLE_STATUSES: SessionStatus[] = ["waiting", "running", "done"];

/** メニューバーの title。絵文字 + 件数を固定順で並べ、0 件も省略しない。例: "🚨1 🏃‍➡️0 🏁2" */
export function buildMenuBarTitle(counts: Record<SessionStatus, number>): string {
  return MENU_BAR_TITLE_STATUSES.map((s) => `${STATUS_EMOJI[s]}${counts[s]}`).join(" ");
}
