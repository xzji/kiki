export type RuntimeEventsCursors = {
  goalCursor: number;
  conversationCursor: number;
};

export function buildRuntimeEventsQuery(cursors: RuntimeEventsCursors) {
  const params = new URLSearchParams({
    goalCursor: String(Math.max(0, Math.floor(cursors.goalCursor || 0))),
    conversationCursor: String(Math.max(0, Math.floor(cursors.conversationCursor || 0))),
  });
  return params.toString();
}

export function createRuntimeEventsSource(cursors: RuntimeEventsCursors) {
  return new EventSource(`/api/runtime/events/stream?${buildRuntimeEventsQuery(cursors)}`);
}
