import fs from "fs";
import path from "path";

import { renderDependencySection } from "@/lib/server/taskExecution/contextRenderer";
import type { TaskExecutionContext } from "@/lib/server/taskExecution/types";
import {
  ensureTaskWorkspace,
  writeJsonFileAtomic,
  writeTextFileAtomic,
} from "@/lib/server/workspace/conversationWorkspace";

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function materializeTaskExecutionContext(context: TaskExecutionContext) {
  const instance = context.inputs.instance;
  if (!instance) return context;

  const taskWorkspaceDir = ensureTaskWorkspace({
    conversationId: context.identity.conversationId,
    taskId: context.identity.taskId,
    instanceId: instance.id,
  });
  const dependenciesDir = ensureDir(path.join(taskWorkspaceDir, "dependencies"));
  const artifactsDir = ensureDir(path.join(taskWorkspaceDir, "artifacts"));

  const nextContext: TaskExecutionContext = {
    ...context,
    workspace: {
      taskWorkspaceDir,
      dependenciesDir,
      artifactsDir,
    },
  };

  for (const dependency of nextContext.dependencies) {
    if (!dependency.digest) continue;
    const dependencyDir = ensureDir(path.join(dependenciesDir, dependency.ref.taskId));
    writeTextFileAtomic(path.join(dependencyDir, "summary.md"), `${renderDependencySection({
      ...nextContext,
      dependencies: [dependency],
    })}\n`);
    const targetResultPath = path.join(dependencyDir, "result.json");
    if (dependency.digest.sourceResultFilePath && fs.existsSync(dependency.digest.sourceResultFilePath)) {
      fs.copyFileSync(dependency.digest.sourceResultFilePath, targetResultPath);
    } else {
      writeJsonFileAtomic(targetResultPath, {
        summary: dependency.digest.summary,
        userDecision: dependency.digest.userDecision,
        keyPoints: dependency.digest.keyPoints,
        tableRows: dependency.digest.tableRows,
        keyValues: dependency.digest.keyValues,
        lists: dependency.digest.lists,
        artifacts: dependency.digest.artifacts,
      });
    }
  }

  writeJsonFileAtomic(path.join(taskWorkspaceDir, "context.json"), nextContext);
  return nextContext;
}
