/** 机器 Tunnel WebSocket 路径（勿用 `/`，Railway 边缘对根路径 Upgrade 易异常）。 */
export const MACHINE_TUNNEL_WS_PATH = "/api/machine-tunnel/ws";

/**
 * Railway 生产环境：双端禁用 permessage-deflate，避免与边缘代理协商不一致。
 * 使用专用路径 `/api/machine-tunnel/ws` 而非根路径 `/`。
 */
export const TUNNEL_PER_MESSAGE_DEFLATE = false;
