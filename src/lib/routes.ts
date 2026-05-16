export function goalDetailPath(goalId: string) {
  return `/goals/${encodeURIComponent(goalId)}`;
}

export function taskDetailPath(goalId: string, taskId: string) {
  return `${goalDetailPath(goalId)}/tasks/${encodeURIComponent(taskId)}`;
}

export function taskDrawerReturnPath(goalId: string, taskId: string) {
  return `${goalDetailPath(goalId)}?drawerTaskId=${encodeURIComponent(taskId)}`;
}
