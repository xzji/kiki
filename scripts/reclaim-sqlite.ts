#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { logger } from "@/lib/server/db/storageMaintenanceLogger";
import { inspectDbStorage, runFullCompaction } from "@/lib/server/db/storageMaintenance";

export type ReclaimSqliteArgs =
  | {
      ok: true;
      apply: boolean;
      dbPath: string;
      userId?: string;
    }
  | {
      ok: false;
      error: string;
    };

type ReclaimSqliteEnv = Record<string, string | undefined>;

const USAGE = `Usage:
  pnpm reclaim:sqlite -- --user <id> [--apply]
  pnpm reclaim:sqlite -- --path <db> [--apply]

Default mode is dry-run. Full compaction only runs when --apply is provided.`;

export function usageText() {
  return USAGE;
}

function valueAfterFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

export function pathForUserDatabase(userId: string, env: ReclaimSqliteEnv = process.env, cwd = process.cwd()) {
  const dataRoot = env.KIKI_DATA_DIR?.trim() || path.resolve(cwd, "data");
  return path.join(dataRoot, "users", userId, "kiki.db");
}

export function parseReclaimSqliteArgs(args: string[], env: ReclaimSqliteEnv = process.env, cwd = process.cwd()): ReclaimSqliteArgs {
  const allowedFlags = new Set(["--user", "--path", "--apply"]);
  const unknownFlag = args.find((arg) => arg.startsWith("--") && !allowedFlags.has(arg));
  if (unknownFlag) {
    return { ok: false, error: `Unknown argument: ${unknownFlag}` };
  }

  const userId = valueAfterFlag(args, "--user");
  const explicitPath = valueAfterFlag(args, "--path");
  const hasUserFlag = args.includes("--user");
  const hasPathFlag = args.includes("--path");

  if ((hasUserFlag && !userId) || (hasPathFlag && !explicitPath)) {
    return { ok: false, error: "Missing value for --user or --path." };
  }

  if ((userId && explicitPath) || (!userId && !explicitPath)) {
    return { ok: false, error: "Provide exactly one of --user <id> or --path <db>." };
  }

  if (explicitPath) {
    return {
      ok: true,
      apply: args.includes("--apply"),
      dbPath: path.resolve(cwd, explicitPath),
    };
  }

  if (userId) {
    return {
      ok: true,
      apply: args.includes("--apply"),
      dbPath: pathForUserDatabase(userId, env, cwd),
      userId,
    };
  }

  return { ok: false, error: "Provide exactly one of --user <id> or --path <db>." };
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function printError(error: unknown) {
  if (error instanceof Error) {
    console.error(error.message);
    if (error.cause) {
      console.error(error.cause);
    }
    return;
  }
  console.error(String(error));
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseReclaimSqliteArgs(argv);
  if (!parsed.ok) {
    logger.info("script:args_invalid", { argv, error: parsed.error });
    console.error(parsed.error);
    console.error(usageText());
    process.exit(1);
  }

  try {
    if (parsed.apply) {
      logger.info("script:apply:start", { dbPath: parsed.dbPath, userId: parsed.userId });
      const result = runFullCompaction({ userId: parsed.userId, dbPath: parsed.dbPath });
      logger.info("script:apply:done", {
        dbPath: parsed.dbPath,
        userId: parsed.userId,
        reclaimedBytes: result.reclaimedBytes,
        beforeBytes: result.before.totalBytes,
        afterBytes: result.after.totalBytes,
      });
      printJson({
        dbPath: parsed.dbPath,
        before: result.before,
        after: result.after,
        reclaimedBytes: result.reclaimedBytes,
      });
      return;
    }

    logger.info("script:dry_run:start", { dbPath: parsed.dbPath, userId: parsed.userId });
    const metrics = inspectDbStorage(parsed.dbPath);
    logger.info("script:dry_run:done", {
      dbPath: parsed.dbPath,
      userId: parsed.userId,
      totalBytes: metrics.totalBytes,
      reclaimableBytes: metrics.reclaimableBytes,
      autoVacuum: metrics.autoVacuum,
    });
    printJson(metrics);
  } catch (error) {
    logger.info("script:failed", {
      dbPath: parsed.dbPath,
      userId: parsed.userId,
      apply: parsed.apply,
      error: error instanceof Error ? error.message : String(error),
    });
    printError(error);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
