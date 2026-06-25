import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import { handleWithResponseCompression } from "@/lib/server/http/responseCompression";

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    handleWithResponseCompression(req, res, () => handler(req, res));
  });
  return new Promise<{ server: typeof server; port: number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, port });
    });
  });
}

// Faithfully mirror Next.js's createWriterFromResponse (pipe-readable.js): a
// persistent res.on("drain") listener is registered UP-FRONT — before the first
// res.write() — and re-armed after each backpressure stall. This ordering is the
// crucial detail: at registration time the compression wrapper has not yet
// created its compressor, so a naive "redirect only when compressor exists"
// fix silently misses this listener and still deadlocks.
async function pumpLikeNext(res: ServerResponse, body: string) {
  let drainResolve: (() => void) | null = null;
  let drained = new Promise<void>((resolve) => (drainResolve = resolve));
  const onDrain = () => drainResolve?.();
  res.on("drain", onDrain);
  res.once("close", () => drainResolve?.());

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  const buf = Buffer.from(body);
  const CHUNK = 16 * 1024;
  for (let offset = 0; offset < buf.length; offset += CHUNK) {
    const canContinue = res.write(buf.subarray(offset, offset + CHUNK));
    if (!canContinue) {
      await drained;
      drained = new Promise<void>((resolve) => (drainResolve = resolve));
    }
  }
  res.end();
}

async function fetchWithTimeout(url: string, encoding: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "Accept-Encoding": encoding },
      signal: controller.signal,
    });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timer);
  }
}

export async function runResponseCompressionSpecs() {
  // Payload large enough that the socket applies backpressure mid-stream, which
  // is the condition that previously deadlocked the compression wrapper and made
  // /api/runtime/state hang forever in cloud (drawer stuck on "正在加载").
  const bigPayload = JSON.stringify({
    goals: Array.from({ length: 4000 }, (_, i) => ({ id: `goal-${i}`, blob: "x".repeat(2000) })),
  });

  const { server, port } = await startServer((_req, res) => {
    void pumpLikeNext(res, bigPayload);
  });

  try {
    for (const encoding of ["br", "gzip"]) {
      const { response, text } = await fetchWithTimeout(
        `http://127.0.0.1:${port}/api/runtime/state`,
        encoding,
        5000,
      );
      assert.equal(response.status, 200, `${encoding}: status should be 200`);
      assert.equal(
        response.headers.get("content-encoding"),
        encoding,
        `${encoding}: response should be ${encoding}-encoded`,
      );
      // fetch auto-decodes; a complete, correct body proves the stream did not
      // deadlock and the compressed bytes round-trip losslessly.
      assert.equal(text, bigPayload, `${encoding}: decoded body must match original payload`);
    }

    // Without a supported Accept-Encoding the wrapper must pass through untouched.
    const { response: identityResponse, text: identityText } = await fetchWithTimeout(
      `http://127.0.0.1:${port}/api/runtime/state`,
      "identity",
      5000,
    );
    assert.equal(identityResponse.status, 200, "identity: status should be 200");
    assert.equal(
      identityResponse.headers.get("content-encoding"),
      null,
      "identity: response must not be compressed",
    );
    assert.equal(identityText, bigPayload, "identity: body must match original payload");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
