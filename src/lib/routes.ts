export function topicDetailPath(topicId: string) {
  return `/topics/${encodeURIComponent(topicId)}`;
}

export function topicTaskDetailPath(topicId: string, taskId: string) {
  return `${topicDetailPath(topicId)}/tasks/${encodeURIComponent(taskId)}`;
}

export function topicTaskDrawerReturnPath(topicId: string, taskId: string) {
  return `${topicDetailPath(topicId)}?drawerTaskId=${encodeURIComponent(taskId)}`;
}

export type RouteSearchParams = Record<string, string | string[] | undefined>;

export function appendRouteQuery(target: string, searchParams?: RouteSearchParams) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (typeof value === "string") query.append(key, value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") query.append(key, item);
      }
    }
  }
  const queryString = query.toString();
  return queryString ? `${target}?${queryString}` : target;
}

function safeDecodeRouteParam(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function legacyGoalDetailRedirectPath(topicId: string, searchParams?: RouteSearchParams) {
  return appendRouteQuery(topicDetailPath(safeDecodeRouteParam(topicId)), searchParams);
}

export function legacyGoalTaskRedirectPath(
  topicId: string,
  taskId: string,
  searchParams?: RouteSearchParams,
) {
  return appendRouteQuery(
    topicTaskDetailPath(safeDecodeRouteParam(topicId), safeDecodeRouteParam(taskId)),
    searchParams,
  );
}

/**
 * Deprecated Goal-named aliases kept for transition compatibility.
 * They intentionally point at the canonical /topics routes after PR16.
 */
export const goalDetailPath = topicDetailPath;
export const taskDetailPath = topicTaskDetailPath;
export const taskDrawerReturnPath = topicTaskDrawerReturnPath;
