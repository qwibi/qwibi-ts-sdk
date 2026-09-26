import { Code } from "@connectrpc/connect";
import type { StateVersion } from "./gen/qwibi/v1/common_pb.js";
import type { ServerEvent, StateClear, StateEvent } from "./gen/qwibi/v1/events_pb.js";
import type { GeoObject } from "./gen/qwibi/v1/object_pb.js";
import { deliveryPayload } from "./provenance.js";

export type StateApplyResult = "applied" | "stale" | "deleted" | "invalid" | "observed";

export interface StateGateCallbacks {
  onStateEvent?(event: StateEvent): void;
  onStateClear?(clear: StateClear): void;
  onObjectDeleted?(objectId: string, version: bigint): void;
}

export interface StateGateOptions {
  /** Maximum remembered state pairs and ledger tombstones. Oldest entries are evicted first. */
  maxEntries?: number;
}

interface Pair {
  ownerEpoch: bigint;
  seq: bigint;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const ZERO = BigInt(0);

function pairOf(version: StateVersion | undefined): Pair | null {
  if (!version) return null;
  return { ownerEpoch: version.ownerEpoch, seq: version.seq };
}

function newer(candidate: Pair, current: Pair | undefined): boolean {
  return current === undefined
    || candidate.ownerEpoch > current.ownerEpoch
    || (candidate.ownerEpoch === current.ownerEpoch && candidate.seq > current.seq);
}

function stateKey(kind: string, key: string): string {
  return `${kind}\u0000${key}`;
}

/**
 * StateGate is the QTP state-plane reconciliation primitive.
 *
 * It keeps the newest `(owner_epoch, seq)` per `(kind, key)`, seeds position
 * pairs from snapshots, and remembers ledger deletes so a raced position tick
 * cannot resurrect a deleted object. The maps are insertion-ordered and
 * bounded; a clear for an unknown key therefore still leaves a bounded
 * tombstone pair, as required by QTP.
 */
export class StateGate {
  readonly maxEntries: number;
  private readonly pairs = new Map<string, Pair>();
  private readonly ledgerVersions = new Map<string, bigint>();
  private readonly ledgerDeleted = new Map<string, bigint>();

  constructor(options: StateGateOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("StateGate maxEntries must be a positive safe integer");
    }
    this.maxEntries = maxEntries;
  }

  reset(): void {
    this.pairs.clear();
    this.ledgerVersions.clear();
    this.ledgerDeleted.clear();
  }

  /** Returns the newest held pair, or undefined when this cell has never been observed. */
  version(kind: string, key: string): Readonly<Pair> | undefined {
    return this.pairs.get(stateKey(kind, key));
  }

  isLedgerDeleted(objectId: string): boolean {
    return this.ledgerDeleted.has(objectId);
  }

  /** Seeds the position gate without moving it backwards on reconnect. */
  seedObject(object: GeoObject): StateApplyResult {
    this.observeObject(object);
    const version = pairOf(object.positionVersion) ?? { ownerEpoch: ZERO, seq: ZERO };
    return this.advance("position", object.uid, version) ? "observed" : "stale";
  }

  seedSnapshot(objects: readonly GeoObject[]): void {
    for (const object of objects) this.seedObject(object);
  }

  /** Records a ledger object baseline and clears only an older delete tombstone. */
  observeObject(object: GeoObject): void {
    const held = this.ledgerVersions.get(object.uid);
    if (held !== undefined && object.version < held) return;
    this.touch(this.ledgerVersions, object.uid, object.version);
    const deletedAt = this.ledgerDeleted.get(object.uid);
    if (deletedAt !== undefined && object.version > deletedAt) this.ledgerDeleted.delete(object.uid);
  }

  /** Records a version-gated ledger delete. */
  observeDelete(objectId: string, version: bigint): StateApplyResult {
    const held = this.ledgerVersions.get(objectId);
    if (held !== undefined && version <= held) return "stale";
    this.touch(this.ledgerVersions, objectId, version);
    this.touch(this.ledgerDeleted, objectId, version);
    return "observed";
  }

  /** Marks a targeted hydration miss so later raced ticks do not retry or resurrect it. */
  observeHydrationNotFound(objectId: string): void {
    const held = this.ledgerVersions.get(objectId) ?? ZERO;
    this.touch(this.ledgerDeleted, objectId, held);
  }

  applyStateEvent(event: StateEvent, callback?: (event: StateEvent) => void): StateApplyResult {
    const version = pairOf(event.version);
    if (!version || !event.kind || !event.key || event.value.case === undefined) return "invalid";
    if (!this.advance(event.kind, event.key, version)) return "stale";
    if (event.kind === "position" && this.isLedgerDeleted(event.key)) return "deleted";
    callback?.(event);
    return "applied";
  }

  applyStateClear(clear: StateClear, callback?: (clear: StateClear) => void): StateApplyResult {
    const version = pairOf(clear.version);
    if (!version || !clear.kind || !clear.key) return "invalid";
    if (!this.advance(clear.kind, clear.key, version)) return "stale";
    callback?.(clear);
    return "applied";
  }

  /**
   * Folds the state-related parts of one ServerEvent and invokes callbacks only
   * after their respective ordering/deletion gates pass.
   */
  applyServerEvent(event: ServerEvent, callbacks: StateGateCallbacks = {}): StateApplyResult {
    const payload = deliveryPayload(event);
    switch (payload.case) {
      case "snapshot":
        this.seedSnapshot(payload.value.objects);
        return "observed";
      case "objectCreated":
      case "objectUpdated": {
        const object = payload.value.object;
        if (!object) return "invalid";
        this.observeObject(object);
        return "observed";
      }
      case "objectDeleted": {
        const deleted = payload.value;
        const result = this.observeDelete(deleted.objectId, deleted.version);
        if (result === "observed") callbacks.onObjectDeleted?.(deleted.objectId, deleted.version);
        return result;
      }
      case "stateEvent":
        return this.applyStateEvent(payload.value, callbacks.onStateEvent);
      case "stateClear":
        return this.applyStateClear(payload.value, callbacks.onStateClear);
      default:
        return "observed";
    }
  }

  private advance(kind: string, key: string, candidate: Pair): boolean {
    const id = stateKey(kind, key);
    if (!newer(candidate, this.pairs.get(id))) return false;
    this.touch(this.pairs, id, candidate);
    return true;
  }

  private touch<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}

/**
 * Hydrates an unknown state key exactly once at the SDK boundary. NotFound (or
 * an empty result) is a normal drop and becomes a ledger tombstone; every other
 * failure remains visible to the caller.
 */
export async function hydrateStateObject(
  gate: StateGate,
  objectId: string,
  load: (objectId: string) => Promise<GeoObject | null | undefined>,
): Promise<GeoObject | null> {
  if (gate.isLedgerDeleted(objectId)) return null;
  try {
    const object = await load(objectId);
    if (!object) {
      gate.observeHydrationNotFound(objectId);
      return null;
    }
    gate.observeObject(object);
    return object;
  }
  catch (error) {
    if ((error as { code?: number })?.code === Code.NotFound) {
      gate.observeHydrationNotFound(objectId);
      return null;
    }
    throw error;
  }
}
