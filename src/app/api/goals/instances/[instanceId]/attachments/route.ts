import { NextRequest, NextResponse } from "next/server";

import { getStorageAdapter } from "@/lib/server/adapters/storage";

export const runtime = "nodejs";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function safeFileName(value: string) {
  return value
    .replace(/[\\/]/g, "-")
    .replace(/[^\w.\-\u4e00-\u9fa5]/g, "_")
    .slice(0, 120) || "attachment";
}

export async function POST(
  request: NextRequest,
  context: {
    params: {
      instanceId: string;
    };
  },
) {
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ reason: "缺少待上传文件" }, { status: 400 });
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return NextResponse.json({ reason: "附件不能超过 10MB" }, { status: 413 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const storage = getStorageAdapter();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = safeFileName(file.name);
  const key = `goal-instance-attachments/${safeFileName(context.params.instanceId)}/${timestamp}-${fileName}`;
  const saved = storage.putBlob(key, bytes);

  return NextResponse.json({
    ok: true,
    attachment: {
      name: file.name,
      type: file.type,
      size: saved.size,
      key: saved.ref.key,
      url: storage.signUrl(saved.ref.key),
    },
  });
}
