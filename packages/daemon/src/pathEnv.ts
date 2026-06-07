import fs from "fs";
import os from "os";
import path from "path";

/** macOS 系统默认 PATH（LaunchAgent 不会自动加载 /etc/paths） */
function loadMacSystemPaths() {
  if (process.platform !== "darwin") return [] as string[];
  const dirs: string[] = [];
  const pushFile = (filePath: string) => {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      for (const line of content.split("\n")) {
        const entry = line.trim();
        if (entry) dirs.push(entry);
      }
    } catch {
      // ignore
    }
  };
  pushFile("/etc/paths");
  try {
    for (const name of fs.readdirSync("/etc/paths.d")) {
      pushFile(path.join("/etc/paths.d", name));
    }
  } catch {
    // ignore
  }
  return dirs;
}

/** 去重并保持顺序 */
function uniquePaths(paths: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of paths) {
    const normalized = entry.replace(/\/+$/, "") || entry;
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/** 常见 CLI / 工具链安装目录（按优先级大致从高到低） */
export function collectDaemonPathCandidates(home = os.homedir()): string[] {
  const candidates: string[] = [];

  // 用户级（Claude Code 默认 ~/.local/bin）
  candidates.push(
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".deno", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, ".pixi", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".pyenv", "shims"),
    path.join(home, ".rbenv", "shims"),
    path.join(home, ".nix-profile", "bin"),
    path.join(home, "go", "bin"),
    path.join(home, "Library", "pnpm"),
    path.join(home, "google-cloud-sdk", "bin"),
    path.join(home, "miniconda3", "bin"),
    path.join(home, "anaconda3", "bin"),
    path.join(home, "miniforge3", "bin"),
  );

  // nvm / fnm / mise（安装时若存在则优先）
  if (process.env.NVM_BIN) {
    candidates.push(process.env.NVM_BIN);
  } else {
    candidates.push(path.join(home, ".nvm", "current", "bin"));
  }
  if (process.env.FNM_MULTISHELL_PATH) {
    candidates.push(process.env.FNM_MULTISHELL_PATH);
  }
  candidates.push(path.join(home, ".fnm", "aliases", "default", "bin"));
  if (process.env.PIXI_HOME) {
    candidates.push(path.join(process.env.PIXI_HOME, "bin"));
  }

  // npm 全局 prefix
  const npmPrefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX;
  if (npmPrefix) {
    candidates.push(path.join(npmPrefix, "bin"));
  }

  // 与当前 node 同级的 bin（nvm/fnm 全局包装）
  const nodeDir = path.dirname(process.execPath);
  candidates.push(nodeDir);

  if (process.platform === "darwin") {
    candidates.push(...loadMacSystemPaths());
    candidates.push(
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      "/opt/local/bin",
      "/Library/Apple/usr/bin",
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
      "/Applications/Cursor.app/Contents/Resources/app/bin",
    );
    // pip install --user 常见路径（Python 3.9–3.13）
    for (const ver of ["3.9", "3.10", "3.11", "3.12", "3.13"]) {
      candidates.push(path.join(home, "Library", "Python", ver, "bin"));
    }
  }

  if (process.platform === "linux") {
    candidates.push("/snap/bin", "/usr/local/sbin", "/var/lib/flatpak/exports/bin");
  }

  candidates.push("/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");

  return candidates;
}

/** 合并安装时 PATH + 常见候选目录 */
export function buildDaemonPathEnv(installPath?: string, home = os.homedir()) {
  const segments: string[] = [];
  if (installPath?.trim()) {
    segments.push(...installPath.split(path.delimiter).filter(Boolean));
  }
  segments.push(...collectDaemonPathCandidates(home));
  return uniquePaths(segments).join(path.delimiter);
}

const PASSTHROUGH_EXACT = new Set([
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
]);

const PASSTHROUGH_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_",
  "OPENAI_",
  "CODEX_",
  "GEMINI_",
  "GOOGLE_",
  "HTTP_",
  "HTTPS_",
];

/** 后台服务需要继承的环境变量（安装时从当前 shell 捕获） */
export function collectDaemonServiceEnv(
  installEnv: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): Record<string, string> {
  const user = os.userInfo();
  const env: Record<string, string> = {
    HOME: home,
    USER: user.username,
    LOGNAME: user.username,
    PATH: buildDaemonPathEnv(installEnv.PATH, home),
    LANG: installEnv.LANG || "en_US.UTF-8",
  };

  if (installEnv.LC_ALL) env.LC_ALL = installEnv.LC_ALL;
  if (installEnv.LC_CTYPE) env.LC_CTYPE = installEnv.LC_CTYPE;
  if (installEnv.TMPDIR) env.TMPDIR = installEnv.TMPDIR;
  else if (fs.existsSync("/tmp")) env.TMPDIR = "/tmp";
  if (installEnv.SHELL) env.SHELL = installEnv.SHELL;

  for (const [key, value] of Object.entries(installEnv)) {
    if (!value) continue;
    if (PASSTHROUGH_EXACT.has(key) || PASSTHROUGH_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }

  return env;
}
