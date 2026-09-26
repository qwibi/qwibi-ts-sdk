import { ConnectError } from "@connectrpc/connect";
import { ErrorDetailSchema, type ErrorDetail } from "./gen/qwibi/v1/common_pb.js";

/**
 * Returns the first structured Qwibi error detail attached to an RPC error.
 * Unknown errors and statuses without ErrorDetail return undefined.
 */
export function errorDetailFrom(err: unknown): ErrorDetail | undefined {
  return ConnectError.from(err).findDetails(ErrorDetailSchema)[0];
}
