export type MachineRecord = {
  id: string;
  userId: string;
  name: string | null;
  fingerprint: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  online: boolean;
};

export type CreateMachineResult = {
  ok: boolean;
  machine: MachineRecord;
  apiKey: string;
  connectCommand: string;
};

export type ListMachinesResult = {
  ok: boolean;
  machines: MachineRecord[];
};

export async function listMachines(): Promise<ListMachinesResult> {
  const response = await fetch("/api/machines", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("获取已连接电脑失败");
  }
  return (await response.json()) as ListMachinesResult;
}

export async function deleteMachine(machineId: string): Promise<{ ok: boolean }> {
  const response = await fetch(`/api/machines/${encodeURIComponent(machineId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "删除机器失败");
  }
  return (await response.json()) as { ok: boolean };
}

export async function createMachine(input?: { name?: string }): Promise<CreateMachineResult> {
  const response = await fetch("/api/machines", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "创建连接失败");
  }
  return (await response.json()) as CreateMachineResult;
}
