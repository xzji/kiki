import { execFile } from "child_process";
import { promisify } from "util";

import { NextResponse } from "next/server";

const execFileAsync = promisify(execFile);

function normalizeSelectedPath(path: string) {
  const trimmed = path.trim();
  if (trimmed === "/") return trimmed;
  return trimmed.replace(/\/+$/, "");
}

export async function POST() {
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

    return NextResponse.json({
      path: normalizeSelectedPath(stdout),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "目录选择失败";
    const canceled = message.includes("User canceled");
    return NextResponse.json(
      {
        canceled,
        reason: canceled ? "已取消选择目录" : message,
      },
      { status: canceled ? 400 : 500 },
    );
  }
}
