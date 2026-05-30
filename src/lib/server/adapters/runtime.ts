import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export type RuntimeSpawnInput = {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

export type RuntimeHandle = {
  process: ChildProcess;
  pid?: number;
};

export interface RuntimeAdapter {
  mode: "local" | "tunnel";
  spawnTask(input: RuntimeSpawnInput): RuntimeHandle;
}

// CLOUD-MIGRATION: 替换实现时不应改调用方接口。
export class LocalSpawnRuntimeAdapter implements RuntimeAdapter {
  mode = "local" as const;

  spawnTask(input: RuntimeSpawnInput): RuntimeHandle {
    const child = spawn(input.command, input.args ?? [], {
      cwd: input.cwd,
      env: input.env,
      stdio: "pipe",
    });
    return { process: child, pid: child.pid };
  }
}

export function getRuntimeAdapter(): RuntimeAdapter {
  return new LocalSpawnRuntimeAdapter();
}
