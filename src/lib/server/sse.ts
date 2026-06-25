const encoder = new TextEncoder();

export function writeSseEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: string,
  data?: unknown,
) {
  const lines = [`event: ${event}`];
  if (data !== undefined) {
    lines.push(`data: ${JSON.stringify(data)}`);
  }
  lines.push("", "");
  controller.enqueue(encoder.encode(lines.join("\n")));
}

export function writeSseComment(controller: ReadableStreamDefaultController<Uint8Array>, comment = "ping") {
  controller.enqueue(encoder.encode(`: ${comment}\n\n`));
}

export function createSseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };
}
