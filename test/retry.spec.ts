import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  ErrorDetailSchema,
  MutationIdempotency,
  RetryAction,
  RetryOperation,
  retryDecision,
} from "../src/index.js";

const read = { operation: RetryOperation.Read } as const;
const unsafeMutation = { operation: RetryOperation.Mutation } as const;

function rpcError(code: Code, message = code.toString()): ConnectError {
  return new ConnectError(message, code);
}

describe("retryDecision", () => {
  it.each([Code.Unavailable, Code.Aborted])("retries %s reads with backoff", (code) => {
    expect(retryDecision(rpcError(code), read).action).toBe(RetryAction.RetryWithBackoff);
  });

  it.each(
    [Code.Unavailable, Code.Aborted].flatMap((code) =>
      [
        MutationIdempotency.RequestId,
        MutationIdempotency.HidUpsert,
        MutationIdempotency.VersionCas,
      ].map((mutationIdempotency) => [code, mutationIdempotency] as const),
    ),
  )("retries %s for %s mutations", (code, mutationIdempotency) => {
    expect(
      retryDecision(rpcError(code), {
        operation: RetryOperation.Mutation,
        mutationIdempotency,
      }).action,
    ).toBe(RetryAction.RetryWithBackoff);
  });

  it.each([Code.Unavailable, Code.Aborted])(
    "does not retry %s for a mutation without an S1-03 guard",
    (code) => {
      expect(retryDecision(rpcError(code), unsafeMutation).action).toBe(RetryAction.DoNotRetry);
    },
  );

  it("fails closed for an unknown operation kind", () => {
    expect(
      retryDecision(rpcError(Code.Unavailable), {
        operation: "unknown" as RetryOperation,
        mutationIdempotency: MutationIdempotency.RequestId,
      }).action,
    ).toBe(RetryAction.DoNotRetry);
  });

  it("retries DEADLINE_EXCEEDED reads only", () => {
    expect(retryDecision(rpcError(Code.DeadlineExceeded), read).action).toBe(
      RetryAction.RetryWithBackoff,
    );
    expect(
      retryDecision(rpcError(Code.DeadlineExceeded), {
        operation: RetryOperation.Mutation,
        mutationIdempotency: MutationIdempotency.RequestId,
      }).action,
    ).toBe(RetryAction.DoNotRetry);
  });

  it("honors a RESOURCE_EXHAUSTED refill floor", () => {
    const detail = create(ErrorDetailSchema, {
      code: ErrorCode.RESOURCE_EXHAUSTED,
      message: "seconds_until_refill=12",
    });
    const err = rpcError(Code.ResourceExhausted);
    err.details = [
      { type: "qwibi.v1.ErrorDetail", value: toBinary(ErrorDetailSchema, detail) },
    ];

    expect(retryDecision(err, unsafeMutation)).toEqual({
      action: RetryAction.RetryWithBackoff,
      retryAfterMs: 12_000,
    });
  });

  it("does not invent a RESOURCE_EXHAUSTED refill floor from malformed text", () => {
    const detail = create(ErrorDetailSchema, {
      code: ErrorCode.RESOURCE_EXHAUSTED,
      message: "quota depleted",
    });
    const err = rpcError(Code.ResourceExhausted);
    err.details = [
      { type: "qwibi.v1.ErrorDetail", value: toBinary(ErrorDetailSchema, detail) },
    ];

    expect(retryDecision(err, read)).toEqual({ action: RetryAction.RetryWithBackoff });
  });

  it("refreshes once for UNAUTHENTICATED and then stops", () => {
    const err = rpcError(Code.Unauthenticated);
    expect(retryDecision(err, read).action).toBe(RetryAction.RefreshTokenThenRetry);
    expect(retryDecision(err, { ...read, refreshAttempted: true }).action).toBe(
      RetryAction.DoNotRetry,
    );
  });

  it.each([
    Code.InvalidArgument,
    Code.PermissionDenied,
    Code.NotFound,
    Code.AlreadyExists,
    Code.FailedPrecondition,
    Code.Internal,
  ])("never retries terminal code %s", (code) => {
    expect(retryDecision(rpcError(code), read).action).toBe(RetryAction.DoNotRetry);
  });

  it("fails closed for a code outside the matrix", () => {
    expect(retryDecision(rpcError(Code.Unknown), read).action).toBe(RetryAction.DoNotRetry);
  });
});
