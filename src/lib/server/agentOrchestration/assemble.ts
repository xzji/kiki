import type { ResultBlock, TaskResult } from "@/types/taskResult";

type AssemblyPlan = {
  order?: string[];
  keepBlockIds?: string[];
  dropBlockIds?: string[];
  prependBlocks?: ResultBlock[];
  appendBlocks?: ResultBlock[];
  titleOverride?: string;
  metaOverrides?: Partial<TaskResult["meta"]>;
};

type CandidateBlock = ResultBlock & {
  id?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function blockKey(block: CandidateBlock, index: number) {
  return block.id || `block-${index + 1}`;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function normalizeBlockList(value: unknown): ResultBlock[] {
  return Array.isArray(value)
    ? value.filter((item): item is ResultBlock => isRecord(item) && typeof item.kind === "string")
    : [];
}

export function extractCandidateBlocks(value: unknown): ResultBlock[] {
  const record = isRecord(value) ? value : null;
  if (!record) return [];
  const direct = normalizeBlockList(record.candidateBlocks);
  if (direct.length) return direct;
  const candidateResult = isRecord(record.candidateResult) ? record.candidateResult : null;
  const nested = normalizeBlockList(candidateResult?.blocks);
  return nested;
}

export function normalizeAssemblyPlan(value: unknown): AssemblyPlan {
  const record = isRecord(value) ? value : {};
  const raw = isRecord(record.assemblyPlan) ? record.assemblyPlan : record;
  const plan: AssemblyPlan = {};
  const order = stringArray(raw.order);
  const keepBlockIds = stringArray(raw.keepBlockIds);
  const dropBlockIds = stringArray(raw.dropBlockIds);
  const prependBlocks = normalizeBlockList(raw.prependBlocks);
  const appendBlocks = normalizeBlockList(raw.appendBlocks);
  if (order.length) plan.order = order;
  if (keepBlockIds.length) plan.keepBlockIds = keepBlockIds;
  if (dropBlockIds.length) plan.dropBlockIds = dropBlockIds;
  if (prependBlocks.length) plan.prependBlocks = prependBlocks;
  if (appendBlocks.length) plan.appendBlocks = appendBlocks;
  if (typeof raw.titleOverride === "string" && raw.titleOverride.trim()) {
    plan.titleOverride = raw.titleOverride.trim();
  }
  if (isRecord(raw.metaOverrides)) {
    plan.metaOverrides = raw.metaOverrides as Partial<TaskResult["meta"]>;
  }
  return plan;
}

export function assembleFinalTaskResult(input: {
  base: TaskResult;
  candidateBlocks: ResultBlock[];
  plan?: AssemblyPlan;
}): TaskResult {
  const plan = input.plan ?? {};
  const drop = new Set(plan.dropBlockIds ?? []);
  const keep = plan.keepBlockIds?.length ? new Set(plan.keepBlockIds) : null;
  // 把稳定 key 绑定到每个 block 上随对象流转。drop/keep 过滤必须用这个稳定 key，
  // 不能在重排后用新 index 重算——否则无 id 的 block 在 order 重排时会按位置错配删/留。
  const keyed = input.candidateBlocks.map((block, index) => ({
    key: blockKey(block as CandidateBlock, index),
    block,
  }));
  const byKey = new Map(keyed.map((item) => [item.key, item]));
  const orderedKeys = plan.order?.length ? plan.order : keyed.map((item) => item.key);
  const used = new Set<string>();
  const ordered = orderedKeys
    .map((key) => {
      used.add(key);
      return byKey.get(key);
    })
    .filter((item): item is { key: string; block: ResultBlock } => Boolean(item));
  const remaining = keyed.filter((item) => !used.has(item.key));
  const body = [...ordered, ...remaining]
    .filter((item) => {
      if (drop.has(item.key)) return false;
      if (keep && !keep.has(item.key)) return false;
      return true;
    })
    .map((item) => item.block);
  return {
    ...input.base,
    title: plan.titleOverride || input.base.title,
    blocks: [...(plan.prependBlocks ?? []), ...body, ...(plan.appendBlocks ?? [])],
    meta: {
      ...input.base.meta,
      ...(plan.metaOverrides ?? {}),
    },
  };
}
