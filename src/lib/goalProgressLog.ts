export function appendGoalProgressMessage(current: string, next: string) {
  const progress = next.trim();
  if (!progress) return current;

  const existing = current.trimEnd();
  if (!existing) return progress;

  const lines = existing
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (lastLine === progress) return existing;

  return `${existing}\n${progress}`;
}
