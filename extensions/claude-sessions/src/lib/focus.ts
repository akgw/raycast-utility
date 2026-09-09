import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import type { SessionEntry } from "./state";

const VSCODE_APP = "Visual Studio Code";
const VSCODE_STORAGE = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Code",
  "User",
  "globalStorage",
  "storage.json",
);

interface OpenedWindow {
  /** ウィンドウのルートフォルダ。マルチルートワークスペースなら .code-workspace ファイルのパス */
  target: string;
  /** cwd との前方一致判定に使うフォルダ群 */
  folders: string[];
}

function fileUriToPath(uri: string): string | null {
  try {
    return uri.startsWith("file://") ? fileURLToPath(uri) : null;
  } catch {
    return null;
  }
}

/** .code-workspace ファイルからフォルダ一覧を読む。読めなければ空。 */
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

/**
 * VS Code が開いているウィンドウ一覧を storage.json から読む。
 * VS Code が状態を書き出すタイミング次第で多少古い場合がある。読めなければ空配列。
 */
function listOpenedWindows(): OpenedWindow[] {
  try {
    const raw = JSON.parse(fs.readFileSync(VSCODE_STORAGE, "utf-8")) as {
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
      if (configPath) {
        windows.push({ target: configPath, folders: workspaceFolders(configPath) });
      }
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

/** cwd を含むウィンドウのうち、最も深いフォルダで一致するものを返す。見つからなければ null。 */
function findWindowForCwd(cwd: string, windows: OpenedWindow[]): OpenedWindow | null {
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

function openInVSCode(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", ["-a", VSCODE_APP, target], (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * cwd を開いている VS Code ウィンドウを前面化し、成功したかを返す。
 * 既に開いているフォルダを `open -a` で渡すと VS Code は既存ウィンドウを前面化するだけなので、
 * 新しいウィンドウは増えない。該当ウィンドウが無ければ何もしない。
 */
export async function focusVSCodeWindow(cwd: string): Promise<boolean> {
  const target = findWindowForCwd(cwd, listOpenedWindows());
  if (!target) return false;
  try {
    await openInVSCode(target.target);
    return true;
  } catch {
    return false;
  }
}

/** 対応する VS Code ウィンドウが見つからないセッションの ID を返す */
export function findSessionsWithoutWindow(sessions: SessionEntry[]): string[] {
  const windows = listOpenedWindows();
  return sessions.filter((s) => findWindowForCwd(s.cwd, windows) === null).map((s) => s.id);
}
