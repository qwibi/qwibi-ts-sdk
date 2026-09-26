import { create } from "@bufbuild/protobuf";
import { ErrorCode, type ErrorDetail } from "./gen/qwibi/v1/common_pb.js";
import type { AppDataSource } from "./gen/qwibi/v1/common_pb.js";
import type {
  AggregateUpdated,
  ClusterSnapshot,
  ObjectDeleted,
  ObjectMoved,
  PresenceEvent,
  ServerEvent,
  Snapshot,
  StateClear,
  StateEvent,
  ViewerCount,
} from "./gen/qwibi/v1/events_pb.js";
import type { GeoObject } from "./gen/qwibi/v1/object_pb.js";
import { deliveryPayload } from "./provenance.js";
import {
  BoundingBoxSchema,
  PositionSchema,
} from "./gen/qwibi/v1/geometry_pb.js";
import {
  SubscribeRequestSchema,
  ViewportSchema,
  type SubscribeRequest,
} from "./gen/qwibi/v1/subscribe_pb.js";

export type LiveLayerStatus = "idle" | "connecting" | "live" | "reconnecting" | "stopped";

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
  jitterMin: number;
  jitterMax: number;
  healthyAfterMs: number;
}

export interface LiveLayerViewport {
  bbox: {
    southWest: { lon: number; lat: number };
    northEast: { lon: number; lat: number };
  };
  zoom: number;
}

export interface LiveLayerOptions {
  layerIds: string[];
  appData?: AppDataSource;
  viewport: LiveLayerViewport;
  includePresence?: boolean;
  aggregate?: boolean;
  aggregateProducerInstallationId?: string;
  heartbeatSeconds?: number;
  stateKinds?: string[];
  backoff?: Partial<BackoffPolicy>;
  /** Opaque cursor restored by the application; never parsed by LiveLayer. */
  initialCursor?: string;
}

export interface StreamSource {
  open(request: SubscribeRequest, signal: AbortSignal): AsyncIterable<ServerEvent>;
}

/** The narrow Connect-compatible surface needed by createStreamSource. */
export interface StreamLayerClient {
  streamLayer(request: SubscribeRequest, options?: { signal?: AbortSignal }): AsyncIterable<ServerEvent>;
}

/** Adapts the generated Connect-Web client to LiveLayer's transport seam. */
export function createStreamSource(client: StreamLayerClient): StreamSource {
  return {
    open: (request, signal) => client.streamLayer(request, { signal }),
  };
}

export type LiveLayerErrorReason =
  | "slow_consumer"
  | "resume_token_expired"
  | "transport"
  | "not_found"
  | "stream";

export class LiveLayerError extends Error {
  readonly reason: LiveLayerErrorReason;
  readonly detail?: ErrorDetail;
  override readonly cause?: unknown;

  constructor(reason: LiveLayerErrorReason, message: string, options: { detail?: ErrorDetail; cause?: unknown } = {}) {
    super(message);
    this.name = "LiveLayerError";
    this.reason = reason;
    this.detail = options.detail;
    this.cause = options.cause;
  }
}

export interface LiveLayerEvents {
  /** Original envelope, including the exact server-owned provenance matrix. */
  serverEvent: ServerEvent;
  snapshot: Snapshot;
  created: GeoObject;
  updated: GeoObject;
  moved: ObjectMoved;
  deleted: ObjectDeleted;
  viewerCount: ViewerCount;
  presence: PresenceEvent;
  clusterSnapshot: ClusterSnapshot;
  aggregateUpdated: AggregateUpdated;
  stateEvent: StateEvent;
  stateClear: StateClear;
  layerDeleted: string;
  heartbeat: ServerEvent;
  cursor: string;
  status: LiveLayerStatus;
  error: LiveLayerError;
}

const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  maxMs: 30_000,
  jitterMin: 0.5,
  jitterMax: 1,
  healthyAfterMs: 5_000,
};

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
  });
}

function errorCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? Number((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Managed QTP layer stream: cursor resume, reconnect/backoff, in-band reset
 * handling and per-object replay de-duplication. The source owns transport;
 * LiveLayer owns only protocol state.
 */
export class LiveLayer {
  private readonly source: StreamSource;
  private readonly options: LiveLayerOptions;
  private readonly backoff: BackoffPolicy;
  private readonly listeners = new Map<keyof LiveLayerEvents, Set<(value: unknown) => void>>();
  private readonly versions = new Map<string, bigint>();
  private lifecycle?: AbortController;
  private opening?: AbortController;
  private running?: Promise<void>;
  private viewport: LiveLayerViewport;
  private _status: LiveLayerStatus = "idle";
  private _cursor: string;
  private retargetRequested = false;

  constructor(source: StreamSource, options: LiveLayerOptions) {
    if (options.layerIds.length + (options.appData ? 1 : 0) !== 1) {
      throw new RangeError("LiveLayer requires exactly one Layer or App source");
    }
    this.source = source;
    this.options = {
      ...options,
      layerIds: [...options.layerIds],
      stateKinds: [...(options.stateKinds ?? [])],
    };
    this.viewport = options.viewport;
    this._cursor = options.aggregate ? "" : (options.initialCursor ?? "");
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    if (this.backoff.baseMs <= 0 || this.backoff.maxMs < this.backoff.baseMs
      || this.backoff.jitterMin < 0 || this.backoff.jitterMax < this.backoff.jitterMin
      || this.backoff.healthyAfterMs < 0) {
      throw new RangeError("invalid LiveLayer backoff policy");
    }
  }

  get status(): LiveLayerStatus {
    return this._status;
  }

  get cursor(): string {
    return this._cursor;
  }

  on<K extends keyof LiveLayerEvents>(event: K, callback: (value: LiveLayerEvents[K]) => void): () => void {
    let callbacks = this.listeners.get(event);
    if (!callbacks) {
      callbacks = new Set();
      this.listeners.set(event, callbacks);
    }
    callbacks.add(callback as (value: unknown) => void);
    return () => callbacks?.delete(callback as (value: unknown) => void);
  }

  start(): void {
    if (this.lifecycle && !this.lifecycle.signal.aborted) return;
    this.lifecycle = new AbortController();
    this.setStatus("connecting");
    this.running = this.run(this.lifecycle.signal).finally(() => {
      this.opening = undefined;
      this.setStatus("stopped");
    });
  }

  stop(): void {
    this.lifecycle?.abort();
    this.opening?.abort();
    this.setStatus("stopped");
  }

  /** Re-opens on the new viewport. Cursor-v2/v3 remains opaque and resumable across retarget. */
  setViewport(viewport: LiveLayerViewport): void {
    this.viewport = viewport;
    if (!this.lifecycle || this.lifecycle.signal.aborted) return;
    this.retargetRequested = true;
    this.setStatus("reconnecting");
    this.opening?.abort();
  }

  private emit<K extends keyof LiveLayerEvents>(event: K, value: LiveLayerEvents[K]): void {
    for (const callback of this.listeners.get(event) ?? []) callback(value);
  }

  private setStatus(status: LiveLayerStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit("status", status);
  }

  private setCursor(cursor: string): void {
    if (this.options.aggregate || this._cursor === cursor) return;
    this._cursor = cursor;
    this.emit("cursor", cursor);
  }

  private request(): SubscribeRequest {
    const viewport = create(ViewportSchema, {
      bbox: create(BoundingBoxSchema, {
        southWest: create(PositionSchema, this.viewport.bbox.southWest),
        northEast: create(PositionSchema, this.viewport.bbox.northEast),
      }),
      zoom: Math.max(0, Math.min(30, Math.round(this.viewport.zoom))),
    });
    return create(SubscribeRequestSchema, {
      layerIds: this.options.layerIds,
      appData: this.options.appData,
      viewport,
      cursor: this.options.aggregate ? "" : this._cursor,
      options: {
        includePresence: this.options.includePresence ?? false,
        heartbeat: this.options.heartbeatSeconds ?? 0,
        aggregate: this.options.aggregate ?? false,
        stateKinds: this.options.stateKinds ?? [],
        ...(this.options.aggregateProducerInstallationId
          ? { aggregateProducerInstallationId: this.options.aggregateProducerInstallationId }
          : {}),
      },
    });
  }

  private acceptVersion(objectId: string, version: bigint): boolean {
    const previous = this.versions.get(objectId);
    if (previous !== undefined && version <= previous) return false;
    this.versions.set(objectId, version);
    return true;
  }

  private handle(event: ServerEvent): "continue" | "reset" | "stop" {
    this.emit("serverEvent", event);
    if (event.cursor) this.setCursor(event.cursor);
    const payload = deliveryPayload(event);
    switch (payload.case) {
      case "snapshot": {
        this.versions.clear();
        const objects = payload.value.objects.filter((object) => this.acceptVersion(object.uid, object.version));
        this.emit("snapshot", { ...payload.value, objects });
        break;
      }
      case "objectCreated": {
        const object = payload.value.object;
        if (object && this.acceptVersion(object.uid, object.version)) this.emit("created", object);
        break;
      }
      case "objectUpdated": {
        const object = payload.value.object;
        if (object && this.acceptVersion(object.uid, object.version)) this.emit("updated", object);
        break;
      }
      case "objectMoved": {
        const moved = payload.value;
        if (!this.options.stateKinds?.includes("position") && this.acceptVersion(moved.objectId, moved.version)) {
          this.emit("moved", moved);
        }
        break;
      }
      case "objectDeleted": {
        const deleted = payload.value;
        if (this.acceptVersion(deleted.objectId, deleted.version)) this.emit("deleted", deleted);
        break;
      }
      case "viewerCount":
        this.emit("viewerCount", payload.value);
        break;
      case "presence":
        this.emit("presence", payload.value);
        break;
      case "clusterSnapshot":
        this.emit("clusterSnapshot", payload.value);
        break;
      case "aggregateUpdated":
        this.emit("aggregateUpdated", payload.value);
        break;
      case "stateEvent":
        this.emit("stateEvent", payload.value);
        break;
      case "stateClear":
        this.emit("stateClear", payload.value);
        break;
      case "heartbeat":
        this.emit("heartbeat", event);
        break;
      case "layerDeleted":
        this.versions.clear();
        this.setCursor("");
        this.emit("layerDeleted", payload.value.layerId);
        return "stop";
      case "error": {
        const detail = payload.value.error;
        if (detail?.code === ErrorCode.SLOW_CONSUMER || detail?.code === ErrorCode.RESUME_TOKEN_EXPIRED) {
          const reason = detail.code === ErrorCode.SLOW_CONSUMER ? "slow_consumer" : "resume_token_expired";
          this.emit("error", new LiveLayerError(reason, detail.message || reason, { detail }));
          this.setCursor("");
          this.versions.clear();
          return "reset";
        }
        this.emit("error", new LiveLayerError("stream", detail?.message || "stream error", { detail }));
        break;
      }
    }
    return "continue";
  }

  private async run(signal: AbortSignal): Promise<void> {
    let attempts = 0;
    while (!signal.aborted) {
      const startedAt = Date.now();
      const opening = new AbortController();
      this.opening = opening;
      const stopOpening = () => opening.abort();
      signal.addEventListener("abort", stopOpening, { once: true });
      let action: "continue" | "reset" | "stop" = "continue";
      try {
        const events = this.source.open(this.request(), opening.signal);
        this.setStatus("live");
        for await (const event of events) {
          action = this.handle(event);
          if (action !== "continue") break;
        }
      }
      catch (cause) {
        if (signal.aborted) return;
        if (!this.retargetRequested) {
          if (errorCode(cause) === 5) {
            this.emit("error", new LiveLayerError("not_found", "source not found", { cause }));
            if (!this.options.appData) this.emit("layerDeleted", this.options.layerIds[0]!);
            return;
          }
          this.emit("error", new LiveLayerError("transport", "layer stream interrupted", { cause }));
        }
      }
      finally {
        signal.removeEventListener("abort", stopOpening);
        if (this.opening === opening) this.opening = undefined;
      }

      if (signal.aborted || action === "stop") return;
      if (this.retargetRequested) {
        this.retargetRequested = false;
        this.setStatus("reconnecting");
        continue;
      }
      if (Date.now() - startedAt > this.backoff.healthyAfterMs) attempts = 0;
      attempts++;
      this.setStatus("reconnecting");
      const base = Math.min(this.backoff.baseMs * 2 ** (attempts - 1), this.backoff.maxMs);
      const jitter = this.backoff.jitterMin + Math.random() * (this.backoff.jitterMax - this.backoff.jitterMin);
      await waitForRetry(Math.round(base * jitter), signal);
    }
  }
}
