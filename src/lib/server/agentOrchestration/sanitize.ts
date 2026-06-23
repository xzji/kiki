import { sanitizeTaskResultOutput } from "@/lib/taskResult/outputSanitizer";
import type { TaskResult } from "@/types/taskResult";

export function sanitizeDeliverableMetaNarration(taskResult: TaskResult): TaskResult {
  return sanitizeTaskResultOutput(taskResult);
}
