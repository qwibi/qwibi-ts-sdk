import { describe, expect, it, vi } from "vitest";
import { PositionWriterSession, point } from "../src/index.js";

describe("PositionWriterSession", () => {
  it("keeps one writer identity with monotone per-key counters and frame ids", () => {
    const writer = new PositionWriterSession({ writerId: "writer-session-0001" });
    const first = writer.prepareFrame("layer-1", [
      { key: "a", position: point(1, 2) },
      { key: "b", position: point(3, 4), expectedBaseVersion: 7n },
    ]);
    const second = writer.prepareFrame("layer-1", [{ key: "a", position: point(5, 6) }]);

    expect(first.frameId).toBe(1n);
    expect(second.frameId).toBe(2n);
    expect(first.ticks.map((tick) => [tick.key, tick.clientSeq, tick.writerId])).toEqual([
      ["a", 1n, "writer-session-0001"],
      ["b", 1n, "writer-session-0001"],
    ]);
    expect(first.ticks[1]?.expectedBaseVersion).toBe(7n);
    expect(second.ticks[0]?.clientSeq).toBe(2n);
  });

  it("publishes the exact prepared frame again on retry", async () => {
    const writer = new PositionWriterSession({ writerId: "writer-session-0001" });
    const frame = writer.prepareFrame("layer-1", [{ key: "a", position: point(1, 2) }]);
    const client = {
      publishBatch: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({
        frameId: frame.frameId,
        applied: 1,
        rejected: [],
      }),
    };

    await expect(writer.publishPrepared(client as never, frame)).rejects.toThrow("offline");
    await expect(writer.publishPrepared(client as never, frame)).resolves.toMatchObject({ applied: 1 });
    expect(client.publishBatch).toHaveBeenNthCalledWith(1, frame);
    expect(client.publishBatch).toHaveBeenNthCalledWith(2, frame);
  });

  it("rejects empty frames and invalid restored writer ids", () => {
    expect(() => new PositionWriterSession({ writerId: "short" })).toThrow(/writerId/);
    const writer = new PositionWriterSession({ writerId: "writer-session-0001" });
    expect(() => writer.prepareFrame("layer-1", [])).toThrow(/at least one/);
  });
});
