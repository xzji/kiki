import type { IncomingMessage, ServerResponse } from "http";
import type { BrotliOptions, ZlibOptions } from "zlib";
import { constants, createBrotliCompress, createGzip } from "zlib";

type CompressionEncoding = "br" | "gzip";

const COMPRESSIBLE_CONTENT_TYPE = /^(text\/|application\/(json|javascript|xml|x-javascript|ld\+json))/i;

const BROTLI_OPTIONS: BrotliOptions = {
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 4,
  },
};

const GZIP_OPTIONS: ZlibOptions = {
  level: 6,
};

function appendVaryAcceptEncoding(res: ServerResponse) {
  const current = res.getHeader("Vary");
  if (!current) {
    res.setHeader("Vary", "Accept-Encoding");
    return;
  }
  const values = Array.isArray(current) ? current.join(", ") : String(current);
  if (values.toLowerCase().split(",").map((value) => value.trim()).includes("accept-encoding")) return;
  res.setHeader("Vary", `${values}, Accept-Encoding`);
}

function selectEncoding(req: IncomingMessage): CompressionEncoding | null {
  const acceptEncoding = String(req.headers["accept-encoding"] ?? "");
  if (/\bbr\b/.test(acceptEncoding)) return "br";
  if (/\bgzip\b/.test(acceptEncoding)) return "gzip";
  return null;
}

function isCompressibleResponse(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "HEAD") return false;
  if (res.statusCode < 200 || res.statusCode === 204 || res.statusCode === 304) return false;
  if (res.hasHeader("Content-Encoding")) return false;

  const cacheControl = String(res.getHeader("Cache-Control") ?? "");
  if (/\bno-transform\b/i.test(cacheControl)) return false;

  const contentType = String(res.getHeader("Content-Type") ?? "");
  if (!contentType) return false;
  if (/text\/event-stream/i.test(contentType)) return false;
  return COMPRESSIBLE_CONTENT_TYPE.test(contentType);
}

function normalizeWriteHeadArgs(
  statusCode: number,
  statusMessageOrHeaders?: string | ServerResponse["statusMessage"] | Record<string, string | number | readonly string[]>,
  headers?: Record<string, string | number | readonly string[]>,
) {
  if (typeof statusMessageOrHeaders === "string") {
    return { statusCode, statusMessage: statusMessageOrHeaders, headers };
  }
  return { statusCode, statusMessage: undefined, headers: statusMessageOrHeaders };
}

export function handleWithResponseCompression(
  req: IncomingMessage,
  res: ServerResponse,
  handler: () => void,
) {
  const encoding = selectEncoding(req);
  if (!encoding) {
    handler();
    return;
  }

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  const originalWriteHead = res.writeHead.bind(res);
  let compressor: ReturnType<typeof createBrotliCompress> | ReturnType<typeof createGzip> | null = null;
  let decided = false;
  let headersFlushed = false;

  const flushHeaders = () => {
    if (headersFlushed || res.headersSent) return;
    headersFlushed = true;
    originalWriteHead(res.statusCode);
  };

  const startCompressionIfEligible = () => {
    if (decided) return Boolean(compressor);
    decided = true;
    if (!isCompressibleResponse(req, res)) return false;

    res.removeHeader("Content-Length");
    res.setHeader("Content-Encoding", encoding);
    appendVaryAcceptEncoding(res);

    compressor = encoding === "br" ? createBrotliCompress(BROTLI_OPTIONS) : createGzip(GZIP_OPTIONS);
    compressor.on("data", (chunk: Buffer) => {
      flushHeaders();
      originalWrite(chunk);
    });
    compressor.on("end", () => {
      originalEnd();
    });
    compressor.on("error", (error) => {
      res.destroy(error);
    });
    return true;
  };

  res.writeHead = ((statusCode: number, statusMessageOrHeaders?: unknown, headers?: unknown) => {
    const normalized = normalizeWriteHeadArgs(
      statusCode,
      statusMessageOrHeaders as string | Record<string, string | number | readonly string[]> | undefined,
      headers as Record<string, string | number | readonly string[]> | undefined,
    );
    res.statusCode = normalized.statusCode;
    if (normalized.statusMessage) res.statusMessage = normalized.statusMessage;
    for (const [key, value] of Object.entries(normalized.headers ?? {})) {
      if (value !== undefined) res.setHeader(key, value);
    }
    return res;
  }) as typeof res.writeHead;

  res.write = ((chunk: unknown, chunkEncoding?: BufferEncoding | ((error?: Error) => void), callback?: (error?: Error) => void) => {
    const active = startCompressionIfEligible();
    flushHeaders();
    if (!active || !compressor) {
      return (originalWrite as (...args: unknown[]) => boolean)(
        ...[chunk, chunkEncoding, callback].filter((value) => value !== undefined),
      );
    }
    return (compressor.write as (...args: unknown[]) => boolean)(
      ...[chunk, chunkEncoding, callback].filter((value) => value !== undefined),
    );
  }) as typeof res.write;

  res.end = ((chunk?: unknown, chunkEncoding?: BufferEncoding | (() => void), callback?: () => void) => {
    if (chunk !== undefined && chunk !== null) {
      const active = startCompressionIfEligible();
      flushHeaders();
      if (active && compressor) {
        (compressor.end as (...args: unknown[]) => void)(
          ...[chunk, chunkEncoding, callback].filter((value) => value !== undefined),
        );
        return res;
      }
    }
    if (compressor) {
      flushHeaders();
      (compressor.end as (...args: unknown[]) => void)(
        ...[chunkEncoding, callback].filter((value) => value !== undefined),
      );
      return res;
    }
    flushHeaders();
    return (originalEnd as (...args: unknown[]) => ServerResponse)(
      ...[chunk, chunkEncoding, callback].filter((value) => value !== undefined),
    );
  }) as typeof res.end;

  handler();
}
