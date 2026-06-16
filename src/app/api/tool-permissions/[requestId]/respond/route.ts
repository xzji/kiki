import { NextRequest, NextResponse } from "next/server";

import { INITIAL_RUNTIME_ENVIRONMENTS } from "@/lib/runtime/defaultRuntimeEnvironments";
import { normalizeRuntimeFilePolicy } from "@/lib/runtime/toolPolicy";
import { readRuntimeEnvironmentsSnapshot } from "@/lib/server/runtime/stateSnapshot";
import {
  applyRuntimeEnvironmentCommand,
  RuntimeEnvironmentCommandError,
} from "@/lib/server/services/runtimeEnvironmentCommandService";
import { withAuth } from "@/lib/server/http/withAuth";
import { addSessionToolPermissionRule, getToolPermissionSessionKey } from "@/lib/server/toolPermission/sessionToolPermissionStore";
import { appendToolPermissionAuditLog } from "@/lib/server/toolPermission/toolPermissionAuditLog";
import {
  getPendingToolPermissionRequest,
  getToolPermissionRequestState,
  resolveToolPermissionDecision,
} from "@/lib/server/toolPermission/toolPermissionBroker";
import type { ToolPermissionScope } from "@/lib/server/toolPermission/types";
import { resumeBlockedTask } from "@/lib/server/taskExecution/resumeBlockedTask";
import { getTunnelHub } from "@/lib/server/tunnel/tunnelHub";
import { makeId } from "@/lib/utils";

export const runtime = "nodejs";

type Params = {
  params: { requestId: string };
  userId?: string;
};

type Body = {
  decision?: "allow" | "deny";
  scope?: ToolPermissionScope;
  rule?: string;
  runtimeEnvId?: string;
};

function findRuntimeEnvironment(runtimeEnvId: string) {
  const environments = readRuntimeEnvironmentsSnapshot(INITIAL_RUNTIME_ENVIRONMENTS);
  return environments.find((environment) => environment.id === runtimeEnvId) ?? null;
}

async function POSTHandler(request: NextRequest, context: Params) {
  const requestId = context.params.requestId;
  const body = (await request.json()) as Body;
  const pending = getPendingToolPermissionRequest(requestId);
  if (!pending) {
    return NextResponse.json({ ok: false, reason: "该工具授权请求已过期或不存在" }, { status: 404 });
  }
  if (body.runtimeEnvId && body.runtimeEnvId !== pending.runtimeEnvId) {
    return NextResponse.json({ ok: false, reason: "Runtime 环境不匹配" }, { status: 400 });
  }
  const runtimeEnvId = pending.runtimeEnvId;
  const requestState = getToolPermissionRequestState(requestId);
  const isDetached = requestState === "detached";
  const scope = body.scope ?? (body.decision === "deny" ? "deny" : "once");
  const decision = body.decision ?? (scope === "deny" ? "deny" : "allow");
  const rule = (body.rule ?? pending.suggestedRule ?? pending.toolName ?? "").trim();

  if (!runtimeEnvId) {
    return NextResponse.json({ ok: false, reason: "缺少 runtimeEnvId" }, { status: 400 });
  }
  if (decision === "allow" && !rule) {
    return NextResponse.json({ ok: false, reason: "缺少工具授权规则" }, { status: 400 });
  }

  try {
    if (decision === "allow" && (scope === "conversation" || (isDetached && scope === "once" && pending.taskInstanceId))) {
      addSessionToolPermissionRule(
        getToolPermissionSessionKey({
          conversationId: pending.conversationId,
          taskInstanceId: pending.taskInstanceId,
          runtimeEnvId,
        }),
        {
          id: makeId("tool-rule"),
          pattern: rule,
          label: rule,
          source: "user",
          createdAt: new Date().toISOString(),
        },
      );
    }

    if (decision === "allow" && scope === "runtime") {
      const environment = findRuntimeEnvironment(runtimeEnvId);
      if (!environment) {
        return NextResponse.json({ ok: false, reason: "未找到 Runtime 环境" }, { status: 404 });
      }
      const filePolicy = normalizeRuntimeFilePolicy(environment.filePolicy);
      if (!filePolicy.allowedToolRules?.some((item) => item.pattern === rule)) {
        filePolicy.allowedToolRules = [
          ...(filePolicy.allowedToolRules ?? []),
          {
            id: makeId("tool-rule"),
            pattern: rule,
            label: rule,
            source: "user",
            createdAt: new Date().toISOString(),
          },
        ];
        applyRuntimeEnvironmentCommand({
          type: "update_environment",
          id: runtimeEnvId,
          patch: { filePolicy },
        });
      }
    }

    appendToolPermissionAuditLog({
      requestId,
      event: decision === "allow" ? "tool_permission.user_allowed" : "tool_permission.user_denied",
      runtimeEnvId,
      runtimeKind: pending?.runtimeKind,
      userId: context.userId,
      conversationId: pending?.conversationId,
      taskInstanceId: pending?.taskInstanceId,
      taskId: pending?.taskId,
      agentRunId: pending?.agentRunId,
      daemonSessionId: pending?.daemonSessionId,
      machineIdHash: pending?.machineIdHash,
      toolName: pending?.toolName,
      toolInput: pending?.toolInput,
      rule: decision === "allow" ? rule : undefined,
      scope,
      decision,
      matchedBy: "user",
    });

    const resolvedDecision = {
      requestId,
      decision,
      scope,
      rule: decision === "allow" ? rule : undefined,
    };

    let resolvedLiveRequest = false;
    let resumeResult: Awaited<ReturnType<typeof resumeBlockedTask>> | null = null;

    if (isDetached) {
      if (!pending.taskInstanceId) {
        resolveToolPermissionDecision(resolvedDecision);
        return NextResponse.json({ ok: false, reason: "该会话授权请求已失效，请重新发送消息" }, { status: 410 });
      }
      resumeResult = await resumeBlockedTask({
        taskInstanceId: pending.taskInstanceId,
        resumeToken: requestId,
        approved: decision === "allow",
        action: decision === "allow" ? "tool_permission_allowed" : "tool_permission_denied",
        feedback:
          decision === "allow"
            ? `用户已授权工具 ${pending.toolName}，授权规则：${rule}。请继续执行任务。`
            : `用户拒绝授权工具 ${pending.toolName}。请不要使用该工具，尝试可行的替代方案；如果无法完成，请说明阻塞原因。`,
      });
      if (resumeResult.status >= 400) {
        return NextResponse.json(
          { ok: false, reason: resumeResult.body.reason ?? "工具授权已处理，但任务恢复失败" },
          { status: resumeResult.status },
        );
      }
      resolvedLiveRequest = resolveToolPermissionDecision(resolvedDecision);
      appendToolPermissionAuditLog({
        requestId,
        event: "tool_permission.resumed",
        runtimeEnvId,
        runtimeKind: pending.runtimeKind,
        userId: context.userId,
        conversationId: pending.conversationId,
        taskInstanceId: pending.taskInstanceId,
        taskId: pending.taskId,
        agentRunId: pending.agentRunId,
        daemonSessionId: pending.daemonSessionId,
        machineIdHash: pending.machineIdHash,
        toolName: pending.toolName,
        rule: decision === "allow" ? rule : undefined,
        scope,
        decision,
        matchedBy: "user",
      });
    } else {
      resolvedLiveRequest = resolveToolPermissionDecision(resolvedDecision);
      if (pending.machineId && pending.streamSessionId) {
        getTunnelHub().sendToolPermissionDecision({
          machineId: pending.machineId,
          sessionId: pending.streamSessionId,
          decision: resolvedDecision,
        });
        appendToolPermissionAuditLog({
          requestId,
          event: "tool_permission.resumed",
          runtimeEnvId,
          runtimeKind: pending.runtimeKind,
          userId: context.userId,
          conversationId: pending.conversationId,
          taskInstanceId: pending.taskInstanceId,
          taskId: pending.taskId,
          agentRunId: pending.agentRunId,
          daemonSessionId: pending.daemonSessionId,
          machineIdHash: pending.machineIdHash,
          toolName: pending.toolName,
          rule: decision === "allow" ? rule : undefined,
          scope,
          decision,
          matchedBy: "user",
        });
      }
    }

    return NextResponse.json({
      ok: true,
      decision,
      scope,
      rule: decision === "allow" ? rule : undefined,
      resumed: Boolean(resumeResult?.body.resumed),
      liveRequest: resolvedLiveRequest,
    });
  } catch (error) {
    if (error instanceof RuntimeEnvironmentCommandError) {
      return NextResponse.json({ ok: false, reason: error.message, ...error.details }, { status: error.status });
    }
    return NextResponse.json({ ok: false, reason: "工具权限决策提交失败" }, { status: 500 });
  }
}

export const POST = withAuth(POSTHandler);
