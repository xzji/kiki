import { constants } from "fs";
import { access } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export function expandHomeDir(input: string) {
  if (!input.startsWith("~/")) return input;
  return `${process.env.HOME || ""}/${input.slice(2)}`;
}

export async function resolveCliPath(cliPath: string) {
  const normalized = expandHomeDir(cliPath || "claude");

  if (normalized.includes("/")) {
    await access(normalized, constants.X_OK);
    return normalized;
  }

  const { stdout } = await execFileAsync("which", [normalized]);
  return stdout.trim();
}

export function normalizeWorkingDirectory(path: string) {
  return expandHomeDir(path);
}
