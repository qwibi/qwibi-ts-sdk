import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  marker,
  message,
  qstyle,
  route,
  track,
  zone,
  type ObjectWrite,
} from "../src/index.js";

function readJSON(path: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
}

const styleSchema = readJSON("../../qwibi-docs/design/schemas/style.v0.schema.json");
const validateStyle = new Ajv2020({ strict: false }).compile(styleSchema);

function parsedStyle(write: ObjectWrite): Record<string, unknown> {
  const parsed = JSON.parse(write.style) as Record<string, unknown>;
  expect(validateStyle(parsed), validateStyle.errors?.map((error) => error.message).join(", ")).toBe(true);
  return parsed;
}

describe("L1 style builder", () => {
  it("serializes every style-v0 key in deterministic order", () => {
    expect(qstyle({
      fillOpacity: 0,
      priority: 4,
      image: "https://example.test/icon.png",
      radius: 5,
      strokeWidth: 2,
      color: "ink",
      stroke: "surface",
      fill: "present",
      $schema: "qwibi:style/v0",
    })).toBe(
      "{\"$schema\":\"qwibi:style/v0\",\"fill\":\"present\",\"stroke\":\"surface\",\"color\":\"ink\",\"strokeWidth\":2,\"radius\":5,\"image\":\"https://example.test/icon.png\",\"priority\":4,\"fillOpacity\":0}",
    );
  });

  it("rejects unknown, non-finite, and out-of-range style values", () => {
    expect(() => qstyle({ unknown: true } as never)).toThrow(/unknown Qwibi style-v0 key/);
    expect(() => qstyle({ radius: Number.NaN })).toThrow(/finite number/);
    expect(() => qstyle({ fillOpacity: 1.1 })).toThrow(/\[0, 1\]/);
    expect(() => qstyle({ $schema: "qwibi:style/v9" } as never)).toThrow(/unsupported/);
  });
});

describe("L1 ObjectWrite constructors", () => {
  const line = [[114.15, 22.28], [114.17, 22.29]] as [number, number][];
  const ring = [[114.15, 22.28], [114.17, 22.28], [114.17, 22.3], [114.15, 22.28]] as [number, number][];

  it("emits every helper-owned type without injecting a style", () => {
    const writes = [
      marker(114.16, 22.28, { hid: "marker-one" }),
      message(114.16, 22.28, "hello", { hid: "message-one" }),
      track(line, { hid: "track-one" }),
      zone([ring], { hid: "zone-one" }),
      route(line, { hid: "route-one" }),
    ];
    expect(writes.map((write) => write.objectType)).toEqual(["marker", "message", "track", "zone", "route"]);
    for (const write of writes) {
      expect(write.style).toBe("");
    }
  });

  it("serializes caller style and passes ordinary ObjectWrite fields through", () => {
    const write = route(line, {
      hid: "pier-route",
      name: "Pier route",
      ttlSeconds: 60,
      properties: { mode: "walk" },
      style: { strokeWidth: 8, color: "present" },
      category: "journey",
      priority: 20,
      isSelectable: false,
      isVisible: true,
      parentId: "01900000-0000-7000-8000-000000000001",
    });

    expect(parsedStyle(write)).toEqual({ color: "present", strokeWidth: 8 });
    expect(write).toMatchObject({
      hid: "pier-route",
      name: "Pier route",
      ttlSeconds: 60,
      properties: { mode: "walk" },
      category: "journey",
      priority: 20,
      isSelectable: false,
      isVisible: true,
      parentId: "01900000-0000-7000-8000-000000000001",
    });
  });

  it("keeps message text canonical without mutating unrelated properties", () => {
    const write = message(114.16, 22.28, "canonical", {
      hid: "message-canonical",
      name: "Display title",
      properties: { text: "stale", channel: "general" },
    });
    expect(write.name).toBe("Display title");
    expect(write.properties).toEqual({ text: "canonical", channel: "general" });
  });

  it("reuses the validated geometry boundary", () => {
    expect(() => marker(181, 22.28, { hid: "invalid-marker" })).toThrow(/coordinate out of range/);
    expect(() => track([[114.16, 22.28]], { hid: "invalid-track" })).toThrow(/at least two points/);
    expect(() => zone([[[114.15, 22.28], [114.17, 22.28], [114.17, 22.3], [114.15, 22.29]]], { hid: "invalid-zone" })).toThrow(/must be closed/);
  });

  it("fails closed for every TypeScript SDK producer and exact HID violation class", () => {
    const producers = [
      ["marker", (hid: string) => marker(114.16, 22.28, { hid })],
      ["message", (hid: string) => message(114.16, 22.28, "message", { hid })],
      ["track", (hid: string) => track(line, { hid })],
      ["zone", (hid: string) => zone([ring], { hid })],
      ["route", (hid: string) => route(line, { hid })],
    ] as const;
    const invalid = [
      ["empty", "", /empty/],
      ["underscore", "ts_bad", /underscore/],
      ["uppercase", "Ts-bad", /uppercase/],
      ["other exact grammar violation", "a.", /does not match/],
    ] as const;
    for (const [producer, build] of producers) {
      expect(() => build("ts-sdk-valid"), producer).not.toThrow();
      for (const [category, hid, error] of invalid) {
        expect(() => build(hid), `${producer}/${category}`).toThrow(error);
      }
    }
  });
});
