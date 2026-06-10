import fs from "fs";
import path from "path";

import type { RuntimeStreamEvent } from "@/lib/server/claude/transport";

const MAX_STREAM_FILE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function isPathInsideDirectory(parentDir: string, targetPath: string) {
  const parent = path.resolve(parentDir);
  const target = path.resolve(targetPath);
  return target === parent || target.startsWith(`${parent}${path.sep}`);
}

function inferMimeFromFilename(filename: string) {
  const ext = path.extname(filename).toLowerCase();
  const mimeByExt: Record<string, string> = {
    ".csv": "text/csv; charset=utf-8",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".svg": "image/svg+xml",
    ".text": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
  };
  return mimeByExt[ext] ?? "application/octet-stream";
}

const SNAPSHOT_MAX_FILES = 5000;

/**
 * 扫描 workspace 顶层（非递归）的普通文件，返回 Map<绝对路径, mtimeMs:size 指纹>。
 *
 * 仅扫描根目录顶层：脚本生成的「最终产出物」按惯例写在工作区根目录，
 * 而临时/中间/构建/日志文件通常落在子目录；只看顶层可有效过滤噪音，
 * 避免把非交付物以附件形式刷屏。
 */
export function snapshotWorkspaceFiles(cwd: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const root = path.resolve(cwd);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return snapshot;
  }
  for (const entry of entries) {
    if (snapshot.size >= SNAPSHOT_MAX_FILES) break;
    if (entry.name.startsWith(".")) continue;
    if (!entry.isFile()) continue;
    const fullPath = path.join(root, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      snapshot.set(fullPath, `${stat.mtimeMs}:${stat.size}`);
    } catch {
      // ignore unreadable file
    }
  }
  return snapshot;
}

export function diffWorkspaceFiles(cwd: string, before: Map<string, string>): string[] {
  const after = snapshotWorkspaceFiles(cwd);
  const changed: string[] = [];
  for (const [filePath, fingerprint] of Array.from(after)) {
    if (before.get(filePath) !== fingerprint) {
      changed.push(filePath);
    }
  }
  return changed;
}

export function emitRuntimeFileEvents(input: {
  cwd: string;
  filePaths: Iterable<string>;
  emitEvent: (event: RuntimeStreamEvent) => boolean;
  appendDiagnostic?: (message: string) => void;
}) {
  for (const rawFilePath of Array.from(input.filePaths)) {
    try {
      const filePath = path.resolve(input.cwd, rawFilePath);
      if (!isPathInsideDirectory(input.cwd, filePath)) {
        input.appendDiagnostic?.(`跳过会话工作区外的文件附件：${rawFilePath}\n`);
        continue;
      }
      if (!fs.existsSync(filePath)) {
        input.appendDiagnostic?.(`跳过不存在的文件附件：${rawFilePath}\n`);
        continue;
      }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_STREAM_FILE_ATTACHMENT_BYTES) {
        input.appendDiagnostic?.(`跳过超过 10MB 的文件附件：${rawFilePath}\n`);
        continue;
      }
      const buffer = fs.readFileSync(filePath);
      const filename = path.basename(filePath);
      if (
        !input.emitEvent({
          type: "file",
          filename,
          mime: inferMimeFromFilename(filename),
          size: buffer.length,
          contentBase64: buffer.toString("base64"),
          summary: `已生成文件 ${filename}`,
        })
      ) {
        return false;
      }
    } catch (error) {
      input.appendDiagnostic?.(
        `读取文件附件失败 ${rawFilePath}：${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  return true;
}
