import { useCallback, useState } from "react";
import { Icon, MenuBarExtra, showHUD } from "@raycast/api";
import { findSessionsWithoutWindow, focusVSCodeWindow } from "./lib/focus";
import { STATUS_COLOR, STATUS_ICON, STATUS_LABEL, displayTitle, folderNameOf, formatRelativeTime } from "./lib/format";
import { buildMenuBarTitle } from "./lib/menubar-title";
import { ALL_STATUSES, countByStatus, readSessions, removeSessions, type SessionEntry } from "./lib/state";

async function focusSession(session: SessionEntry): Promise<void> {
  if (!(await focusVSCodeWindow(session.cwd))) {
    await showHUD(`該当ウィンドウなし: ${folderNameOf(session)}`);
  }
}

async function removeSessionsWithoutWindow(sessions: SessionEntry[]): Promise<void> {
  const ids = findSessionsWithoutWindow(sessions);
  if (ids.length === 0) {
    await showHUD("削除対象なし");
    return;
  }
  const removed = removeSessions(ids);
  await showHUD(`${removed} 件のセッションを削除しました`);
}

export default function MenuBarCommand() {
  const [sessions, setSessions] = useState<SessionEntry[]>(() => readSessions());
  const reload = useCallback(() => setSessions(readSessions()), []);

  const counts = countByStatus(sessions);
  const tooltip = ALL_STATUSES.map((s) => `${STATUS_LABEL[s]} ${counts[s]}`).join(" / ");

  return (
    <MenuBarExtra title={buildMenuBarTitle(counts)} tooltip={`Claude Sessions: ${tooltip}`}>
      {sessions.length === 0 && <MenuBarExtra.Item title="Claude Codeセッションなし" />}
      {ALL_STATUSES.map((status) => {
        const items = sessions.filter((s) => s.status === status);
        if (items.length === 0) return null;
        return (
          <MenuBarExtra.Section key={status} title={`${STATUS_LABEL[status]} (${items.length})`}>
            {items.map((session) => (
              <MenuBarExtra.Item
                key={session.id}
                icon={{ source: STATUS_ICON[status], tintColor: STATUS_COLOR[status] }}
                title={displayTitle(session)}
                subtitle={formatRelativeTime(session.updatedAt)}
                tooltip={session.cwd}
                onAction={() => focusSession(session)}
              />
            ))}
          </MenuBarExtra.Section>
        );
      })}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item title="再読み込み" icon={Icon.ArrowClockwise} onAction={reload} />
        <MenuBarExtra.Item
          title="ウィンドウが見つからないセッションを削除"
          icon={Icon.XMarkCircle}
          onAction={() => removeSessionsWithoutWindow(sessions).then(reload)}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
