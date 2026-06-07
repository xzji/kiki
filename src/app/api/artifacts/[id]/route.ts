import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { NextResponse } from "next/server";

import { getArtifactById } from "@/lib/server/repositories/artifactsRepository";
import { resolveArtifactFilePath } from "@/lib/server/workspace/artifactStorage";
import { withAuth } from "@/lib/server/http/withAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETHandler(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const artifact = getArtifactById(id);
  if (!artifact) {
    return NextResponse.json({ ok: false, reason: "产物不存在" }, { status: 404 });
  }

  if (artifact.kind === "external_link") {
    return NextResponse.redirect(artifact.url);
  }

  if (artifact.kind === "text_block") {
    return new Response(artifact.inlineContent, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  if (artifact.kind === "webapp") {
    return NextResponse.redirect(new URL(`/api/artifacts/${encodeURIComponent(artifact.id)}/preview`, _request.url));
  }

  if (artifact.kind === "external_embed") {
    return NextResponse.json({
      ok: true,
      id: artifact.id,
      kind: artifact.kind,
      label: artifact.label,
      url: artifact.url,
      embedUrl: artifact.embedUrl,
      provider: artifact.provider,
    });
  }

  const filePath = resolveArtifactFilePath(artifact);
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ ok: false, reason: "产物文件不存在" }, { status: 404 });
  }

  const stream = fs.createReadStream(filePath);
  const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "Content-Type": artifact.mime,
      "Content-Length": String(artifact.size),
      "Content-Disposition": `inline; filename="${encodeURIComponent(path.basename(filePath))}"`,
    },
  });
}

export const GET = withAuth(GETHandler);
