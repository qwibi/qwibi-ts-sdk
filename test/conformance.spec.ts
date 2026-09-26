// QTP client-conformance helpers: the two predicates a stream consumer folds over
// every ServerEvent. SLOW_CONSUMER and
// RESUME_TOKEN_EXPIRED invalidate the resume cursor (re-open WITHOUT one → fresh
// snapshot); every other event — including other in-band errors — keeps it.
import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import {
  ErrorCode,
  ServerEventSchema,
  isSlowConsumer,
  shouldResetCursor,
  type ServerEvent,
} from "../src/index.js";

function errorEvent(code: ErrorCode): ServerEvent {
  return create(ServerEventSchema, {
    seq: 7n,
    cursor: "cursor-7",
    payload: { case: "error", value: { error: { code, message: "boom" } } },
  });
}

describe("QTP client-conformance helpers", () => {
  it("SLOW_CONSUMER is a slow-consumer signal AND a cursor reset", () => {
    const ev = errorEvent(ErrorCode.SLOW_CONSUMER);
    expect(isSlowConsumer(ev)).toBe(true);
    expect(shouldResetCursor(ev)).toBe(true);
  });

  it("RESUME_TOKEN_EXPIRED resets the cursor but is not a slow-consumer signal", () => {
    const ev = errorEvent(ErrorCode.RESUME_TOKEN_EXPIRED);
    expect(isSlowConsumer(ev)).toBe(false);
    expect(shouldResetCursor(ev)).toBe(true);
  });

  it("an ordinary in-band error is non-fatal: neither predicate fires (stream + cursor stay)", () => {
    for (const code of [ErrorCode.INTERNAL, ErrorCode.UNAVAILABLE, ErrorCode.PERMISSION_DENIED]) {
      const ev = errorEvent(code);
      expect(isSlowConsumer(ev)).toBe(false);
      expect(shouldResetCursor(ev)).toBe(false);
    }
  });

  it("a StreamError without an ErrorDetail is not a reset", () => {
    const ev = create(ServerEventSchema, { seq: 8n, payload: { case: "error", value: {} } });
    expect(isSlowConsumer(ev)).toBe(false);
    expect(shouldResetCursor(ev)).toBe(false);
  });

  it("non-error events never reset the cursor", () => {
    const snapshot = create(ServerEventSchema, {
      seq: 9n,
      cursor: "cursor-9",
      payload: { case: "snapshot", value: { layerId: "layer-1", snapshotSeq: 9n } },
    });
    const heartbeat = create(ServerEventSchema, {
      seq: 10n,
      payload: { case: "heartbeat", value: { seq: 10n } },
    });
    const empty = create(ServerEventSchema, { seq: 11n });
    for (const ev of [snapshot, heartbeat, empty]) {
      expect(isSlowConsumer(ev)).toBe(false);
      expect(shouldResetCursor(ev)).toBe(false);
    }
  });
});
