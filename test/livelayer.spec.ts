import { create } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ErrorCode,
  GeoObjectSchema,
  LiveLayer,
  ServerEventSchema,
  type ServerEvent,
  type StreamSource,
  type SubscribeRequest,
} from "../src/index.js";

type Script = (request: SubscribeRequest, signal: AbortSignal) => AsyncGenerator<ServerEvent, void, unknown>;

function object(id: string, version: bigint) {
  return create(GeoObjectSchema, { uid: id, version, layerId: "layer-1", objectType: "marker" });
}

function snapshot(cursor: string, objects = [object("o1", 1n)]): ServerEvent {
  return create(ServerEventSchema, {
    cursor,
    payload: { case: "snapshot", value: { layerId: "layer-1", objects } },
  });
}

function updated(id: string, version: bigint, cursor = ""): ServerEvent {
  return create(ServerEventSchema, {
    cursor,
    payload: { case: "objectUpdated", value: { layerId: "layer-1", object: object(id, version) } },
  });
}

function moved(id: string, version: bigint, cursor = ""): ServerEvent {
  return create(ServerEventSchema, {
    cursor,
    payload: { case: "objectMoved", value: { layerId: "layer-1", objectId: id, version } },
  });
}

function deleted(id: string, version: bigint, cursor = ""): ServerEvent {
  return create(ServerEventSchema, {
    cursor,
    payload: { case: "objectDeleted", value: { layerId: "layer-1", objectId: id, version } },
  });
}

function streamError(code: ErrorCode, cursor: string): ServerEvent {
  return create(ServerEventSchema, {
    cursor,
    payload: { case: "error", value: { error: { code, message: "stream reset" } } },
  });
}

const failFast: Script = async function* () {
  yield* [] as ServerEvent[];
  throw new Error("connection reset");
};

const hang: Script = async function* (_request, signal) {
  yield* [] as ServerEvent[];
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
};

function scriptedSource(scripts: Script[]) {
  const requests: SubscribeRequest[] = [];
  let index = 0;
  const source: StreamSource = {
    open(request, signal) {
      requests.push(request);
      const script = scripts[Math.min(index++, scripts.length - 1)]!;
      return script(request, signal);
    },
  };
  return { source, requests };
}

function live(source: StreamSource, initialCursor = "") {
  return new LiveLayer(source, {
    layerIds: ["layer-1"],
    viewport: {
      bbox: { southWest: { lon: 0, lat: 0 }, northEast: { lon: 1, lat: 1 } },
      zoom: 10,
    },
    initialCursor,
  });
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe("LiveLayer", () => {
  const running: LiveLayer[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(Math, "random").mockReturnValue(1);
  });

  afterEach(async () => {
    for (const layer of running) layer.stop();
    await flush();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps snapshot-before-delta order and drops stale replay by object version", async () => {
    const replay: Script = async function* (_request, signal) {
      yield snapshot("c2", [object("o1", 2n)]);
      yield updated("o1", 2n, "c3");
      yield moved("o1", 3n, "c4");
      yield deleted("o1", 4n, "c5");
      yield updated("o1", 3n, "c6");
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    const { source } = scriptedSource([replay]);
    const layer = live(source);
    running.push(layer);
    const seen: string[] = [];
    layer.on("snapshot", (value) => seen.push(`snapshot:${value.objects[0]?.version}`));
    layer.on("updated", (value) => seen.push(`updated:${value.version}`));
    layer.on("moved", (value) => seen.push(`moved:${value.version}`));
    layer.on("deleted", (value) => seen.push(`deleted:${value.version}`));

    layer.start();
    await flush();

    expect(seen).toEqual(["snapshot:2", "moved:3", "deleted:4"]);
    expect(layer.cursor).toBe("c6");
  });

  it("carries the opaque server cursor when reconnecting after transport loss", async () => {
    const drop: Script = async function* () {
      yield snapshot("opaque.v3.cursor");
      throw new Error("offline");
    };
    const { source, requests } = scriptedSource([drop, hang]);
    const layer = live(source);
    running.push(layer);
    layer.start();
    await flush();
    expect(requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();

    expect(requests).toHaveLength(2);
    expect(requests[1]?.cursor).toBe("opaque.v3.cursor");
  });

  for (const code of [ErrorCode.SLOW_CONSUMER, ErrorCode.RESUME_TOKEN_EXPIRED]) {
    it(`drops cursor and versions on reset code ${code}`, async () => {
      const reset: Script = async function* () {
        yield snapshot("trusted", [object("o1", 9n)]);
        yield streamError(code, "untrusted");
      };
      const { source, requests } = scriptedSource([reset, hang]);
      const layer = live(source);
      running.push(layer);
      const reasons: string[] = [];
      layer.on("error", (error) => reasons.push(error.reason));
      layer.start();
      await flush();
      expect(layer.cursor).toBe("");

      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
      expect(requests[1]?.cursor).toBe("");
      expect(reasons).toEqual([
        code === ErrorCode.SLOW_CONSUMER ? "slow_consumer" : "resume_token_expired",
      ]);
    });
  }

  it("reopens immediately on viewport retarget and preserves the opaque v2/v3 cursor", async () => {
    const open: Script = async function* (_request, signal) {
      yield snapshot("viewport-bound-cursor");
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    const { source, requests } = scriptedSource([open, hang]);
    const layer = live(source);
    running.push(layer);
    layer.start();
    await flush();

    layer.setViewport({
      bbox: { southWest: { lon: 10, lat: 10 }, northEast: { lon: 11, lat: 11 } },
      zoom: 12,
    });
    await flush();

    expect(requests).toHaveLength(2);
    expect(requests[1]?.cursor).toBe("viewport-bound-cursor");
    expect(requests[1]?.viewport?.zoom).toBe(12);
    expect(requests[1]?.viewport?.bbox?.southWest?.lon).toBe(10);
  });

  it("escalates fast-failure backoff and resets after a healthy run", async () => {
    let releaseHealthy!: () => void;
    const healthyGate = new Promise<void>((resolve) => {
      releaseHealthy = resolve;
    });
    const healthy: Script = async function* () {
      yield snapshot("healthy-cursor");
      await healthyGate;
      throw new Error("healthy stream ended");
    };
    const { source, requests } = scriptedSource([failFast, failFast, healthy, hang]);
    const layer = live(source);
    running.push(layer);
    layer.start();
    await flush();

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(requests).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(5_001);
    releaseHealthy();
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(requests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(requests).toHaveLength(4);
    expect(requests[3]?.cursor).toBe("healthy-cursor");
  });

  it("stop during backoff cancels the pending retry", async () => {
    const { source, requests } = scriptedSource([failFast, hang]);
    const layer = live(source);
    running.push(layer);
    layer.start();
    await flush();
    layer.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(requests).toHaveLength(1);
    expect(layer.status).toBe("stopped");
  });

  it("treats NotFound as terminal instead of retrying forever", async () => {
    const notFound: Script = async function* () {
      yield* [] as ServerEvent[];
      throw Object.assign(new Error("gone"), { code: 5 });
    };
    const { source, requests } = scriptedSource([notFound, hang]);
    const layer = live(source);
    running.push(layer);
    const deletedLayers: string[] = [];
    layer.on("layerDeleted", (layerId) => deletedLayers.push(layerId));
    layer.start();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(requests).toHaveLength(1);
    expect(deletedLayers).toEqual(["layer-1"]);
    expect(layer.status).toBe("stopped");
  });
});
