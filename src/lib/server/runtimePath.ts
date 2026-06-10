import { constants } from "fs";
import os from "os";
import path from "path";
import { access, readFile, readdir } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const COMMAND_LOOKUP_TIMEOUT_MS = 5000;

export function expandHomeDir(input: string) {
  if (!input.startsWith("~/")) return input;
  return `${process.env.HOME || ""}/${input.slice(2)}`;
}

async function isExecutable(filePath: string) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function execTrimmed(command: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: COMMAND_LOOKUP_TIMEOUT_MS,
      maxBuffer: 128 * 1024,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

function pushExpandedDir(target: string[], dir?: string) {
  if (!dir?.trim()) return;
  target.push(path.resolve(expandHomeDir(dir.trim())));
}

function pushPathCandidate(target: string[], candidate?: string) {
  if (!candidate?.trim()) return;
  target.push(path.resolve(expandHomeDir(candidate.trim())));
}

async function readPackageBin(rootDir: string, packageName: string, command: string) {
  try {
    const packageJsonPath = path.join(rootDir, ...packageName.split("/"), "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const binPath = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.[command];
    return binPath ? path.resolve(path.dirname(packageJsonPath), binPath) : undefined;
  } catch {
    return undefined;
  }
}

async function collectPackageManagerBinDirs() {
  const dirs: string[] = [];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) pushExpandedDir(dirs, dir);

  const npmPrefix = await execTrimmed("npm", ["prefix", "-g"]);
  const npmRoot = await execTrimmed("npm", ["root", "-g"]);
  const pnpmBin = await execTrimmed("pnpm", ["bin", "-g"]);
  const pnpmRoot = await execTrimmed("pnpm", ["root", "-g"]);
  const yarnBin = await execTrimmed("yarn", ["global", "bin"]);
  const bunBin = await execTrimmed("bun", ["pm", "bin", "-g"]);

  pushExpandedDir(dirs, npmPrefix ? path.join(npmPrefix, "bin") : undefined);
  pushExpandedDir(dirs, npmRoot ? path.join(npmRoot, ".bin") : undefined);
  pushExpandedDir(dirs, pnpmBin);
  pushExpandedDir(dirs, pnpmRoot ? path.join(pnpmRoot, ".bin") : undefined);
  pushExpandedDir(dirs, yarnBin);
  pushExpandedDir(dirs, bunBin);

  pushExpandedDir(dirs, "~/.local/bin");
  pushExpandedDir(dirs, "~/.npm-global/bin");
  pushExpandedDir(dirs, "~/.yarn/bin");
  pushExpandedDir(dirs, "~/.bun/bin");
  pushExpandedDir(dirs, "~/Library/pnpm");
  pushExpandedDir(dirs, "~/Library/pnpm/global/5/node_modules/.bin");
  pushExpandedDir(dirs, "/opt/homebrew/bin");
  pushExpandedDir(dirs, "/usr/local/bin");

  return Array.from(new Set(dirs));
}

async function collectPackageManagerCandidates(command: string, packageName?: string) {
  const candidates: string[] = [];
  for (const dir of await collectPackageManagerBinDirs()) {
    pushPathCandidate(candidates, path.join(dir, command));
  }

  const roots = [
    await execTrimmed("npm", ["root", "-g"]),
    await execTrimmed("pnpm", ["root", "-g"]),
  ].filter(Boolean);
  if (packageName) {
    for (const root of roots) {
      pushPathCandidate(candidates, await readPackageBin(root, packageName, command));
    }
  }

  try {
    const npxRoot = path.join(os.homedir(), ".npm", "_npx");
    const entries = await readdir(npxRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      pushPathCandidate(candidates, path.join(npxRoot, entry.name, "node_modules", ".bin", command));
      if (packageName) {
        pushPathCandidate(
          candidates,
          await readPackageBin(path.join(npxRoot, entry.name, "node_modules"), packageName, command),
        );
      }
    }
  } catch {
    // npx cache is optional.
  }

  return Array.from(new Set(candidates));
}

export async function resolveCliPath(cliPath: string, options: { packageName?: string } = {}) {
  const normalized = expandHomeDir(cliPath || "claude");

  if (normalized.includes("/")) {
    await access(normalized, constants.X_OK);
    return normalized;
  }

  const whichPath = await execTrimmed("which", [normalized]);
  if (whichPath) return whichPath;

  for (const candidate of await collectPackageManagerCandidates(normalized, options.packageName)) {
    if (await isExecutable(candidate)) return candidate;
  }

  throw new Error(`无法找到可执行命令：${normalized}`);
}

export function normalizeWorkingDirectory(path: string) {
  return expandHomeDir(path);
}
