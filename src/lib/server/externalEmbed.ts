import net from "net";

import type { ExternalEmbedProvider } from "@/types/artifact";

const PRIVATE_IPV4_RANGES = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^0\./,
];

export type NormalizedExternalEmbed = {
  url: string;
  embedUrl: string;
  provider: ExternalEmbedProvider;
  allowFullScreen: boolean;
  host: string;
};

function isBlockedHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "metadata.google.internal") return true;
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) return PRIVATE_IPV4_RANGES.some((pattern) => pattern.test(normalized));
  if (ipVersion === 6) {
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  return false;
}

function parseYoutubeId(url: URL) {
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0];
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname.startsWith("/embed/")) return url.pathname.split("/").filter(Boolean)[1];
    if (url.pathname === "/watch") return url.searchParams.get("v") ?? undefined;
  }
  return undefined;
}

export function assertSafePublicHttpsUrl(value: string, options?: { currentOrigin?: string }) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL 格式无效");
  }
  if (url.protocol !== "https:") throw new Error("只允许 HTTPS 公网 URL");
  if (isBlockedHostname(url.hostname)) throw new Error("不允许访问 localhost、内网或元数据地址");
  if (options?.currentOrigin) {
    const currentOrigin = new URL(options.currentOrigin);
    if (url.origin === currentOrigin.origin) throw new Error("不允许访问 KiKi 当前站点 API");
  }
  url.username = "";
  url.password = "";
  return url;
}

export function normalizeExternalEmbedUrl(value: string): NormalizedExternalEmbed {
  const url = assertSafePublicHttpsUrl(value);
  const youtubeId = parseYoutubeId(url);
  if (youtubeId) {
    const embedUrl = new URL(`https://www.youtube.com/embed/${encodeURIComponent(youtubeId)}`);
    return {
      url: url.toString(),
      embedUrl: embedUrl.toString(),
      provider: "youtube",
      allowFullScreen: true,
      host: "youtube.com",
    };
  }
  return {
    url: url.toString(),
    embedUrl: url.toString(),
    provider: "generic",
    allowFullScreen: false,
    host: url.hostname,
  };
}
