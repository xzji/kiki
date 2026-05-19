import dns from "dns/promises";
import net from "net";

type SafeInternetFetchInput = {
  url: string;
  currentOrigin: string;
  responseType?: "json" | "text";
};

export type SafeInternetFetchResult = {
  url: string;
  contentType: string;
  body: unknown;
};

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

function isPrivateIPv4(ip: string) {
  return (
    ip.startsWith("10.") ||
    ip.startsWith("127.") ||
    ip.startsWith("0.") ||
    ip.startsWith("169.254.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  );
}

function isPrivateIPv6(ip: string) {
  const normalized = ip.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

async function assertSafeUrl(value: string, currentOrigin: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL 格式无效");
  }
  if (url.protocol !== "https:") throw new Error("只允许 HTTPS 公网 URL");
  const current = new URL(currentOrigin);
  if (url.origin === current.origin) throw new Error("不允许访问 KiKi 当前站点");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "metadata.google.internal") {
    throw new Error("不允许访问 localhost 或元数据地址");
  }
  const literalIpVersion = net.isIP(hostname);
  if (literalIpVersion === 4 && isPrivateIPv4(hostname)) throw new Error("不允许访问内网 IPv4 地址");
  if (literalIpVersion === 6 && isPrivateIPv6(hostname)) throw new Error("不允许访问内网 IPv6 地址");
  if (!literalIpVersion) {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!records.length) throw new Error("域名解析失败");
    for (const record of records) {
      if (record.family === 4 && isPrivateIPv4(record.address)) throw new Error("域名解析到内网 IPv4 地址，已拒绝");
      if (record.family === 6 && isPrivateIPv6(record.address)) throw new Error("域名解析到内网 IPv6 地址，已拒绝");
    }
  }
  url.username = "";
  url.password = "";
  return url;
}

function parseBody(buffer: ArrayBuffer, contentType: string, responseType?: "json" | "text") {
  const text = Buffer.from(buffer).toString("utf8");
  const wantsJson = responseType === "json" || (!responseType && /\bjson\b/i.test(contentType));
  if (!wantsJson) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("响应不是有效 JSON");
  }
}

export async function safeInternetFetch(input: SafeInternetFetchInput): Promise<SafeInternetFetchResult> {
  let url = await assertSafeUrl(input.url, input.currentOrigin);
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: input.responseType === "json" ? "application/json,text/plain;q=0.8,*/*;q=0.2" : "text/plain,application/json;q=0.8,*/*;q=0.2",
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("重定向缺少 Location");
      if (redirectCount >= MAX_REDIRECTS) throw new Error("重定向次数过多");
      url = await assertSafeUrl(new URL(location, url).toString(), input.currentOrigin);
      continue;
    }

    if (!response.ok) throw new Error(`公网请求失败：HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "text/plain";
    if (!/json|text|xml|csv|html/i.test(contentType)) {
      throw new Error(`不支持的响应类型：${contentType}`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BYTES) throw new Error("响应超过 256KB 限制");
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) throw new Error("响应超过 256KB 限制");
    return {
      url: url.toString(),
      contentType,
      body: parseBody(buffer, contentType, input.responseType),
    };
  }
  throw new Error("重定向次数过多");
}
