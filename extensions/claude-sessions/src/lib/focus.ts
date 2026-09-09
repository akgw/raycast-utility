import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { getPreferenceValues, type Application } from "@raycast/api";
import type { SessionEntry } from "./state";

/** 設定「ターミナルアプリ」。未設定なら VS Code 扱い。 */
interface Preferences {
  terminalApp?: Application;
}

type TerminalKind = "vscode" | "vscode-insiders" | "iterm2" | "terminal" | "other";

interface TerminalApp {
  name: string;
  /** `open -a` に渡す値。path があれば path、無ければ name */
  openTarget: string;
  kind: TerminalKind;
}

export interface FocusResult {
  ok: boolean;
  /** HUD に出す文言。undefined なら何も出さない */
  message?: string;
}

const AUTOMATION_HINT = "システム設定 > プライバシーとセキュリティ > オートメーション";

function detectKind(app: Application | undefined): TerminalKind {
  const bundleId = app?.bundleId ?? "";
  const name = (app?.name ?? "").toLowerCase();
  if (bundleId === "com.microsoft.VSCodeInsiders" || name.includes("insiders")) return "vscode-insiders";
  if (bundleId === "com.microsoft.VSCode" || name === "visual studio code" || name === "code") return "vscode";
  if (bundleId === "com.googlecode.iterm2" || name.startsWith("iterm")) return "iterm2";
  if (bundleId === "com.apple.Terminal" || name === "terminal" || name === "ターミナル") return "terminal";
  return "other";
}

function terminalApp(): TerminalApp {
  const app = getPreferenceValues<Preferences>().terminalApp;
  if (!app) return { name: "Visual Studio Code", openTarget: "Visual Studio Code", kind: "vscode" };
  return { name: app.name, openTarget: app.path || app.name, kind: detectKind(app) };
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf-8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message));
      else resolve(stdout);
    });
  });
}

async function openApp(target: string, ...args: string[]): Promise<void> {
  await run("/usr/bin/open", ["-a", target, ...args]);
}

// ---------------------------------------------------------------------------
// VS Code: storage.json に記録された「開いているウィンドウ」のフォルダと cwd を照合する

interface OpenedWindow {
  /** ウィンドウのルートフォルダ。マルチルートワークスペースなら .code-workspace ファイルのパス */
  target: string;
  /** cwd との前方一致判定に使うフォルダ群 */
  folders: string[];
}

function vscodeStoragePath(kind: TerminalKind): string {
  const dir = kind === "vscode-insiders" ? "Code - Insiders" : "Code";
  return path.join(os.homedir(), "Library", "Application Support", dir, "User", "globalStorage", "storage.json");
}

function fileUriToPath(uri: string): string | null {
  try {
    return uri.startsWith("file://") ? fileURLToPath(uri) : null;
  } catch {
    return null;
  }
}

function workspaceFolders(configPath: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { folders?: { path?: string }[] };
    const base = path.dirname(configPath);
    return (parsed.folders ?? [])
      .map((f) => f.path)
      .filter((p): p is string => typeof p === "string")
      .map((p) => (path.isAbsolute(p) ? p : path.resolve(base, p)));
  } catch {
    return [];
  }
}

/** VS Code が状態を書き出すタイミング次第で多少古い場合がある。読めなければ空配列。 */
function listVSCodeWindows(kind: TerminalKind): OpenedWindow[] {
  try {
    const raw = JSON.parse(fs.readFileSync(vscodeStoragePath(kind), "utf-8")) as {
      windowsState?: { openedWindows?: { folder?: string; workspace?: { configPath?: string } }[] };
    };
    const windows: OpenedWindow[] = [];
    for (const w of raw.windowsState?.openedWindows ?? []) {
      const folder = w.folder ? fileUriToPath(w.folder) : null;
      if (folder) {
        windows.push({ target: folder, folders: [folder] });
        continue;
      }
      const configPath = w.workspace?.configPath ? fileUriToPath(w.workspace.configPath) : null;
      if (configPath) windows.push({ target: configPath, folders: workspaceFolders(configPath) });
    }
    return windows;
  } catch {
    return [];
  }
}

function isInside(cwd: string, folder: string): boolean {
  const rel = path.relative(folder, cwd);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** cwd を含むウィンドウのうち、最も深いフォルダで一致するものを返す */
function findVSCodeWindow(cwd: string, windows: OpenedWindow[]): OpenedWindow | null {
  let best: { window: OpenedWindow; depth: number } | null = null;
  for (const window of windows) {
    for (const folder of window.folders) {
      if (!isInside(cwd, folder)) continue;
      const depth = folder.split(path.sep).length;
      if (!best || depth > best.depth) best = { window, depth };
    }
  }
  return best?.window ?? null;
}

/** 既に開いているフォルダを `open -a` で渡すと VS Code は既存ウィンドウを前面化するだけで、新しいウィンドウは増えない */
async function focusVSCode(app: TerminalApp, cwd: string): Promise<FocusResult> {
  const target = findVSCodeWindow(cwd, listVSCodeWindows(app.kind));
  if (!target) return { ok: false, message: `該当ウィンドウなし: ${path.basename(cwd)}` };
  try {
    await openApp(app.openTarget, target.target);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `${app.name} を開けませんでした: ${(error as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// iTerm2 / Terminal.app: claude プロセスの tty と一致するタブを AppleScript で選択する

async function ttyOfPid(pid: number | undefined): Promise<string | null> {
  if (pid === undefined) return null;
  try {
    const out = (await run("/bin/ps", ["-o", "tty=", "-p", String(pid)])).trim();
    return out && out !== "??" ? `/dev/${out}` : null;
  } catch {
    return null;
  }
}

function isAutomationDenied(message: string): boolean {
  return /-1743|not authorized to send apple events|not allowed to send apple events|許可されていません/i.test(message);
}

async function runAppleScript(script: string): Promise<string> {
  return (await run("/usr/bin/osascript", ["-e", script])).trim();
}

function escapeAS(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 一致した tab/session を選択して前面化。"found" / "none" / "not-running" を返す */
function selectByTtyScript(kind: TerminalKind, tty: string): string {
  const t = escapeAS(tty);
  if (kind === "iterm2") {
    return `
      if application "iTerm2" is not running then return "not-running"
      tell application "iTerm2"
        repeat with w in windows
          repeat with tb in tabs of w
            repeat with s in sessions of tb
              if tty of s is "${t}" then
                select s
                select tb
                select w
                activate
                return "found"
              end if
            end repeat
          end repeat
        end repeat
      end tell
      return "none"`;
  }
  return `
    if application "Terminal" is not running then return "not-running"
    tell application "Terminal"
      repeat with w in windows
        repeat with tb in tabs of w
          if tty of tb is "${t}" then
            set selected of tb to true
            set frontmost of w to true
            activate
            return "found"
          end if
        end repeat
      end repeat
    end tell
    return "none"`;
}

/** 開いている全 tab/session の tty を改行区切りで返す */
function listTtysScript(kind: TerminalKind): string {
  if (kind === "iterm2") {
    return `
      if application "iTerm2" is not running then return "not-running"
      set out to ""
      tell application "iTerm2"
        repeat with w in windows
          repeat with tb in tabs of w
            repeat with s in sessions of tb
              set out to out & (tty of s) & linefeed
            end repeat
          end repeat
        end repeat
      end tell
      return out`;
  }
  return `
    if application "Terminal" is not running then return "not-running"
    set out to ""
    tell application "Terminal"
      repeat with w in windows
        repeat with tb in tabs of w
          set out to out & (tty of tb) & linefeed
        end repeat
      end repeat
    end tell
    return out`;
}

function automationMessage(app: TerminalApp): string {
  return `Raycast に ${app.name} の Automation 権限が必要です(${AUTOMATION_HINT})`;
}

async function focusTerminalTab(app: TerminalApp, session: SessionEntry): Promise<FocusResult> {
  const tty = await ttyOfPid(session.pid);
  const folder = path.basename(session.cwd);
  if (!tty) return { ok: false, message: `該当タブなし: ${folder}` };
  try {
    const result = await runAppleScript(selectByTtyScript(app.kind, tty));
    if (result === "found") return { ok: true };
    if (result === "not-running") return { ok: false, message: `${app.name} が起動していません` };
    return { ok: false, message: `該当タブなし: ${folder}` };
  } catch (error) {
    const message = (error as Error).message;
    if (isAutomationDenied(message)) return { ok: false, message: automationMessage(app) };
    return { ok: false, message: `${app.name} の操作に失敗: ${message}` };
  }
}

// ---------------------------------------------------------------------------

/** セッションが動いているウィンドウ/タブへ切り替える。切り替え先は設定「ターミナルアプリ」の種別で決める。 */
export async function focusSessionWindow(session: SessionEntry): Promise<FocusResult> {
  const app = terminalApp();
  switch (app.kind) {
    case "vscode":
    case "vscode-insiders":
      return focusVSCode(app, session.cwd);
    case "iterm2":
    case "terminal":
      return focusTerminalTab(app, session);
    default:
      try {
        await openApp(app.openTarget);
        return { ok: true, message: `${app.name} を前面化しました(タブ切り替え非対応)` };
      } catch (error) {
        return { ok: false, message: `${app.name} を開けませんでした: ${(error as Error).message}` };
      }
  }
}

/**
 * 対応するウィンドウ/タブが見つからないセッションの ID を返す。
 * 判定できないアプリ(タブ情報を取れない)や権限エラーのときは null と理由を返す。
 */
export async function findSessionsWithoutWindow(
  sessions: SessionEntry[],
): Promise<{ ids: string[] } | { ids: null; message: string }> {
  const app = terminalApp();
  if (app.kind === "vscode" || app.kind === "vscode-insiders") {
    const windows = listVSCodeWindows(app.kind);
    return { ids: sessions.filter((s) => findVSCodeWindow(s.cwd, windows) === null).map((s) => s.id) };
  }
  if (app.kind === "iterm2" || app.kind === "terminal") {
    let openTtys: Set<string>;
    try {
      const out = await runAppleScript(listTtysScript(app.kind));
      if (out === "not-running") return { ids: null, message: `${app.name} が起動していません` };
      openTtys = new Set(
        out
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } catch (error) {
      const message = (error as Error).message;
      return { ids: null, message: isAutomationDenied(message) ? automationMessage(app) : message };
    }
    const ids: string[] = [];
    for (const s of sessions) {
      const tty = await ttyOfPid(s.pid);
      if (!tty || !openTtys.has(tty)) ids.push(s.id);
    }
    return { ids };
  }
  return { ids: null, message: `${app.name} ではウィンドウの有無を判定できません` };
}
