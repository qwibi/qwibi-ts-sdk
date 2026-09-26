import { create, type JsonObject } from "@bufbuild/protobuf";
import { lineString, point, polygon, type LonLat } from "./geometry.js";
import {
  ObjectWriteSchema,
  type ObjectWrite,
} from "./gen/qwibi/v1/object_pb.js";

export type StyleSchema =
  | "qwibi:style/v0"
  | "https://qwibi.dev/schemas/style/v0.json";

/** The complete, typed L1 style-v0 vocabulary. Unknown keys remain valid on the
 * wire, but this builder deliberately accepts only keys a v0 renderer defines. */
export interface QStyle {
  readonly $schema?: StyleSchema;
  readonly fill?: string;
  readonly stroke?: string;
  readonly color?: string;
  readonly strokeWidth?: number;
  readonly radius?: number;
  readonly image?: string;
  readonly priority?: number;
  readonly fillOpacity?: number;
}

const styleKeys = [
  "$schema",
  "fill",
  "stroke",
  "color",
  "strokeWidth",
  "radius",
  "image",
  "priority",
  "fillOpacity",
] as const satisfies readonly (keyof QStyle)[];
const styleKeySet = new Set<string>(styleKeys);
const stringStyleKeys = ["fill", "stroke", "color", "image"] as const;
const numberStyleKeys = ["strokeWidth", "radius", "priority", "fillOpacity"] as const;
const styleSchemas = new Set<StyleSchema>([
  "qwibi:style/v0",
  "https://qwibi.dev/schemas/style/v0.json",
]);

// ObjectWrite.style is capped at 16 KiB by the canonical proto contract. This is
// a named protocol bound, not an operational tuning value.
const maxStyleBytes = 16 * 1024;
const targetHumanIDPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;

function validateHumanID(hid: string): void {
  if (hid === "") throw new TypeError("human identifier is empty");
  if (hid.includes("_")) throw new TypeError("human identifier contains an underscore");
  if (/[A-Z]/.test(hid)) throw new TypeError("human identifier contains uppercase");
  if (!targetHumanIDPattern.test(hid)) {
    throw new TypeError("human identifier does not match ^[a-z0-9][a-z0-9-]{1,62}$");
  }
}

/** Serialize one style-v0 document with deterministic key order. Invalid typed
 * values fail at construction instead of becoming a rejected or misleading write. */
export function qstyle(style: QStyle): string {
  for (const key of Object.keys(style)) {
    if (!styleKeySet.has(key)) {
      throw new TypeError(`unknown Qwibi style-v0 key: ${key}`);
    }
  }

  if (style.$schema !== undefined && !styleSchemas.has(style.$schema)) {
    throw new TypeError(`unsupported Qwibi style schema: ${style.$schema}`);
  }
  for (const key of stringStyleKeys) {
    const value = style[key];
    if (value !== undefined && typeof value !== "string") {
      throw new TypeError(`Qwibi style ${key} must be a string`);
    }
  }
  for (const key of numberStyleKeys) {
    const value = style[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new TypeError(`Qwibi style ${key} must be a finite number`);
    }
  }
  if (style.fillOpacity !== undefined && (style.fillOpacity < 0 || style.fillOpacity > 1)) {
    throw new RangeError("Qwibi style fillOpacity must be in [0, 1]");
  }

  const document: Record<string, string | number> = {};
  for (const key of styleKeys) {
    const value = style[key];
    if (value !== undefined) document[key] = value;
  }
  const encoded = JSON.stringify(document);
  if (new TextEncoder().encode(encoded).byteLength > maxStyleBytes) {
    throw new RangeError(`Qwibi style exceeds the ${maxStyleBytes}-byte wire limit`);
  }
  return encoded;
}

export interface L1ObjectOptions {
  readonly name?: string;
  readonly hid: string;
  readonly ttlSeconds?: number;
  readonly properties?: JsonObject;
  readonly style?: QStyle;
  readonly category?: string;
  readonly priority?: number;
  readonly isSelectable?: boolean;
  readonly isVisible?: boolean;
  readonly parentId?: string;
}

export interface RouteOptions extends L1ObjectOptions {}

type ConstructedObjectType = "marker" | "message" | "track" | "zone" | "route";

function objectWrite(
  objectType: ConstructedObjectType,
  geometry: NonNullable<ObjectWrite["geometry"]>,
  options: L1ObjectOptions,
): ObjectWrite {
  validateHumanID(options.hid);
  return create(ObjectWriteSchema, {
    geometry,
    objectType,
    style: options.style === undefined ? undefined : qstyle(options.style),
    name: options.name,
    hid: options.hid,
    ttlSeconds: options.ttlSeconds,
    properties: options.properties,
    category: options.category,
    priority: options.priority,
    isSelectable: options.isSelectable,
    isVisible: options.isVisible,
    parentId: options.parentId,
  });
}

/** An application marker Point. */
export function marker(lon: number, lat: number, options: L1ObjectOptions): ObjectWrite {
  return objectWrite("marker", point(lon, lat), options);
}

/** A point-anchored message. `text` is both its default display name and the
 * canonical `properties.text`; the explicit argument wins over a colliding bag key. */
export function message(
  lon: number,
  lat: number,
  text: string,
  options: L1ObjectOptions,
): ObjectWrite {
  return objectWrite("message", point(lon, lat), {
    ...options,
    name: options.name ?? text,
    properties: { ...(options.properties ?? {}), text },
  });
}

/** An application track LineString. */
export function track(points: LonLat[], options: L1ObjectOptions): ObjectWrite {
  return objectWrite("track", lineString(...points), options);
}

/** An application zone Polygon: first ring exterior, remaining rings holes. */
export function zone(rings: LonLat[][], options: L1ObjectOptions): ObjectWrite {
  return objectWrite("zone", polygon(...rings), options);
}

/** A computed route LineString. */
export function route(points: LonLat[], options: RouteOptions): ObjectWrite {
  return objectWrite("route", lineString(...points), options);
}
