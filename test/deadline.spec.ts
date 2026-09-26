import type { Transport } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_UNARY_TIMEOUT_MS, withUnaryDeadline } from "../src/index.js";

function fakeTransport() {
  let unaryTimeout: number | undefined;
  let streamTimeout: number | undefined;
  const transport = {
    unary: vi.fn(async (...args: unknown[]) => {
      unaryTimeout = args[2] as number | undefined;
      return {};
    }),
    stream: vi.fn(async (...args: unknown[]) => {
      streamTimeout = args[2] as number | undefined;
      return {};
    }),
  } as unknown as Transport;
  return {
    transport,
    unaryTimeout: () => unaryTimeout,
    streamTimeout: () => streamTimeout,
  };
}

describe("withUnaryDeadline", () => {
  it("passes the 10 second default to a unary fake transport", async () => {
    const fake = fakeTransport();
    const wrapped = withUnaryDeadline(fake.transport);

    await wrapped.unary({} as never, undefined, undefined, undefined, {} as never);

    expect(fake.unaryTimeout()).toBe(DEFAULT_UNARY_TIMEOUT_MS);
  });

  it("preserves an explicit per-call timeout", async () => {
    const fake = fakeTransport();
    const wrapped = withUnaryDeadline(fake.transport);

    await wrapped.unary({} as never, undefined, 321, undefined, {} as never);

    expect(fake.unaryTimeout()).toBe(321);
  });

  it("disables the default with zero", async () => {
    const fake = fakeTransport();
    const wrapped = withUnaryDeadline(fake.transport, 0);

    await wrapped.unary({} as never, undefined, undefined, undefined, {} as never);

    expect(fake.unaryTimeout()).toBeUndefined();
  });

  it("never applies the default to streams", async () => {
    const fake = fakeTransport();
    const wrapped = withUnaryDeadline(fake.transport);

    await wrapped.stream({} as never, undefined, undefined, undefined, {} as never);

    expect(fake.streamTimeout()).toBeUndefined();
  });
});
