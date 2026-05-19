import type { DependencyDigest, DependencyView, TaskExecutionContext } from "@/lib/server/taskExecution/types";

function renderDigest(digest: DependencyDigest) {
  const lines = [`  - 概述：${digest.summary}`];
  if (digest.userDecision) lines.push(`  - 用户决策：${digest.userDecision}`);
  if (digest.keyPoints.length) {
    lines.push("  - 关键要点：");
    lines.push(...digest.keyPoints.map((point) => `    - ${point}`));
  }
  if (digest.tableRows?.length) {
    lines.push("  - 对比表摘录：");
    lines.push(...digest.tableRows.map((row) => `    - ${JSON.stringify(row)}`));
  }
  if (digest.keyValues?.length) {
    lines.push("  - 键值信息：");
    lines.push(...digest.keyValues.map((entry) => `    - ${entry.key}: ${entry.value}`));
  }
  if (digest.lists?.length) {
    lines.push("  - 清单摘录：");
    for (const list of digest.lists) {
      lines.push(`    - ${list.heading ? `${list.heading}: ` : ""}${list.items.join("；")}`);
    }
  }
  if (digest.artifacts.length) {
    lines.push("  - 关键产物：");
    lines.push(...digest.artifacts.map((artifact) => `    - ${artifact.label}${artifact.localPath ? `（路径：${artifact.localPath}）` : ""}`));
  }
  lines.push(`  - 完整结果文件：${digest.resultPointer.relativePath}`);
  return lines.join("\n");
}

function renderDependency(dependency: DependencyView) {
  const header = `- ${dependency.ref.title}（task id: ${dependency.ref.taskId}，状态：${dependency.status}）`;
  if (!dependency.digest) {
    return [header, `  - 预期产出：${dependency.ref.expectedOutcome}`, dependency.blocker ? `  - 阻塞原因：${dependency.blocker.reason}` : ""]
      .filter(Boolean)
      .join("\n");
  }
  return [header, renderDigest(dependency.digest)].join("\n");
}

export function renderDependencySection(context: TaskExecutionContext) {
  if (!context.dependencies.length) return "无依赖任务。";
  const hasDigest = context.dependencies.some((dependency) => dependency.digest);
  const title = hasDigest ? "依赖任务结论（必须直接复用）：" : "依赖任务：";
  return [title, ...context.dependencies.map(renderDependency)].join("\n");
}

export function renderWorkspaceHint(context: TaskExecutionContext) {
  if (!context.workspace?.dependenciesDir) return "";
  const prefix = `${context.workspace.taskWorkspaceDir}/`;
  const relative = context.workspace.dependenciesDir.startsWith(prefix)
    ? context.workspace.dependenciesDir.slice(prefix.length)
    : "dependencies";
  return `已就绪的依赖任务结果位于：./${relative}`;
}

export function renderDependencyReuseInstruction(context: TaskExecutionContext) {
  if (!context.dependencies.some((dependency) => dependency.digest)) return "";
  return "8. 如果依赖任务结论中已经给出某关键事实（含用户决策），必须直接复用，不得重复检索或再次询问。";
}
