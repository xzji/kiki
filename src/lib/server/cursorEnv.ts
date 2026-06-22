export function buildCursorEnv() {
  const keepPrefixes = ["CURSOR_", "HTTPS_", "HTTP_", "NO_PROXY"];
  const keepKeys = new Set([
    "HOME",
    "PATH",
    "SHELL",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "CURSOR_API_KEY",
  ]);
  const env = {
    NODE_ENV: process.env.NODE_ENV || "development",
  } as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("npm_") || key.startsWith("TRAE_") || key.startsWith("NEXT_")) continue;
    if (keepKeys.has(key) || keepPrefixes.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  return env;
}
