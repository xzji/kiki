export type ArtifactKind = "text_block" | "file" | "external_link" | "webapp" | "external_embed";

export type WebAppCapability = "state.read" | "state.write" | "event.emit" | "height.report" | "internet.fetch";
export type WebAppNetworkPolicy = "offline" | "internet";
export type ExternalEmbedProvider = "youtube" | "generic";

export type WebAppManifest = {
  schemaVersion: 1;
  title: string;
  description?: string;
  bridgeVersion: 1;
  capabilities: WebAppCapability[];
  networkPolicy?: WebAppNetworkPolicy;
  allowedHosts?: string[];
  initialState?: Record<string, unknown>;
};

export type ArtifactCommon = {
  id: string;
  conversationId: string;
  taskId?: string;
  instanceId?: string;
  runtimeJobId?: string;
  label: string;
  summary?: string;
  createdAt: string;
};

export type FileArtifact = ArtifactCommon & {
  kind: "file";
  storageRelPath: string;
  mime: string;
  size: number;
};

export type ExternalLinkArtifact = ArtifactCommon & {
  kind: "external_link";
  url: string;
};

export type TextBlockArtifact = ArtifactCommon & {
  kind: "text_block";
  inlineContent: string;
  language?: string;
};

export type WebAppArtifact = ArtifactCommon & {
  kind: "webapp";
  storageRelPath: string;
  entryFile: "index.html";
  manifest?: WebAppManifest;
};

export type ExternalEmbedArtifact = ArtifactCommon & {
  kind: "external_embed";
  url: string;
  embedUrl: string;
  provider: ExternalEmbedProvider;
  allowFullScreen?: boolean;
};

export type Artifact = FileArtifact | ExternalLinkArtifact | TextBlockArtifact | WebAppArtifact | ExternalEmbedArtifact;

export type ArtifactRef = {
  id: string;
  kind: ArtifactKind;
  label: string;
  summary?: string;
  mime?: string;
  size?: number;
  previewUrl?: string;
  provider?: ExternalEmbedProvider;
  embedUrl?: string;
  url?: string;
  allowFullScreen?: boolean;
  surfaceKind?: "webapp" | "external_embed";
};
