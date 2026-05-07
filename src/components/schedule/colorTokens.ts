import type { AgentEventColor } from "@/types/schedule";

export const EVENT_COLORS: Record<AgentEventColor, { bg: string; fg: string; bar: string }> = {
  blue: { bg: "#EAF1FF", fg: "#1E4FCC", bar: "#1E4FCC" },
  green: { bg: "#E6F4EA", fg: "#1F7A3A", bar: "#1F7A3A" },
  purple: { bg: "#EFEAFE", fg: "#5B3DBE", bar: "#5B3DBE" },
  pink: { bg: "#FCE9EE", fg: "#B0274A", bar: "#B0274A" },
  orange: { bg: "#FFF1E0", fg: "#A8590A", bar: "#A8590A" },
  cyan: { bg: "#E0F4F4", fg: "#1B6F73", bar: "#1B6F73" }
};

export const DEFAULT_EVENT_COLOR: AgentEventColor = "blue";

export const HOUR_HEIGHT = 56;
export const TIME_GUTTER_WIDTH = 64;
export const DAY_START_SCROLL_HOUR = 8;
export const GRID_MAX_HEIGHT = "calc(100vh - 260px)";
