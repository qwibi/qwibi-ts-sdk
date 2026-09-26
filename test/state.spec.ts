import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
  GeoObjectSchema,
  ServerEventSchema,
  StateClearSchema,
  StateEventSchema,
  StateGate,
  StateVersionSchema,
  hydrateStateObject,
  point,
} from "../src/index.js";

function version(ownerEpoch: bigint, seq: bigint) {
  return create(StateVersionSchema, { ownerEpoch, seq });
}

function object(uid: string, ledgerVersion: bigint, ownerEpoch: bigint, seq: bigint) {
  return create(GeoObjectSchema, {
    uid,
    layerId: "layer-1",
    version: ledgerVersion,
    geometry: point(1, 2),
    positionVersion: version(ownerEpoch, seq),
  });
}

function state(key: string, ownerEpoch: bigint, seq: bigint) {
  return create(StateEventSchema, {
    layerId: "layer-1",
    kind: "position",
    key,
    value: { case: "position", value: point(Number(seq % 180n), 2) },
    version: version(ownerEpoch, seq),
  });
}

function clear(key: string, ownerEpoch: bigint, seq: bigint) {
  return create(StateClearSchema, {
    layerId: "layer-1",
    kind: "position",
    key,
    version: version(ownerEpoch, seq),
  });
}

describe("StateGate", () => {
  it("seeds from snapshot and applies only a lexicographically newer pair", () => {
    const gate = new StateGate();
    gate.seedObject(object("object-1", 7n, 4n, 10n));
    const applied = vi.fn();

    expect(gate.applyStateEvent(state("object-1", 4n, 9n), applied)).toBe("stale");
    expect(gate.applyStateEvent(state("object-1", 3n, 999n), applied)).toBe("stale");
    expect(gate.applyStateEvent(state("object-1", 5n, 1n), applied)).toBe("applied");
    expect(applied).toHaveBeenCalledTimes(1);
    expect(gate.version("position", "object-1")).toEqual({ ownerEpoch: 5n, seq: 1n });
  });

  it("orders route clear/value callbacks through the same pair gate", () => {
    const gate = new StateGate();
    const onEvent = vi.fn();
    const onClear = vi.fn();

    expect(gate.applyStateEvent(state("object-1", 2n, 12n), onEvent)).toBe("applied");
    expect(gate.applyStateClear(clear("object-1", 2n, 11n), onClear)).toBe("stale");
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();

    const other = new StateGate();
    expect(other.applyStateClear(clear("object-1", 2n, 11n), onClear)).toBe("applied");
    expect(other.applyStateEvent(state("object-1", 2n, 12n), onEvent)).toBe("applied");
    expect(other.version("position", "object-1")).toEqual({ ownerEpoch: 2n, seq: 12n });
  });

  it("lets a ledger delete win and suppresses every later position tick", () => {
    const gate = new StateGate();
    gate.seedObject(object("object-1", 7n, 1n, 1n));
    const stateCallback = vi.fn();
    const deleteCallback = vi.fn();

    const deletion = create(ServerEventSchema, {
      payload: {
        case: "objectDeleted",
        value: { layerId: "layer-1", objectId: "object-1", version: 8n },
      },
    });
    expect(gate.applyServerEvent(deletion, { onObjectDeleted: deleteCallback })).toBe("observed");
    expect(gate.applyStateEvent(state("object-1", 9n, 1n), stateCallback)).toBe("deleted");
    expect(deleteCallback).toHaveBeenCalledWith("object-1", 8n);
    expect(stateCallback).not.toHaveBeenCalled();
  });

  it("drops NotFound hydration, remembers it, and propagates other failures", async () => {
    const gate = new StateGate();
    const notFound = Object.assign(new Error("missing"), { code: 5 });
    const load = vi.fn().mockRejectedValue(notFound);

    await expect(hydrateStateObject(gate, "missing", load)).resolves.toBeNull();
    await expect(hydrateStateObject(gate, "missing", load)).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);

    const failure = new Error("transport");
    await expect(hydrateStateObject(gate, "other", async () => { throw failure; })).rejects.toBe(failure);
  });

  it("keeps unknown clear tombstones bounded", () => {
    const gate = new StateGate({ maxEntries: 2 });
    gate.applyStateClear(clear("a", 1n, 1n));
    gate.applyStateClear(clear("b", 1n, 1n));
    gate.applyStateClear(clear("c", 1n, 1n));
    expect(gate.version("position", "a")).toBeUndefined();
    expect(gate.version("position", "b")).toEqual({ ownerEpoch: 1n, seq: 1n });
    expect(gate.version("position", "c")).toEqual({ ownerEpoch: 1n, seq: 1n });
  });
});
