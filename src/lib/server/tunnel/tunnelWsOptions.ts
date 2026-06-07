/**
 * Railway 边缘（hikari）可能对 WebSocket 启用 permessage-deflate。
 * 若服务端关闭扩展但链路仍下发 RSV1 压缩帧，ws 客户端会报
 * "Invalid WebSocket frame: RSV1 must be clear" 并断连。
 * 两端必须使用一致的 deflate 配置完成握手协商。
 */
export const TUNNEL_PER_MESSAGE_DEFLATE = {
  zlibDeflateOptions: { level: 3 },
  zlibInflateOptions: { chunkSize: 10 * 1024 },
  clientNoContextTakeover: true,
  serverNoContextTakeover: true,
  serverMaxWindowBits: 10,
  concurrencyLimit: 10,
  threshold: 256,
};
