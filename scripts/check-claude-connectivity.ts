/**
 * claude.ai 连通性 & WebFetch 域名安全校验排查脚本
 *
 * 背景：云端任务里 WebFetch 全部返回
 *   "Unable to verify if domain <X> is safe to fetch. This may be due to network
 *    restrictions or enterprise security policies blocking claude.ai."
 * 该报错并非目标站点不可达，而是 Claude 的 WebFetch 在抓取前要先向 claude.ai 做一次
 * 「域名安全校验」。一旦运行环境无法连到 claude.ai（DNS 污染 / 防火墙 / 企业代理拦截），
 * 这步校验就会失败，于是所有 WebFetch 全军覆没。
 *
 * 本脚本分别探测：
 *   1) 域名安全校验依赖的 Anthropic/claude.ai 控制面（这是根因所在）；
 *   2) 任务实际想抓取的目标站点（用于区分「目标站点本身挂了」还是「校验通道挂了」）。
 *
 * 每个探测分四层：DNS 解析 → TCP 443 连通 → TLS 握手 → HTTPS 请求状态码。
 * 任一层失败都会给出可读的诊断与最可能的成因。
 *
 * 运行：
 *   npx tsx scripts/check-claude-connectivity.ts
 *   npx tsx scripts/check-claude-connectivity.ts https://example.com  # 追加自定义目标
 */

import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import https from "node:https";

type ProbeLayerStatus = "ok" | "fail" | "skip";

type ProbeLayerResult = {
  name: string;
  status: ProbeLayerStatus;
  detail: string;
  elapsedMs: number;
};

type ProbeResult = {
  url: string;
  host: string;
  category: "verifier" | "target";
  layers: ProbeLayerResult[];
  verdict: "reachable" | "unreachable" | "degraded";
};

const TIMEOUT_MS = 8000;

// WebFetch 域名安全校验所依赖的 Anthropic 控制面。这些不通 = WebFetch 必然报「无法校验域名安全」。
const VERIFIER_TARGETS = [
  "https://claude.ai",
  "https://api.anthropic.com",
  "https://www.anthropic.com",
];

// 6/19 那次任务里实际被 WebFetch 拦下的目标站点，用于对照排除「站点本身问题」。
const DEFAULT_DATA_TARGETS = [
  "https://www.cnbc.com",
  "https://www.federalreserve.gov",
  "https://www.investing.com",
  "https://finance.yahoo.com",
];

function now() {
  return Date.now();
}

function hostFromUrl(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return rawUrl;
  }
}

async function probeDns(host: string): Promise<ProbeLayerResult> {
  const startedAt = now();
  try {
    const records = await dns.lookup(host, { all: true });
    const addrs = records.map((record) => record.address).join(", ");
    return {
      name: "DNS 解析",
      status: "ok",
      detail: `解析到 ${records.length} 条地址：${addrs}`,
      elapsedMs: now() - startedAt,
    };
  } catch (error) {
    return {
      name: "DNS 解析",
      status: "fail",
      detail: describeError(error),
      elapsedMs: now() - startedAt,
    };
  }
}

function probeTcp(host: string, port = 443): Promise<ProbeLayerResult> {
  const startedAt = now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: Omit<ProbeLayerResult, "name" | "elapsedMs">) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ name: `TCP ${port} 连接`, elapsedMs: now() - startedAt, ...result });
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () => finish({ status: "ok", detail: `已建立到 ${host}:${port} 的 TCP 连接` }));
    socket.once("timeout", () => finish({ status: "fail", detail: `连接超时（>${TIMEOUT_MS}ms），可能被防火墙静默丢弃` }));
    socket.once("error", (error) => finish({ status: "fail", detail: describeError(error) }));
    socket.connect(port, host);
  });
}

function probeTls(host: string, port = 443): Promise<ProbeLayerResult> {
  const startedAt = now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Omit<ProbeLayerResult, "name" | "elapsedMs">) => {
      if (settled) return;
      settled = true;
      resolve({ name: "TLS 握手", elapsedMs: now() - startedAt, ...result });
    };
    const socket = tls.connect(
      { host, port, servername: host, timeout: TIMEOUT_MS, rejectUnauthorized: true },
      () => {
        const cert = socket.getPeerCertificate();
        const issuer = cert?.issuer?.O || cert?.issuer?.CN || "未知颁发者";
        const authorized = socket.authorized;
        socket.end();
        finish({
          status: authorized ? "ok" : "fail",
          detail: authorized
            ? `证书有效，颁发者：${issuer}`
            : `证书校验失败：${socket.authorizationError ?? "unknown"}（疑似中间人代理 / SSL 拦截）`,
        });
      },
    );
    socket.once("timeout", () => {
      socket.destroy();
      finish({ status: "fail", detail: `TLS 握手超时（>${TIMEOUT_MS}ms）` });
    });
    socket.once("error", (error) => finish({ status: "fail", detail: describeError(error) }));
  });
}

function probeHttps(rawUrl: string): Promise<ProbeLayerResult> {
  const startedAt = now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Omit<ProbeLayerResult, "name" | "elapsedMs">) => {
      if (settled) return;
      settled = true;
      resolve({ name: "HTTPS 请求", elapsedMs: now() - startedAt, ...result });
    };
    const request = https.request(
      rawUrl,
      { method: "GET", timeout: TIMEOUT_MS, headers: { "User-Agent": "kiki-connectivity-check/1.0" } },
      (response) => {
        const status = response.statusCode ?? 0;
        const server = response.headers["server"];
        response.resume();
        // 2xx/3xx/401/403 都说明「连得上、握手成功、服务在应答」——通道是通的。
        const ok = status > 0 && status < 500;
        finish({
          status: ok ? "ok" : "fail",
          detail: `HTTP ${status}${server ? ` · server=${server}` : ""}`,
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      finish({ status: "fail", detail: `请求超时（>${TIMEOUT_MS}ms）` });
    });
    request.once("error", (error) => finish({ status: "fail", detail: describeError(error) }));
    request.end();
  });
}

function describeError(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    const message = error instanceof Error ? error.message : String(error);
    const hint = errorHint(code);
    return hint ? `${code}：${message}（${hint}）` : `${code}：${message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function errorHint(code: string) {
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "DNS 无法解析，疑似 DNS 污染或断网";
    case "ECONNREFUSED":
      return "端口拒绝连接，疑似被防火墙/代理拒绝";
    case "ETIMEDOUT":
      return "连接超时，疑似被防火墙静默丢包";
    case "ECONNRESET":
      return "连接被重置，疑似被中间设备掐断";
    case "CERT_HAS_EXPIRED":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return "证书异常，疑似企业 SSL 中间人拦截";
    default:
      return "";
  }
}

async function probeUrl(rawUrl: string, category: ProbeResult["category"]): Promise<ProbeResult> {
  const host = hostFromUrl(rawUrl);
  const layers: ProbeLayerResult[] = [];

  const dnsLayer = await probeDns(host);
  layers.push(dnsLayer);

  if (dnsLayer.status !== "ok") {
    layers.push({ name: "TCP 443 连接", status: "skip", detail: "DNS 失败，跳过", elapsedMs: 0 });
    layers.push({ name: "TLS 握手", status: "skip", detail: "DNS 失败，跳过", elapsedMs: 0 });
    layers.push({ name: "HTTPS 请求", status: "skip", detail: "DNS 失败，跳过", elapsedMs: 0 });
    return { url: rawUrl, host, category, layers, verdict: "unreachable" };
  }

  const tcpLayer = await probeTcp(host);
  layers.push(tcpLayer);
  if (tcpLayer.status !== "ok") {
    layers.push({ name: "TLS 握手", status: "skip", detail: "TCP 失败，跳过", elapsedMs: 0 });
    layers.push({ name: "HTTPS 请求", status: "skip", detail: "TCP 失败，跳过", elapsedMs: 0 });
    return { url: rawUrl, host, category, layers, verdict: "unreachable" };
  }

  const tlsLayer = await probeTls(host);
  layers.push(tlsLayer);

  const httpsLayer = await probeHttps(rawUrl);
  layers.push(httpsLayer);

  const verdict: ProbeResult["verdict"] =
    httpsLayer.status === "ok" ? (tlsLayer.status === "ok" ? "reachable" : "degraded") : "unreachable";
  return { url: rawUrl, host, category, layers, verdict };
}

function statusGlyph(status: ProbeLayerStatus) {
  if (status === "ok") return "[ OK ]";
  if (status === "skip") return "[SKIP]";
  return "[FAIL]";
}

function verdictGlyph(verdict: ProbeResult["verdict"]) {
  if (verdict === "reachable") return "可达";
  if (verdict === "degraded") return "勉强可达（证书/中间层异常）";
  return "不可达";
}

function printResult(result: ProbeResult) {
  console.log(`\n▶ ${result.url}  →  ${verdictGlyph(result.verdict)}`);
  for (const layer of result.layers) {
    const timing = layer.elapsedMs ? ` (${layer.elapsedMs}ms)` : "";
    console.log(`    ${statusGlyph(layer.status)} ${layer.name}${timing}：${layer.detail}`);
  }
}

async function main() {
  const extraTargets = process.argv.slice(2).filter((arg) => /^https?:\/\//.test(arg));

  console.log("=".repeat(72));
  console.log("claude.ai 连通性 & WebFetch 域名安全校验排查");
  console.log("=".repeat(72));
  console.log(
    "原理：WebFetch 抓取前会向 claude.ai 做域名安全校验。若 claude.ai 控制面不可达，\n" +
      "      则所有 WebFetch 都会报「Unable to verify if domain ... is safe to fetch」。\n",
  );

  console.log("─".repeat(72));
  console.log("第 1 组：域名安全校验依赖的 Anthropic / claude.ai 控制面（根因关键）");
  console.log("─".repeat(72));
  const verifierResults: ProbeResult[] = [];
  for (const url of VERIFIER_TARGETS) {
    const result = await probeUrl(url, "verifier");
    verifierResults.push(result);
    printResult(result);
  }

  console.log(`\n${"─".repeat(72)}`);
  console.log("第 2 组：任务实际想抓取的目标站点（用于对照排除站点自身问题）");
  console.log("─".repeat(72));
  const targetResults: ProbeResult[] = [];
  for (const url of [...DEFAULT_DATA_TARGETS, ...extraTargets]) {
    const result = await probeUrl(url, "target");
    targetResults.push(result);
    printResult(result);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log("诊断结论");
  console.log("=".repeat(72));

  const verifierReachable = verifierResults.some((result) => result.verdict !== "unreachable");
  const verifierClaudeAi = verifierResults.find((result) => result.host.includes("claude.ai"));
  const targetsReachable = targetResults.filter((result) => result.verdict !== "unreachable").length;

  if (!verifierReachable) {
    console.log(
      "❌ claude.ai / Anthropic 控制面全部不可达。\n" +
        "   → 这正是 WebFetch「无法校验域名安全」的根因：域名安全校验通道被掐断。\n" +
        "   → 即使目标站点本身能访问，WebFetch 仍会全部失败。\n" +
        "   → 处置：放行运行环境到 claude.ai / api.anthropic.com 的出网（DNS + 443），\n" +
        "     或为 Claude CLI 配置可达的 HTTPS 代理；必要时联系网络/安全团队解除企业策略拦截。",
    );
  } else if (verifierClaudeAi && verifierClaudeAi.verdict === "unreachable") {
    console.log(
      "⚠️  api.anthropic.com 可达，但 claude.ai 不可达。\n" +
        "   → WebFetch 的域名安全校验通常依赖 claude.ai，单独被拦同样会导致校验失败。\n" +
        "   → 处置：重点放行 claude.ai 的出网。",
    );
  } else if (targetsReachable === 0) {
    console.log(
      "⚠️  控制面可达，但目标数据站点全部不可达。\n" +
        "   → 此时 WebFetch 失败更可能是目标站点侧问题（区域封锁 / 反爬 / 站点维护），\n" +
        "     与 claude.ai 域名校验无关。请结合具体站点逐个核查。",
    );
  } else {
    console.log(
      "✅ 控制面与目标站点均有可达项。\n" +
        "   → 当前环境未复现「域名安全校验被拦」。若线上仍报错，说明问题出在云端运行环境\n" +
        "     （而非本机），请在云端容器内重跑本脚本对照。",
    );
  }
  console.log("");
}

main().catch((error) => {
  console.error("连通性探测脚本异常：", error);
  process.exit(1);
});
