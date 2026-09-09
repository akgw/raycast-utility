import fs from "fs";
import os from "os";
import path from "path";
import dayjs from "dayjs";

/** hook(update-state.sh)が書き込むセッション状態ファイル */
export const STATE_FILE = path.join(os.homedir(), ".claude", "raycast-sessions", "state.json");

/** updatedAt と transcript mtime の新しい方がこの時間より古いセッションは表示しない */
const STALE_SESSION_MS = 60 * 60 * 1000;

export type SessionStatus = "waiting" | "running" | "done" | "idle";

export const ALL_STATUSES: SessionStatus[] = ["waiting", "running", "done", "idle"];

export interface SessionEntry {
  id: string;
  cwd: string;
  status: SessionStatus;
  pid?: number;
  backgroundTasks?: number;
  lastPrompt?: string;
  lastNotification?: string;
  lastNotificationType?: string;
  sessionTitle?: string;
  transcriptPath?: string;
  updatedAt: string;
}

interface RawSessionEntry extends Omit<SessionEntry, "id" | "status"> {
  status?: string;
}

interface StateFile {
  sessions?: Record<string, RawSessionEntry>;
}

/** 未知の status 値は idle として扱う */
function normalizeStatus(raw: string | undefined): SessionStatus {
  return (ALL_STATUSES as string[]).includes(raw ?? "") ? (raw as SessionStatus) : "idle";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 存在するが権限がない = 生きている。ESRCH = いない。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function transcriptMtimeMs(transcriptPath: string | undefined): number {
  if (!transcriptPath) return 0;
  try {
    return fs.statSync(transcriptPath).mtimeMs;
  } catch {
    return 0;
  }
}

function isRecent(session: SessionEntry): boolean {
  const updatedAtMs = dayjs(session.updatedAt).valueOf() || 0;
  const latest = Math.max(updatedAtMs, transcriptMtimeMs(session.transcriptPath));
  return Date.now() - latest < STALE_SESSION_MS;
}

/** claude プロセスが生きていて、直近1時間以内に動きのあるセッションだけを表示対象にする */
function isLiveSession(session: SessionEntry): boolean {
  if (session.pid !== undefined && !isProcessAlive(session.pid)) return false;
  return isRecent(session);
}

/** 表示対象のセッションを承認待ち > 実行中 > 完了 > 待機中、同順位は更新が新しい順で返す */
export function readSessions(stateFile: string = STATE_FILE): SessionEntry[] {
  if (!fs.existsSync(stateFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as StateFile;
    return Object.entries(parsed.sessions ?? {})
      .map(([id, entry]) => ({ ...entry, id, status: normalizeStatus(entry.status) }))
      .filter(isLiveSession)
      .sort(compareSessions);
  } catch {
    return [];
  }
}

function compareSessions(a: SessionEntry, b: SessionEntry): number {
  const statusDiff = ALL_STATUSES.indexOf(a.status) - ALL_STATUSES.indexOf(b.status);
  if (statusDiff !== 0) return statusDiff;
  return dayjs(b.updatedAt).valueOf() - dayjs(a.updatedAt).valueOf();
}

export function countByStatus(sessions: SessionEntry[]): Record<SessionStatus, number> {
  const counts: Record<SessionStatus, number> = { waiting: 0, running: 0, done: 0, idle: 0 };
  for (const session of sessions) counts[session.status] += 1;
  return counts;
}

/**
 * 指定 ID のセッションを state.json から削除し、削除できた件数を返す。
 * hook の書き込みと競合しにくいように、同ディレクトリの一時ファイルに書いてから rename で置き換える。
 */
export function removeSessions(ids: string[], stateFile: string = STATE_FILE): number {
  if (ids.length === 0 || !fs.existsSync(stateFile)) return 0;
  const parsed = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as StateFile;
  const sessions = parsed.sessions ?? {};
  const targets = ids.filter((id) => id in sessions);
  if (targets.length === 0) return 0;
  for (const id of targets) delete sessions[id];
  parsed.sessions = sessions;
  const tmpFile = path.join(path.dirname(stateFile), `.state.json.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpFile, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
  fs.renameSync(tmpFile, stateFile);
  return targets.length;
}
