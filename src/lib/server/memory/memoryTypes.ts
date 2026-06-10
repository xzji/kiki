export type MemoryConfidence = "low" | "medium" | "high";

export type MemoryDigestResult = {
  sessionPatch?: {
    role?: string[];
    goals?: string[];
    facts?: string[];
    openItems?: string[];
    decisions?: string[];
    remove?: string[];
  };
  userPatch?: UserMemoryPatch[];
  profileBaseHash?: string;
  confidence: MemoryConfidence;
};

export type UserMemoryPatch = {
  op: "add" | "replace" | "remove";
  section:
    | "communicationPreferences"
    | "workPreferences"
    | "projectPreferences"
    | "longTermFacts"
    | "prohibitions";
  content?: string;
  oldText?: string;
  reason: string;
  confidence: MemoryConfidence;
};

export type MemoryReadResult = {
  content: string;
  hash: string;
  exists: boolean;
};
