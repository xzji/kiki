import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export function normalizeSelectedPath(path: string) {
  const trimmed = path.trim();
  if (trimmed === "/") return trimmed;
  return trimmed.replace(/\/+$/, "");
}

export type DirectoryPickResult = { path: string } | { canceled: true };

/** macOS 原生目录选择器；仅在本机（daemon 或本地 dev server）调用。 */
export async function pickDirectoryWithOsascript(): Promise<DirectoryPickResult> {
  if (process.platform !== "darwin") {
    throw new Error("当前系统不支持原生目录选择器，请手动输入路径");
  }
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      [
        "-e",
        'set selectedFolder to choose folder with prompt "选择 KiKi Runtime 工作目录"',
        "-e",
        "POSIX path of selectedFolder",
      ],
      {
        timeout: 5 * 60 * 1000,
        maxBuffer: 1024 * 1024,
      },
    );
    return { path: normalizeSelectedPath(stdout) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "目录选择失败";
    if (message.includes("User canceled")) {
      return { canceled: true };
    }
    throw error;
  }
}
