// Internal: the RESOURCE_EXHAUSTED retry hint. The server writes it into
// ErrorDetail.message as "retry_after_seconds=<n>"; "seconds_until_refill=<n>"
// and a bare number of seconds are accepted too.
import type { ErrorDetail } from "./gen/qwibi/v1/common_pb.js";

export function retryAfterMsFrom(detail: ErrorDetail | undefined): number | undefined {
  if (!detail) return undefined;
  const message = detail.message.trim();
  const bare = /^(\d+)\s*(?:s|sec(?:ond)?s?)?$/i.exec(message);
  const labeled =
    /(?:seconds[-_ ]until[-_ ]refill|retry[-_ ]after(?:[-_ ]seconds)?)\s*[:=]?\s*(\d+)/i.exec(
      message,
    );
  const seconds = Number((bare ?? labeled)?.[1]);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return undefined;
  const milliseconds = seconds * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}
