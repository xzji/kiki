export const ASSISTANT_DRAWER_WIDTH = 400;
export const TASK_DETAIL_MIN_WIDTH = 450;
export const TASK_DETAIL_MAX_WIDTH = 600;
export const TASK_DETAIL_WIDTH_RATIO = 0.6;
export const TASK_MONITOR_DEFAULT_WIDTH = 400;
export const TASK_MONITOR_MIN_WIDTH = 350;
export const TASK_MONITOR_MAX_WIDTH = 500;

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
  return Math.min(preferred, TASK_DETAIL_MAX_WIDTH, availableWidth);
}

function defaultMonitorWidth(availableWidth: number, preferredWidth: number) {
  if (availableWidth <= 0) return 0;
  return Math.min(Math.max(preferredWidth, TASK_MONITOR_MIN_WIDTH), TASK_MONITOR_MAX_WIDTH, availableWidth);
}

function sideBySidePanelWidths(input: {
  viewportWidth: number;
  availableWidth: number;
  preferredMonitorWidth: number;
}) {
  const preferredMonitorWidth = defaultMonitorWidth(input.availableWidth, input.preferredMonitorWidth);
  const preferredDetailWidth = defaultDetailWidth(input.viewportWidth, input.availableWidth);
  const remainingForDetail = Math.max(0, input.availableWidth - preferredMonitorWidth);
  const detailWidth = Math.min(preferredDetailWidth, remainingForDetail);

  if (detailWidth >= TASK_DETAIL_MIN_WIDTH) {
    return {
      monitorWidth: preferredMonitorWidth,
      detailWidth,
    };
  }

  if (input.availableWidth >= TASK_MONITOR_MIN_WIDTH + TASK_DETAIL_MIN_WIDTH) {
    return {
      monitorWidth: input.availableWidth - TASK_DETAIL_MIN_WIDTH,
      detailWidth: TASK_DETAIL_MIN_WIDTH,
    };
  }

  const compactDetailWidth = Math.min(
    TASK_DETAIL_MIN_WIDTH,
    Math.floor(input.availableWidth * TASK_DETAIL_WIDTH_RATIO),
  );
  return {
    monitorWidth: Math.max(0, input.availableWidth - compactDetailWidth),
    detailWidth: compactDetailWidth,
  };
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
    const monitorWidth = input.monitorOpen ? defaultMonitorWidth(availableWidth, input.monitorWidth) : 0;
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

  const { monitorWidth, detailWidth } = sideBySidePanelWidths({
    viewportWidth: input.viewportWidth,
    availableWidth,
    preferredMonitorWidth: input.monitorWidth,
  });
  return {
    assistantOffset,
    availableWidth,
    monitorWidth,
    detailWidth,
    monitorRightOffset: assistantOffset + detailWidth,
    detailRightOffset: assistantOffset,
  };
}
