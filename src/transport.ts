// One transport factory shared by every Qwibi client. The object plane, the
// release surface and the signal plane are separate services on the same edge,
// so they are built from the same options and the same auth interceptor rather
// than from three near-copies that could drift on headers or deadlines.
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import type { Interceptor, Transport } from "@connectrpc/connect";
import { withUnaryDeadline } from "./deadline.js";

export interface QwibiClientOptions {
  /** Base URL of the Qwibi Connect-Web gateway, e.g. "http://localhost:7903". */
  baseUrl: string;
  /**
   * Access token sent as "authorization: Bearer <token>". Pass a getter (sync or
   * async) instead of a string so a rotated/refreshed token is picked up per
   * request, without rebuilding the client. A falsy result sends no header.
   */
  token?: string | (() => string | null | undefined | Promise<string | null | undefined>);
  /** Default unary deadline in milliseconds. Zero disables it; streams are exempt. */
  timeoutMs?: number;
  /** Custom fetch (e.g. a Node agent during SSR); defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Extra Connect interceptors, applied after the auth interceptor. */
  interceptors?: Interceptor[];
}

export function createQwibiTransport(opts: QwibiClientOptions): Transport {
  const interceptors: Interceptor[] = [];
  if (opts.token !== undefined) {
    const token = opts.token;
    const getToken = typeof token === "function" ? token : () => token;
    interceptors.push((next) => async (req) => {
      const t = await getToken();
      if (t) req.header.set("Authorization", `Bearer ${t}`);
      return next(req);
    });
  }
  if (opts.interceptors) {
    interceptors.push(...opts.interceptors);
  }
  const transport = createGrpcWebTransport({
    baseUrl: opts.baseUrl,
    interceptors,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return withUnaryDeadline(transport, opts.timeoutMs);
}
