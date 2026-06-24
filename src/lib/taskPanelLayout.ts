export const ASSISTANT_DRAWER_WIDTH = 400;
export const TASK_DETAIL_MIN_WIDTH = 640;
export const TASK_DETAIL_WIDTH_RATIO = 0.6;
export const TASK_MONITOR_DEFAULT_WIDTH = 340;
export const TASK_MONITOR_MAX_WIDTH = 420;
export const TASK_MONITOR_COMPACT_RATIO = 0.34;

type ResolveTaskPanelLayoutInput = {
  viewportWidth: number;
  assistantOpen: boolean;
  isMobile: boolean;
  monitorOpen: boolean;
  detailOpen: boolean;
  monitorWidth: number;
};

export type TaskPanelLayout = {
  assistantOffset: number;
  availableWidth: number;
  monitorWidth: number;
  detailWidth: number;
  monitorRightOffset: number;
  detailRightOffset: number;
};

function defaultDetailWidth(viewportWidth: number, availableWidth: number) {
  if (availableWidth <= 0) return TASK_DETAIL_MIN_WIDTH;
  const preferred = Math.max(viewportWidth * TASK_DETAIL_WIDTH_RATIO, TASK_DETAIL_MIN_WIDTH);
  return Math.min(preferred, availableWidth);
}

function sideBySideMonitorWidth(availableWidth: number, preferredWidth: number) {
  if (availableWidth <= 0) return 0;
  const compactCap = Math.floor(availableWidth * TASK_MONITOR_COMPACT_RATIO);
  return Math.max(0, Math.min(preferredWidth, TASK_MONITOR_MAX_WIDTH, compactCap));
}

export function resolveTaskPanelLayout(input: ResolveTaskPanelLayoutInput): TaskPanelLayout {
  const assistantOffset = !input.isMobile && input.assistantOpen ? ASSISTANT_DRAWER_WIDTH : 0;
  const availableWidth = Math.max(0, input.viewportWidth - assistantOffset);
  const fallbackDetailWidth = defaultDetailWidth(input.viewportWidth, availableWidth);

  if (input.isMobile) {
    return {
      assistantOffset: 0,
      availableWidth: input.viewportWidth,
      monitorWidth: input.viewportWidth,
      detailWidth: input.viewportWidth,
      monitorRightOffset: 0,
      detailRightOffset: 0,
    };
  }

  if (!input.detailOpen) {
    const monitorWidth = input.monitorOpen
      ? Math.min(input.monitorWidth, TASK_MONITOR_MAX_WIDTH, availableWidth)
      : 0;
    return {
      assistantOffset,
      availableWidth,
      monitorWidth,
      detailWidth: fallbackDetailWidth,
      monitorRightOffset: assistantOffset,
      detailRightOffset: assistantOffset,
    };
  }

  if (!input.monitorOpen) {
    return {
      assistantOffset,
      availableWidth,
      monitorWidth: 0,
      detailWidth: fallbackDetailWidth,
      monitorRightOffset: assistantOffset + fallbackDetailWidth,
      detailRightOffset: assistantOffset,
    };
  }

  const monitorWidth = sideBySideMonitorWidth(availableWidth, input.monitorWidth);
  const detailWidth = Math.max(0, availableWidth - monitorWidth);
  return {
    assistantOffset,
    availableWidth,
    monitorWidth,
    detailWidth,
    monitorRightOffset: assistantOffset + detailWidth,
    detailRightOffset: assistantOffset,
  };
}
