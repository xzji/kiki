import type { RuntimeEnvironment } from "@/types/runtime";

export const INITIAL_RUNTIME_ENVIRONMENTS: RuntimeEnvironment[] = [
  {
    id: "env-cloud-kiki",
    type: "cloud",
    name: "KiKi Cloud Agent",
    workingDirectory: "workspace-prod",
    cliPath: "kiki-agent",
    permissionMode: "readonly",
    health: { status: "offline", reason: "云端环境暂未接入真实服务" },
  },
];
