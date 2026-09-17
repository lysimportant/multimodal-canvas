/** 服务端校时样本；用单调时钟推进，避免浏览器系统时间调整影响执行耗时。 */
type ServerClockSample = {
  serverAtReceipt: number;
  receivedAt: number;
  requestStartedAt: number;
};

/** 当前页面最近一次有效的服务端时间；刷新页面后重新通过 API 响应校准。 */
let sample: ServerClockSample | undefined;

/**
 * 使用 API 响应时间校准共享时钟，忽略无效头和较早请求的迟到响应。
 * @param serverTime 服务端响应头中的 UTC ISO 时间。
 * @param requestStartedAt 请求发出时的 performance.now()，单位毫秒。
 * @param receivedAt 响应到达时的单调时间，缺省取当前值。
 * @returns 校时成功时为 true；网络往返时间的一半用于估计响应传输延迟。
 */
export function synchronizeServerClock(
  serverTime: string | null,
  requestStartedAt: number,
  receivedAt = performance.now(),
): boolean {
  const serverTimeMs = serverTime ? Date.parse(serverTime) : NaN;
  if (
    !Number.isFinite(serverTimeMs) ||
    !Number.isFinite(requestStartedAt) ||
    !Number.isFinite(receivedAt) ||
    receivedAt < requestStartedAt ||
    (sample && requestStartedAt < sample.requestStartedAt)
  ) {
    return false;
  }
  sample = {
    serverAtReceipt: serverTimeMs + (receivedAt - requestStartedAt) / 2,
    receivedAt,
    requestStartedAt,
  };
  return true;
}

/**
 * 返回用于运行中耗时显示的服务端参考时间，单位毫秒。
 * 尚未收到有效校时响应时使用浏览器时间；最终耗时仍由服务端终态记录决定。
 */
export function serverClockNow(): number {
  return sample
    ? sample.serverAtReceipt + Math.max(0, performance.now() - sample.receivedAt)
    : Date.now();
}
