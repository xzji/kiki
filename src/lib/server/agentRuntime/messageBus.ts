/**
 * messageBus — inter-role structured message passing.
 *
 * Plan ref: §3.1.4. In this MVP the bus is a thin wrapper around
 * `agent_messages` persistence; it provides synchronous send/poll semantics for
 * the saga steps that run in-process. Cross-process delivery is out of scope.
 */

import {
  appendAgentMessage,
  listMessagesBySaga,
} from "@/lib/server/repositories/agentRuntime/agentMessagesRepository";
import type { AgentMessage, AgentMessageKind, AgentRunRole } from "@/types/agentRuntime";

export type SendMessageInput = {
  sagaInstanceId: string;
  fromRole: AgentRunRole;
  toRole: AgentRunRole;
  kind: AgentMessageKind;
  payload: Record<string, unknown>;
};

export function sendMessage(input: SendMessageInput): AgentMessage {
  return appendAgentMessage(input);
}

export function listSagaMessages(sagaInstanceId: string): AgentMessage[] {
  return listMessagesBySaga(sagaInstanceId);
}

/** Return the latest message addressed to a particular role within a saga. */
export function findLatestMessageTo(
  sagaInstanceId: string,
  role: AgentRunRole,
): AgentMessage | null {
  const messages = listMessagesBySaga(sagaInstanceId);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].toRole === role) return messages[i];
  }
  return null;
}
