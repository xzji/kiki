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
  const originalOn = res.on.bind(res);
  const originalOnce = res.once.bind(res);
  const originalOff = (res.off ?? res.removeListener).bind(res);
  let compressor: ReturnType<typeof createBrotliCompress> | ReturnType<typeof createGzip> | null = null;
  let decided = false;
  let headersFlushed = false;
  // Next's pipeToNodeResponse registers res.on("drain") up-front — before the
  // first res.write(), i.e. before the compressor exists. Buffer those drain
  // listeners so they can be re-targeted onto the compressor once it is created.
  type DrainListener = { listener: (...args: unknown[]) => void; once: boolean };
  const pendingDrainListeners: DrainListener[] = [];

  const flushHeaders = () => {
    if (headersFlushed || res.headersSent) return;
    headersFlushed = true;
    originalWriteHead(res.statusCode);
  };

  const attachDrainListener = (listener: (...args: unknown[]) => void, once: boolean) => {
    if (compressor) {
      if (once) compressor.once("drain", listener);
      else compressor.on("drain", listener);
      return;
    }
    if (decided) {
      if (once) originalOnce("drain", listener);
      else originalOn("drain", listener);
      return;
    }
    pendingDrainListeners.push({ listener, once });
  };

  const flushPendingDrainListeners = (target: "compressor" | "socket") => {
    for (const { listener, once } of pendingDrainListeners.splice(0)) {
      if (target === "compressor" && compressor) {
        if (once) compressor.once("drain", listener);
        else compressor.on("drain", listener);
      } else {
        if (once) originalOnce("drain", listener);
        else originalOn("drain", listener);
      }
    }
  };

  const startCompressionIfEligible = () => {
    if (decided) return Boolean(compressor);
    decided = true;
    if (!isCompressibleResponse(req, res)) {
      // Pass-through response: route any buffered drain listeners to the socket.
      flushPendingDrainListeners("socket");
      return false;
    }

    res.removeHeader("Content-Length");
    res.setHeader("Content-Encoding", encoding);
    appendVaryAcceptEncoding(res);

    compressor = encoding === "br" ? createBrotliCompress(BROTLI_OPTIONS) : createGzip(GZIP_OPTIONS);
    // Output side (compressor -> socket): honor real socket backpressure so a
    // slow client cannot make us buffer the whole compressed body in memory.
    compressor.on("data", (chunk: Buffer) => {
      flushHeaders();
      if (originalWrite(chunk) === false) compressor?.pause();
    });
    compressor.on("end", () => {
      originalEnd();
    });
    compressor.on("error", (error) => {
      res.destroy(error);
    });
    // The real socket draining resumes pumping compressor output downstream.
    originalOn("drain", () => {
      compressor?.resume();
    });
    flushPendingDrainListeners("compressor");
    return true;
  };

  // On client abort the socket is destroyed mid-stream; without this the
  // compressor keeps its buffered input alive (and its data/end/error listeners
  // attached) since res.end()/compressor.end() is never reached. Destroy it to
  // release memory and detach from the dead socket.
  originalOnce("close", () => {
    if (compressor && !compressor.destroyed) compressor.destroy();
  });

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

  // Input side (caller -> compressor): once compression is active, the caller's
  // chunks are buffered inside the compressor, not the socket. A producer that
  // awaits res 'drain' after a backpressured res.write() must therefore be
  // released by the compressor's writable drain — otherwise the response (e.g.
  // a large /api/runtime/state snapshot) deadlocks and never completes.
  res.on = ((type: string | symbol, listener: (...args: unknown[]) => void) => {
    if (type === "drain") {
      attachDrainListener(listener, false);
      return res;
    }
    originalOn(type, listener);
    return res;
  }) as typeof res.on;

  res.once = ((type: string | symbol, listener: (...args: unknown[]) => void) => {
    if (type === "drain") {
      attachDrainListener(listener, true);
      return res;
    }
    originalOnce(type, listener);
    return res;
  }) as typeof res.once;

  const offDrainListener = (type: string | symbol, listener: (...args: unknown[]) => void) => {
    if (type === "drain") {
      const pendingIndex = pendingDrainListeners.findIndex((entry) => entry.listener === listener);
      if (pendingIndex !== -1) {
        pendingDrainListeners.splice(pendingIndex, 1);
        return res;
      }
      if (compressor) {
        compressor.off("drain", listener);
        return res;
      }
    }
    originalOff(type, listener);
    return res;
  };
  res.off = offDrainListener as typeof res.off;
  res.removeListener = offDrainListener as typeof res.removeListener;

  handler();
}
