export function buildPiEnv() {
  const keepPrefixes = [
    "ANTHROPIC_",
    "CLAUDE_",
    "GOOGLE_",
    "HTTPS_",
    "HTTP_",
    "NO_PROXY",
    "OPENAI_",
    "PI_",
  ];
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
  ]);
  const env = {
    NODE_ENV: process.env.NODE_ENV || "development",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  } as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (keepKeys.has(key) || keepPrefixes.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  env.PI_OFFLINE = "1";
  env.PI_SKIP_VERSION_CHECK = "1";
  env.PI_TELEMETRY = "0";
  return env;
}
