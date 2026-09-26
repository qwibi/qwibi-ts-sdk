import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  AppDeliverySchema,
  blockCaller,
  blockLayer,
  busy,
  createQwibiAppDataClient,
  createQwibiInvocationClient,
  createQwibiMarkClient,
  failed,
  GeoObjectSchema,
  InvocationSchema,
  InvocationStatus,
  ListAppObjectsResponseSchema,
  listAllAppObjects,
  pictureContentType,
  progress,
  putAppPicture,
  respondInvocation,
  RespondInvocationRequestSchema,
  serveInvocations,
  succeeded,
  unblockSource,
  validateAnswer,
  type Invocation,
  type RespondInvocationRequest,
} from "../src/index.js";

const CALL = "0192f0c1-7b3a-7d4e-8a1b-2c3d4e5f6a7b";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

describe("App clients", () => {
  it("are built from the same options as createQwibiClient", () => {
    const opts = { baseUrl: "http://127.0.0.1:7911", token: "t" };
    expect(typeof createQwibiAppDataClient(opts).replaceAppObjects).toBe("function");
    expect(typeof createQwibiInvocationClient(opts).blockSource).toBe("function");
    expect(typeof createQwibiMarkClient(opts).importMyMarks).toBe("function");
  });
});

describe("App data", () => {
  it("lists every page", async () => {
    const cursors: string[] = [];
    const client = {
      async listAppObjects(request: { appId: string; page?: { cursor?: string } }) {
        const cursor = request.page?.cursor ?? "";
        cursors.push(cursor);
        return create(ListAppObjectsResponseSchema, cursor === ""
          ? { objects: [create(GeoObjectSchema, { uid: "o1" })], page: { nextCursor: "next", hasMore: true } }
          : { objects: [create(GeoObjectSchema, { uid: "o2" })] });
      },
    };
    expect((await listAllAppObjects(client as never, "app")).map(o => o.uid)).toEqual(["o1", "o2"]);
    expect(cursors).toEqual(["", "next"]);
  });

  it("uploads a picture with its sniffed type and refuses others before sending", async () => {
    const sent: { contentType: string }[] = [];
    const client = { async putAppPicture(request: { contentType: string }) { sent.push(request); return { pictureRef: "/v1/app-pictures/x" }; } };
    expect(await putAppPicture(client as never, "app", PNG)).toBe("/v1/app-pictures/x");
    expect(sent[0]!.contentType).toBe("image/png");
    await expect(putAppPicture(client as never, "app", new Uint8Array([1, 2, 3]))).rejects.toThrow(/unsupported/u);
    await expect(putAppPicture(client as never, "app", new Uint8Array(0))).rejects.toThrow(/size/u);
    await expect(putAppPicture(client as never, "app", new Uint8Array((4 << 20) + 1))).rejects.toThrow(/size/u);
    expect(sent).toHaveLength(1);
    expect(pictureContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(pictureContentType(new TextEncoder().encode("GIF89a..."))).toBe("image/gif");
    expect(pictureContentType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  });
});

describe("answers", () => {
  const call = { invocationId: CALL };

  it("builds each App answer", () => {
    const ok = succeeded(call, { count: 3 });
    expect(ok.status).toBe(InvocationStatus.SUCCEEDED);
    expect(ok.result).toEqual({ count: 3 });
    expect(progress(call).status).toBe(InvocationStatus.PROGRESS);
    expect(failed(call, "ж".repeat(280)).message).toHaveLength(280);
    expect(() => failed(call, "ж".repeat(281))).toThrow(/at most 280/u);
    expect(busy(call).status).toBe(InvocationStatus.BUSY);
    for (const answer of [ok, progress(call), failed(call, "no"), busy(call)]) expect(() => validateAnswer(answer)).not.toThrow();
  });

  it("refuses an answer Qwibi would refuse", async () => {
    const bad: RespondInvocationRequest[] = [
      create(RespondInvocationRequestSchema, { invocationId: CALL, status: InvocationStatus.SUCCEEDED, message: "no" }),
      create(RespondInvocationRequestSchema, { invocationId: CALL, status: InvocationStatus.FAILED, result: {} }),
      create(RespondInvocationRequestSchema, { invocationId: CALL, status: InvocationStatus.EXPIRED }),
      create(RespondInvocationRequestSchema, { invocationId: CALL }),
      create(RespondInvocationRequestSchema, { invocationId: CALL, status: InvocationStatus.FAILED, message: "a".repeat(281) }),
    ];
    for (const answer of bad) expect(() => validateAnswer(answer)).toThrow();
    const sent: unknown[] = [];
    const client = { async respondInvocation(a: unknown) { sent.push(a); return { idempotentReplay: false }; } };
    await expect(respondInvocation(client as never, bad[0]!)).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
});

describe("blocks", () => {
  it("blocks a Layer and a caller and unblocks, refusing a bad reason before sending", async () => {
    const blocks: { source: { case: string; value: unknown }; reason: string }[] = [];
    const unblocks: string[] = [];
    const client = {
      async blockSource(request: (typeof blocks)[number]) { blocks.push(request); return { blockId: "b1" }; },
      async unblockSource(request: { blockId: string }) { unblocks.push(request.blockId); return {}; },
    };
    expect(await blockLayer(client as never, "opaque-layer", "spam")).toBe("b1");
    expect(blocks[0]!.source.case).toBe("layerId");
    expect((blocks[0]!.source.value as { value: string }).value).toBe("opaque-layer");
    expect(await blockCaller(client as never, CALL, "abuse")).toBe("b1");
    expect(blocks[1]!.source).toEqual({ case: "invocationId", value: CALL });
    await unblockSource(client as never, "b1");
    expect(unblocks).toEqual(["b1"]);
    await expect(blockLayer(client as never, "", "spam")).rejects.toThrow();
    await expect(blockLayer(client as never, "k", "")).rejects.toThrow(/required/u);
    await expect(blockLayer(client as never, "k", "a".repeat(281))).rejects.toThrow(/280/u);
    await expect(blockCaller(client as never, "not-a-call", "abuse")).rejects.toThrow(/UUID/u);
    expect(blocks).toHaveLength(2);
  });
});

function delivery(invocationId: string, deadlineMs?: number) {
  const invocation = create(InvocationSchema, { invocationId });
  if (deadlineMs !== undefined) {
    invocation.deadline = { $typeName: "google.protobuf.Timestamp", seconds: BigInt(Math.floor(deadlineMs / 1000)), nanos: (deadlineMs % 1000) * 1e6 };
  }
  return create(AppDeliverySchema, { payload: { case: "invocation", value: invocation } });
}

function fakeConnection(connections: (() => AsyncIterable<ReturnType<typeof delivery>>)[]) {
  const answers: RespondInvocationRequest[] = [];
  let opens = 0;
  return {
    answers,
    get opens() { return opens; },
    subscribeInvocations() { return connections[opens++]!(); },
    async respondInvocation(answer: RespondInvocationRequest) { answers.push(answer); return { idempotentReplay: false }; },
  };
}

describe("serveInvocations", () => {
  it("answers each delivery, reopens an ended connection and stops on abort", async () => {
    const controller = new AbortController();
    const second = "0192f0c1-7b3a-7d4e-8a1b-2c3d4e5f6a7c";
    const client = fakeConnection([
      async function* () { yield delivery(CALL); },
      async function* () { yield delivery(second); controller.abort(); },
    ]);
    const seen: string[] = [];
    await serveInvocations(client as never, (invocation: Invocation) => {
      seen.push(invocation.invocationId);
      return succeeded(invocation);
    }, { signal: controller.signal, retryMs: 1 });
    expect(seen).toEqual([CALL, second]);
    expect(client.answers.map(a => a.invocationId)).toEqual([CALL, second]);
  });

  it("returns a refused connection to the caller to sign in again", async () => {
    const client = fakeConnection([async function* () { throw new ConnectError("revoked", Code.PermissionDenied); }]);
    await expect(serveInvocations(client as never, succeeded, { retryMs: 1 })).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(client.opens).toBe(1);
  });

  it("refuses an invalid or mismatched answer before sending", async () => {
    const invalid = fakeConnection([async function* () { yield delivery(CALL); }]);
    await expect(serveInvocations(invalid as never, inv => {
      const answer = succeeded(inv);
      answer.message = "a message belongs to a failure";
      return answer;
    })).rejects.toThrow(/no message/u);
    const other = fakeConnection([async function* () { yield delivery(CALL); }]);
    await expect(serveInvocations(other as never, () => busy({ invocationId: "someone-else" }))).rejects.toThrow(/mismatched/u);
    expect(invalid.answers.length + other.answers.length).toBe(0);
  });

  it("aborts the handler signal at the invocation deadline", async () => {
    const controller = new AbortController();
    const client = fakeConnection([async function* () { yield delivery(CALL, Date.now() + 20); controller.abort(); }]);
    let abortedAtDeadline = false;
    await serveInvocations(client as never, async (inv, signal) => {
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      abortedAtDeadline = !controller.signal.aborted;
      return failed(inv, "too slow");
    }, { signal: controller.signal });
    expect(abortedAtDeadline).toBe(true);
    expect(client.answers[0]!.status).toBe(InvocationStatus.FAILED);
  });
});
