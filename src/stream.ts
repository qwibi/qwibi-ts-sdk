import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import type { Geometry } from "./gen/qwibi/v1/geometry_pb.js";
import {
  PublishFrameSchema,
  StreamIngressService,
  TickSchema,
  type PublishFrame,
  type PublishReceipt,
} from "./gen/qwibi/stream/v1/stream_pb.js";

export interface PositionUpdate {
  key: string;
  position: Geometry;
  expectedBaseVersion?: bigint;
}

export interface PositionWriterOptions {
  /** Restore an existing logical writer session; omitted creates a new high-entropy id. */
  writerId?: string;
}

export type StreamIngressClient = Client<typeof StreamIngressService>;

const WRITER_ID = /^[A-Za-z0-9_-]{8,64}$/;
const ZERO = BigInt(0);
const ONE = BigInt(1);

export function createWriterId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (!randomUUID) throw new Error("a cryptographically secure randomUUID implementation is required");
  return randomUUID();
}

/** Stable writer identity plus monotone per-key counters for one logical session. */
export class PositionWriterSession {
  readonly writerId: string;
  private readonly sequences = new Map<string, bigint>();
  private nextFrameId = ONE;

  constructor(options: PositionWriterOptions = {}) {
    this.writerId = options.writerId ?? createWriterId();
    if (!WRITER_ID.test(this.writerId)) {
      throw new Error("writerId must match the Stream API 8-64 character identity contract");
    }
  }

  sequence(key: string): bigint {
    return this.sequences.get(key) ?? ZERO;
  }

  /** Builds one immutable frame; retry this same value after a transport failure. */
  prepareFrame(layerId: string, updates: readonly PositionUpdate[]): PublishFrame {
    if (updates.length === 0) throw new RangeError("a position frame must contain at least one update");
    const ticks = updates.map((update) => {
      const clientSeq = (this.sequences.get(update.key) ?? ZERO) + ONE;
      this.sequences.set(update.key, clientSeq);
      return create(TickSchema, {
        kind: "position",
        key: update.key,
        value: { case: "position", value: update.position },
        clientSeq,
        expectedBaseVersion: update.expectedBaseVersion ?? ZERO,
        writerId: this.writerId,
      });
    });
    return create(PublishFrameSchema, { layerId, ticks, frameId: this.nextFrameId++ });
  }

  publishPrepared(client: StreamIngressClient, frame: PublishFrame): Promise<PublishReceipt> {
    return client.publishBatch(frame);
  }

  publishPositions(
    client: StreamIngressClient,
    layerId: string,
    updates: readonly PositionUpdate[],
  ): Promise<PublishReceipt> {
    return this.publishPrepared(client, this.prepareFrame(layerId, updates));
  }
}
