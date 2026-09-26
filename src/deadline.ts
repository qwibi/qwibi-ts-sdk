import type { Transport } from "@connectrpc/connect";

/** Default deadline applied to unary SDK calls. Streaming calls are exempt. */
export const DEFAULT_UNARY_TIMEOUT_MS = 10_000;

/**
 * Decorates a Connect transport with a unary-only default deadline. Explicit
 * per-call timeouts win; zero or a negative configured default disables it.
 */
export function withUnaryDeadline(
  transport: Transport,
  defaultTimeoutMs: number | undefined = DEFAULT_UNARY_TIMEOUT_MS,
): Transport {
  const fallback = defaultTimeoutMs !== undefined && defaultTimeoutMs > 0 ? defaultTimeoutMs : undefined;
  return {
    unary(method, signal, timeoutMs, header, input, contextValues) {
      return transport.unary(
        method,
        signal,
        timeoutMs === undefined ? fallback : timeoutMs,
        header,
        input,
        contextValues,
      );
    },
    stream(method, signal, timeoutMs, header, input, contextValues) {
      return transport.stream(method, signal, timeoutMs, header, input, contextValues);
    },
  };
}
