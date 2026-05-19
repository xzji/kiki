import { getDatabase } from "@/lib/server/db/client";
import type {
  Artifact,
  ArtifactKind,
  ExternalEmbedArtifact,
  ExternalLinkArtifact,
  FileArtifact,
  TextBlockArtifact,
  WebAppArtifact,
  WebAppManifest,
} from "@/types/artifact";

type ArtifactRow = {
  id: string;
  conversation_id: string;
  task_id: string | null;
  instance_id: string | null;
  runtime_job_id: string | null;
  kind: ArtifactKind;
  label: string;
  summary: string | null;
  storage_rel_path: string | null;
  mime: string | null;
  size: number | null;
  url: string | null;
  embed_url: string | null;
  provider: string | null;
  inline_content: string | null;
  manifest_json: string | null;
  created_at: string;
};

function parseManifest(value: string | null): WebAppManifest | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as WebAppManifest;
    return parsed && parsed.schemaVersion === 1 && parsed.bridgeVersion === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function mapRow(row: ArtifactRow): Artifact {
  const common = {
    id: row.id,
    conversationId: row.conversation_id,
    taskId: row.task_id ?? undefined,
    instanceId: row.instance_id ?? undefined,
    runtimeJobId: row.runtime_job_id ?? undefined,
    label: row.label,
    summary: row.summary ?? undefined,
    createdAt: row.created_at,
  };
  if (row.kind === "file") {
    return {
      ...common,
      kind: "file",
      storageRelPath: row.storage_rel_path ?? "",
      mime: row.mime ?? "application/octet-stream",
      size: row.size ?? 0,
    } satisfies FileArtifact;
  }
  if (row.kind === "external_link") {
    return {
      ...common,
      kind: "external_link",
      url: row.url ?? "",
    } satisfies ExternalLinkArtifact;
  }
  if (row.kind === "external_embed") {
    const provider = row.provider === "youtube" ? "youtube" : "generic";
    return {
      ...common,
      kind: "external_embed",
      url: row.url ?? "",
      embedUrl: row.embed_url ?? row.url ?? "",
      provider,
      allowFullScreen: provider === "youtube",
    } satisfies ExternalEmbedArtifact;
  }
  if (row.kind === "webapp") {
    return {
      ...common,
      kind: "webapp",
      storageRelPath: row.storage_rel_path ?? "",
      entryFile: "index.html",
      manifest: parseManifest(row.manifest_json),
    } satisfies WebAppArtifact;
  }
  return {
    ...common,
    kind: "text_block",
    inlineContent: row.inline_content ?? "",
  } satisfies TextBlockArtifact;
}

export function upsertArtifact(artifact: Artifact) {
  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO artifacts (
        id, conversation_id, task_id, instance_id, runtime_job_id, kind, label, summary,
        storage_rel_path, mime, size, url, embed_url, provider, inline_content, manifest_json, created_at
      ) VALUES (
        @id, @conversation_id, @task_id, @instance_id, @runtime_job_id, @kind, @label, @summary,
        @storage_rel_path, @mime, @size, @url, @embed_url, @provider, @inline_content, @manifest_json, @created_at
      )
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        summary = excluded.summary,
        storage_rel_path = excluded.storage_rel_path,
        mime = excluded.mime,
        size = excluded.size,
        url = excluded.url,
        embed_url = excluded.embed_url,
        provider = excluded.provider,
        inline_content = excluded.inline_content,
        manifest_json = excluded.manifest_json
    `,
  ).run({
    id: artifact.id,
    conversation_id: artifact.conversationId,
    task_id: artifact.taskId ?? null,
    instance_id: artifact.instanceId ?? null,
    runtime_job_id: artifact.runtimeJobId ?? null,
    kind: artifact.kind,
    label: artifact.label,
    summary: artifact.summary ?? null,
    storage_rel_path: artifact.kind === "file" || artifact.kind === "webapp" ? artifact.storageRelPath : null,
    mime: artifact.kind === "file" ? artifact.mime : null,
    size: artifact.kind === "file" ? artifact.size : null,
    url: artifact.kind === "external_link" || artifact.kind === "external_embed" ? artifact.url : null,
    embed_url: artifact.kind === "external_embed" ? artifact.embedUrl : null,
    provider: artifact.kind === "external_embed" ? artifact.provider : null,
    inline_content: artifact.kind === "text_block" ? artifact.inlineContent : null,
    manifest_json: artifact.kind === "webapp" && artifact.manifest ? JSON.stringify(artifact.manifest) : null,
    created_at: artifact.createdAt,
  });
}

export function getArtifactById(id: string) {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM artifacts WHERE id = ? LIMIT 1`).get(id) as ArtifactRow | undefined;
  return row ? mapRow(row) : null;
}
