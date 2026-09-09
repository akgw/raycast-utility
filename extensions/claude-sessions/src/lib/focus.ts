import { runAppleScript } from "@raycast/utils";
import os from "os";
import path from "path";
import type { SessionEntry } from "./state";

function escapeForAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * VS Code の全ウィンドウ名を返す。activate=true なら VS Code 自体も前面化する。
 * 取得できない(VS Code 未起動・権限なし等)場合は空配列。
 */
async function listVSCodeWindowNames(options: { activate?: boolean } = {}): Promise<string[]> {
  const script = `
    ${options.activate ? 'tell application "Visual Studio Code" to activate' : ""}
    tell application "System Events"
      if not (exists process "Code") then return ""
      tell process "Code"
        set windowNames to name of every window
      end tell
    end tell
    set AppleScript's text item delimiters to linefeed
    return windowNames as text
  `;
  try {
    const out = await runAppleScript(script);
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/**
 * cwd の basename を上位ディレクトリ方向に辿り、ウィンドウ名に含まれる最初のものを返す。
 * ~/Dev/foo/bar/baz なら baz → bar → foo の順。$HOME と / は候補にしない。見つからなければ null。
 */
function findWindowForCwd(cwd: string, windowNames: string[]): string | null {
  const home = os.homedir();
  let current = cwd;
  for (let i = 0; i < 16; i++) {
    if (!current || current === "/" || current === home) return null;
    const segment = path.basename(current);
    if (segment) {
      const hit = windowNames.find((name) => name.includes(segment));
      if (hit) return hit;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** 該当する VS Code ウィンドウを前面化し、成功したかを返す。見つからなければ VS Code を activate するだけ。 */
export async function focusVSCodeWindow(cwd: string): Promise<boolean> {
  const windowNames = await listVSCodeWindowNames({ activate: true });
  const target = findWindowForCwd(cwd, windowNames);
  if (!target) return false;

  const script = `
    tell application "System Events"
      tell process "Code"
        set targetWindow to first window whose name is "${escapeForAppleScript(target)}"
        perform action "AXRaise" of targetWindow
      end tell
    end tell
  `;
  try {
    await runAppleScript(script);
    return true;
  } catch {
    return false;
  }
}

/** 対応する VS Code ウィンドウが見つからないセッションの ID を返す(VS Code は前面化しない) */
export async function findSessionsWithoutWindow(sessions: SessionEntry[]): Promise<string[]> {
  const windowNames = await listVSCodeWindowNames();
  return sessions.filter((s) => findWindowForCwd(s.cwd, windowNames) === null).map((s) => s.id);
}
