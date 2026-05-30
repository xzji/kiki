export function stripNotificationPrefix(snippet?: string | null) {
  if (!snippet) return "";
  return snippet.replace(/^\[(需要作答|需要确认|待补充|待完成)\]\s*/, "").trim();
}

export function normalizeDisplayText(value: string) {
  return value
    .replace(/[“”"「」『』《》\[\]【】]/g, "")
    .replace(/[，。！？；：、,.\s]/g, "")
    .trim();
}

export function isSameDisplayText(left: string, right: string) {
  const normalizedLeft = normalizeDisplayText(left);
  const normalizedRight = normalizeDisplayText(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function isOverlappingDisplayText(left: string, right: string) {
  const normalizedLeft = normalizeDisplayText(left);
  const normalizedRight = normalizeDisplayText(right);
  return Boolean(
    normalizedLeft &&
      normalizedRight &&
      (normalizedLeft === normalizedRight ||
        normalizedLeft.includes(normalizedRight) ||
        normalizedRight.includes(normalizedLeft)),
  );
}
