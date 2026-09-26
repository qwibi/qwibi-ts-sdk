import { Code, ConnectError } from "@connectrpc/connect";
import { errorDetailFrom } from "./errors.js";
import { retryAfterMsFrom } from "./retryAfter.js";

/** Whether the failed unary RPC only read state or could mutate it. */
export enum RetryOperation {
  Read = "read",
  Mutation = "mutation",
}

/** The S1-03 mechanism that makes a mutation safe to repeat. */
export enum MutationIdempotency {
  None = "none",
  RequestId = "request-id",
  HidUpsert = "hid-upsert",
  VersionCas = "version-cas",
}

/** The caller-owned action selected by the S4-03 retry matrix. */
export enum RetryAction {
  DoNotRetry = "do-not-retry",
  RetryWithBackoff = "retry-with-backoff",
  RefreshTokenThenRetry = "refresh-token-then-retry",
}

export interface RetryOptions {
  operation: RetryOperation;
  /** Required for retrying UNAVAILABLE/ABORTED mutations. */
  mutationIdempotency?: MutationIdempotency;
  /** Set after one token refresh so UNAUTHENTICATED cannot loop. */
  refreshAttempted?: boolean;
}

export interface RetryDecision {
  action: RetryAction;
  /** Server refill floor for RESOURCE_EXHAUSTED; combine it with normal backoff. */
  retryAfterMs?: number;
}

const NO_RETRY: RetryDecision = { action: RetryAction.DoNotRetry };

/**
 * Classifies one unary failure according to the S4-03 retry matrix. This helper
 * never sleeps, refreshes credentials, or retries the RPC itself.
 */
export function retryDecision(err: unknown, options: RetryOptions): RetryDecision {
  const code = ConnectError.from(err).code;
  switch (code) {
    case Code.Unavailable:
    case Code.Aborted:
      return retrySafeAfterTransportFailure(options)
        ? { action: RetryAction.RetryWithBackoff }
        : NO_RETRY;
    case Code.DeadlineExceeded:
      return options.operation === RetryOperation.Read
        ? { action: RetryAction.RetryWithBackoff }
        : NO_RETRY;
    case Code.ResourceExhausted: {
      const retryAfterMs = retryAfterMsFrom(errorDetailFrom(err));
      return retryAfterMs === undefined
        ? { action: RetryAction.RetryWithBackoff }
        : { action: RetryAction.RetryWithBackoff, retryAfterMs };
    }
    case Code.Unauthenticated:
      return options.refreshAttempted
        ? NO_RETRY
        : { action: RetryAction.RefreshTokenThenRetry };
    default:
      return NO_RETRY;
  }
}

function retrySafeAfterTransportFailure(options: RetryOptions): boolean {
  if (options.operation === RetryOperation.Read) return true;
  if (options.operation !== RetryOperation.Mutation) return false;
  return (
    options.mutationIdempotency === MutationIdempotency.RequestId ||
    options.mutationIdempotency === MutationIdempotency.HidUpsert ||
    options.mutationIdempotency === MutationIdempotency.VersionCas
  );
}
