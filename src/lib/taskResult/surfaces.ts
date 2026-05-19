import type { ResultSurfaceKind, Task, TaskExpectedResult } from "@/types/kiki";
import type { TaskResult } from "@/types/taskResult";

const ALL_SURFACES: ResultSurfaceKind[] = ["interactive", "files"];

function uniqSurfaces(values: ResultSurfaceKind[]) {
  return ALL_SURFACES.filter((surface) => values.includes(surface));
}

export function resolveExpectedSurfaces(expectedResult?: TaskExpectedResult): ResultSurfaceKind[] {
  if (expectedResult?.surfaces?.length) {
    return uniqSurfaces(expectedResult.surfaces);
  }
  if (expectedResult?.deliveryMode === "file") {
    return ["files"];
  }
  return ["interactive"];
}

export function taskExpectedSurfaces(task: Task) {
  return resolveExpectedSurfaces(task.expectedResult);
}

export function hasExpectedSurface(task: Task, surface: ResultSurfaceKind) {
  return taskExpectedSurfaces(task).includes(surface);
}

export function resolveActualSurfaces(taskResult?: TaskResult | null): ResultSurfaceKind[] {
  const surfaces: ResultSurfaceKind[] = [];
  if ((taskResult?.blocks?.length ?? 0) > 0) surfaces.push("interactive");
  if ((taskResult?.artifactRefs?.length ?? 0) > 0) surfaces.push("files");
  return surfaces;
}
