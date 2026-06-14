import assert from "node:assert/strict";

import {
  getTunnelHub,
  registerMachineWsConnection,
  takeMachineCommands,
  unregisterMachineWsConnection,
  type MachineCommand,
} from "@/lib/server/tunnel/tunnelHub";
import { isMachineTunnelEnvelope } from "@/lib/server/tunnel/machineTunnelProtocol";

export async function runMachineTunnelSpecs() {
  const machineId = `machine-spec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const userId = "user-machine-tunnel-spec";
  const sent: MachineCommand[] = [];
  const sender = (command: MachineCommand) => {
    sent.push(command);
    return true;
  };

  registerMachineWsConnection({ machineId, userId, sender });
  assert.equal(getTunnelHub().isMachineOnline(machineId, userId), true);
  assert.deepEqual(getTunnelHub().getOnlineMachineIdsForUser(userId), [machineId]);
  getTunnelHub().sendExecute({
    machineId,
    jobId: "job-ws",
    requestId: "request-ws",
    payload: { ok: true },
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: "execute",
    jobId: "job-ws",
    requestId: "request-ws",
    payload: { ok: true },
  });
  assert.deepEqual(await takeMachineCommands(machineId, 1), []);

  unregisterMachineWsConnection(machineId, sender);
  assert.equal(getTunnelHub().isMachineOnline(machineId, userId), false);
  assert.deepEqual(getTunnelHub().getOnlineMachineIdsForUser(userId), []);
  getTunnelHub().sendExecute({
    machineId,
    jobId: "job-poll",
    requestId: "request-poll",
    payload: { fallback: true },
  });

  assert.deepEqual(await takeMachineCommands(machineId, 1), [
    {
      type: "execute",
      jobId: "job-poll",
      requestId: "request-poll",
      payload: { fallback: true },
    },
  ]);

  getTunnelHub().sendExecute({
    machineId,
    jobId: "job-drain",
    requestId: "request-drain",
    payload: { drain: true },
  });
  registerMachineWsConnection({ machineId, userId, sender });
  assert.deepEqual(sent[1], {
    type: "execute",
    jobId: "job-drain",
    requestId: "request-drain",
    payload: { drain: true },
  });
  assert.deepEqual(await takeMachineCommands(machineId, 1), []);
  unregisterMachineWsConnection(machineId, sender);

  assert.equal(
    isMachineTunnelEnvelope({ kind: "hello", runningJobIds: [], runningGovernanceJobIds: [] }),
    true,
  );
  assert.equal(isMachineTunnelEnvelope({ nope: true }), false);
}
