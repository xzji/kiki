import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

import { normalizeExternalEmbedUrl } from "@/lib/server/externalEmbed";
import { upsertArtifact } from "@/lib/server/repositories/artifactsRepository";
import { upsertArtifactInteractionState } from "@/lib/server/repositories/artifactInteractionRepository";
import {
  assertPathInsideWorkspace,
  ensureConversationWorkspace,
  getConversationWorkspaceDir,
  sanitizeWorkspaceSegment,
  writeTextFileAtomic,
} from "@/lib/server/workspace/conversationWorkspace";
import type { Artifact, ArtifactRef, ExternalEmbedArtifact, ExternalLinkArtifact, FileArtifact, TextBlockArtifact, WebAppArtifact, WebAppManifest, WebAppNetworkPolicy } from "@/types/artifact";

function nowIso() {
  return new Date().toISOString();
}

function createArtifactId() {
  return `artifact-${randomUUID()}`;
}

function safeFilename(filename: string) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  return `${sanitizeWorkspaceSegment(base || "artifact")}${ext.replace(/[^a-zA-Z0-9.]/g, "") || ".txt"}`;
}

function artifactRefFromArtifact(artifact: Artifact): ArtifactRef {
  const base = {
    id: artifact.id,
    kind: artifact.kind,
    label: artifact.label,
    summary: artifact.summary,
    previewUrl: artifact.kind === "webapp"
      ? `/api/artifacts/${encodeURIComponent(artifact.id)}/preview`
      : `/api/artifacts/${encodeURIComponent(artifact.id)}`,
  };
  if (artifact.kind === "file") {
    return {
      ...base,
      mime: artifact.mime,
      size: artifact.size,
    };
  }
  if (artifact.kind === "webapp") {
    return {
      ...base,
      surfaceKind: "webapp",
    };
  }
  if (artifact.kind === "external_embed") {
    return {
      ...base,
      previewUrl: artifact.embedUrl,
      url: artifact.url,
      embedUrl: artifact.embedUrl,
      provider: artifact.provider,
      allowFullScreen: artifact.allowFullScreen,
      surfaceKind: "external_embed",
    };
  }
  return base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function buildBridgeBootstrap(artifactId: string, initialState: Record<string, unknown>) {
  const artifactIdJson = JSON.stringify(artifactId);
  const initialStateJson = JSON.stringify(initialState);
  return `<script data-kiki-bridge="true">
(() => {
  const ARTIFACT_ID = ${artifactIdJson};
  const BRIDGE_VERSION = 1;
  let latestState = ${initialStateJson};
  const post = (message) => {
    window.parent.postMessage({
      source: "kiki-webapp",
      artifactId: ARTIFACT_ID,
      bridgeVersion: BRIDGE_VERSION,
      ...message
    }, "*");
  };
  window.KikiBridge = {
    ready() {
      post({ type: "ready" });
    },
    saveState(state, event) {
      latestState = state && typeof state === "object" && !Array.isArray(state) ? state : {};
      post({ type: "state.replace", state: latestState, event });
    },
    patchState(patch, event) {
      const safePatch = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
      latestState = { ...latestState, ...safePatch };
      post({ type: "state.patch", patch: safePatch, state: latestState, event });
    },
    reportHeight(height) {
      post({ type: "height.report", height });
    },
    fetchInternet(url, options) {
      return new Promise((resolve, reject) => {
        const requestId = "internet-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        const listener = (event) => {
          const message = event.data;
          if (!message || message.source !== "kiki-host" || message.artifactId !== ARTIFACT_ID || message.requestId !== requestId) return;
          if (message.type === "internet.fetch.result") {
            window.removeEventListener("message", listener);
            resolve(message.result);
          }
          if (message.type === "internet.fetch.error") {
            window.removeEventListener("message", listener);
            reject(new Error(message.reason || "公网请求失败"));
          }
        };
        window.addEventListener("message", listener);
        post({ type: "internet.fetch", requestId, url, options });
      });
    }
  };
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.source !== "kiki-host" || message.artifactId !== ARTIFACT_ID) return;
    if (message.type === "state.init" && message.state && typeof message.state === "object" && !Array.isArray(message.state)) {
      latestState = message.state;
      window.dispatchEvent(new CustomEvent("kiki:state", { detail: latestState }));
    }
  });
  const reportReady = () => {
    window.KikiBridge.ready();
    window.KikiBridge.reportHeight(Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, 320));
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", reportReady, { once: true });
  } else {
    reportReady();
  }
})();
</script>`;
}

function injectBridgeBootstrap(html: string, artifactId: string, initialState: Record<string, unknown>) {
  if (html.includes('data-kiki-bridge="true"')) return html;
  const bootstrap = buildBridgeBootstrap(artifactId, initialState);
  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${bootstrap}\n</body>`)
    : `${html}\n${bootstrap}\n`;
}

function normalizeInitialState(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function toArtifactRef(artifact: Artifact): ArtifactRef {
  return artifactRefFromArtifact(artifact);
}

export function persistFileArtifact(input: {
  conversationId: string;
  taskId?: string;
  instanceId?: string;
  runtimeJobId?: string;
  label: string;
  summary?: string;
  filename: string;
  mime: string;
  bytes: Buffer | string;
}) {
  const artifactId = createArtifactId();
  const workspace = ensureConversationWorkspace(input.conversationId);
  const fileName = safeFilename(input.filename);
  const artifactDir = path.join(workspace.workspaceDir, "artifacts", artifactId);
  const filePath = path.join(artifactDir, fileName);
  assertPathInsideWorkspace({ workspaceDir: workspace.workspaceDir, targetPath: filePath });
  fs.mkdirSync(artifactDir, { recursive: true });

  try {
    if (typeof input.bytes === "string") {
      writeTextFileAtomic(filePath, input.bytes.endsWith("\n") ? input.bytes : `${input.bytes}\n`);
    } else {
      fs.writeFileSync(filePath, input.bytes);
    }
    const stat = fs.statSync(filePath);
    const artifact: FileArtifact = {
      id: artifactId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      instanceId: input.instanceId,
      runtimeJobId: input.runtimeJobId,
      label: input.label,
      summary: input.summary,
      kind: "file",
      storageRelPath: path.relative(workspace.workspaceDir, filePath),
      mime: input.mime,
      size: stat.size,
      createdAt: nowIso(),
    };
    upsertArtifact(artifact);
    return artifact;
  } catch (error) {
    fs.rmSync(artifactDir, { recursive: true, force: true });
    throw error;
  }
}

export function persistExternalLink(input: {
  conversationId: string;
  taskId?: string;
  instanceId?: string;
  runtimeJobId?: string;
  label: string;
  summary?: string;
  url: string;
}) {
  ensureConversationWorkspace(input.conversationId);
  const artifact: ExternalLinkArtifact = {
    id: createArtifactId(),
    conversationId: input.conversationId,
    taskId: input.taskId,
    instanceId: input.instanceId,
    runtimeJobId: input.runtimeJobId,
    label: input.label,
    summary: input.summary,
    kind: "external_link",
    url: input.url,
    createdAt: nowIso(),
  };
  upsertArtifact(artifact);
  return artifact;
}

export function persistExternalEmbedArtifact(input: {
  conversationId: string;
  taskId?: string;
  instanceId?: string;
  runtimeJobId?: string;
  label: string;
  summary?: string;
  url: string;
}) {
  ensureConversationWorkspace(input.conversationId);
  const normalized = normalizeExternalEmbedUrl(input.url);
  const artifact: ExternalEmbedArtifact = {
    id: createArtifactId(),
    conversationId: input.conversationId,
    taskId: input.taskId,
    instanceId: input.instanceId,
    runtimeJobId: input.runtimeJobId,
    label: input.label,
    summary: input.summary,
    kind: "external_embed",
    url: normalized.url,
    embedUrl: normalized.embedUrl,
    provider: normalized.provider,
    allowFullScreen: normalized.allowFullScreen,
    createdAt: nowIso(),
  };
  upsertArtifact(artifact);
  return artifact;
}

export function persistTextBlock(input: {
  conversationId: string;
  taskId?: string;
  instanceId?: string;
  runtimeJobId?: string;
  label: string;
  summary?: string;
  inlineContent: string;
  language?: string;
}) {
  ensureConversationWorkspace(input.conversationId);
  const artifact: TextBlockArtifact = {
    id: createArtifactId(),
    conversationId: input.conversationId,
    taskId: input.taskId,
    instanceId: input.instanceId,
    runtimeJobId: input.runtimeJobId,
    label: input.label,
    summary: input.summary,
    kind: "text_block",
    inlineContent: input.inlineContent,
    language: input.language,
    createdAt: nowIso(),
  };
  upsertArtifact(artifact);
  return artifact;
}

export function persistWebAppArtifact(input: {
  conversationId: string;
  taskId?: string;
  instanceId?: string;
  runtimeJobId?: string;
  title: string;
  description?: string;
  html: string;
  initialState?: Record<string, unknown>;
  networkPolicy?: WebAppNetworkPolicy;
}) {
  const artifactId = createArtifactId();
  const workspace = ensureConversationWorkspace(input.conversationId);
  const artifactDir = path.join(workspace.workspaceDir, "artifacts", artifactId);
  const indexPath = path.join(artifactDir, "index.html");
  const manifestPath = path.join(artifactDir, "manifest.json");
  const initialStatePath = path.join(artifactDir, "state.initial.json");
  assertPathInsideWorkspace({ workspaceDir: workspace.workspaceDir, targetPath: indexPath });
  assertPathInsideWorkspace({ workspaceDir: workspace.workspaceDir, targetPath: manifestPath });
  assertPathInsideWorkspace({ workspaceDir: workspace.workspaceDir, targetPath: initialStatePath });

  if (Buffer.byteLength(input.html, "utf8") > 300 * 1024) {
    throw new Error("WebApp HTML 超过 300KB 限制");
  }

  const initialState = normalizeInitialState(input.initialState);
  const manifest: WebAppManifest = {
    schemaVersion: 1,
    title: input.title,
    description: input.description,
    bridgeVersion: 1,
    capabilities: input.networkPolicy === "internet"
      ? ["state.read", "state.write", "event.emit", "height.report", "internet.fetch"]
      : ["state.read", "state.write", "event.emit", "height.report"],
    networkPolicy: input.networkPolicy ?? "offline",
    initialState,
  };
  const manifestContent = JSON.stringify(manifest, null, 2);
  if (Buffer.byteLength(manifestContent, "utf8") > 30 * 1024) {
    throw new Error("WebApp manifest 超过 30KB 限制");
  }

  fs.mkdirSync(artifactDir, { recursive: true });
  try {
    writeTextFileAtomic(indexPath, injectBridgeBootstrap(input.html, artifactId, initialState));
    writeTextFileAtomic(manifestPath, manifestContent);
    writeTextFileAtomic(initialStatePath, JSON.stringify(initialState, null, 2));
    const artifact: WebAppArtifact = {
      id: artifactId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      instanceId: input.instanceId,
      runtimeJobId: input.runtimeJobId,
      label: input.title,
      summary: input.description,
      kind: "webapp",
      storageRelPath: path.relative(workspace.workspaceDir, artifactDir),
      entryFile: "index.html",
      manifest,
      createdAt: nowIso(),
    };
    upsertArtifact(artifact);
    upsertArtifactInteractionState({
      artifactId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      instanceId: input.instanceId,
      state: initialState,
      events: [],
    });
    return artifact;
  } catch (error) {
    fs.rmSync(artifactDir, { recursive: true, force: true });
    throw error;
  }
}

export function resolveArtifactFilePath(artifact: FileArtifact) {
  const workspaceDir = getConversationWorkspaceDir(artifact.conversationId);
  const fullPath = path.join(workspaceDir, artifact.storageRelPath);
  assertPathInsideWorkspace({ workspaceDir, targetPath: fullPath });
  return fullPath;
}

export function resolveWebAppEntryPath(artifact: WebAppArtifact) {
  const workspaceDir = getConversationWorkspaceDir(artifact.conversationId);
  const fullPath = path.join(workspaceDir, artifact.storageRelPath, artifact.entryFile);
  assertPathInsideWorkspace({ workspaceDir, targetPath: fullPath });
  return fullPath;
}
