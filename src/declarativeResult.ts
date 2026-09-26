import type { JsonObject, JsonValue } from "@bufbuild/protobuf";

import {
  DeclarativeValueFormatKind,
  ObjectReferenceValueKind,
  type DeclarativeResultSchema,
} from "./gen/qwibi/v1/app_release_pb.js";

export type DeclarativeResultParameterValue =
  | string
  | number
  | boolean
  | null
  | readonly string[];

export type ResultPosition = readonly [number, number, ...number[]];

export type DeclarativeResultGeometry =
  | { readonly type: "Point"; readonly coordinates: ResultPosition }
  | { readonly type: "LineString"; readonly coordinates: readonly ResultPosition[] }
  | { readonly type: "Polygon"; readonly coordinates: readonly (readonly ResultPosition[])[] }
  | { readonly type: "MultiPoint"; readonly coordinates: readonly ResultPosition[] }
  | { readonly type: "MultiLineString"; readonly coordinates: readonly (readonly ResultPosition[])[] }
  | { readonly type: "MultiPolygon"; readonly coordinates: readonly (readonly (readonly ResultPosition[])[])[] }
  | { readonly type: "GeometryCollection"; readonly geometries: readonly DeclarativeResultGeometry[] };

export interface DeclarativeResultParameterValueModel {
  readonly propertyId: string;
  readonly labelLocalizationKey: string;
  readonly formatKind: DeclarativeValueFormatKind;
  readonly value: DeclarativeResultParameterValue;
}

export interface DeclarativeResultObjectReferenceValue {
  readonly propertyId: string;
  readonly labelLocalizationKey: string;
  readonly objectType: string;
  readonly valueKind: ObjectReferenceValueKind;
  readonly value: string;
}

export interface DeclarativeResultSegment {
  readonly geometry: DeclarativeResultGeometry;
  readonly style: Readonly<JsonObject>;
}

/**
 * ADR-0027 aligns this cap with the existing 64-item declarative parameter and
 * object-reference bounds, limiting one map update and one card index.
 */
export const DECLARATIVE_RESULT_POINT_SET_MAX_ITEMS = 64;

export interface DeclarativeResultPointSetItem {
  readonly geometry: Extract<DeclarativeResultGeometry, { readonly type: "Point" }>;
  readonly title: string;
  readonly description: string;
  readonly link: string;
  readonly image?: string;
}

export interface DeclarativeResultCandidate {
  readonly parameters: readonly DeclarativeResultParameterValueModel[];
  readonly geometry: DeclarativeResultGeometry;
  readonly objectReferences: readonly DeclarativeResultObjectReferenceValue[];
  readonly segments: readonly DeclarativeResultSegment[];
  readonly pointSet: readonly DeclarativeResultPointSetItem[];
}

export interface DeclarativeResultModel {
  readonly selected: DeclarativeResultCandidate;
  readonly alternatives: readonly DeclarativeResultCandidate[];
}

/** The release and result payload disagree, so the host must use its safe fallback. */
export class DeclarativeResultParseError extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "DeclarativeResultParseError";
  }
}

/**
 * Parses one signal result solely through its release declaration. The parser
 * contains no App names or reserved producer property names.
 */
export function parseDeclarativeResult(
  declaration: DeclarativeResultSchema,
  result: JsonObject,
): DeclarativeResultModel {
  const selected = asObject(
    result[declaration.selectedResultProperty],
    declaration.selectedResultProperty,
  );
  const alternativesValue = result[declaration.alternativesProperty];
  if (!Array.isArray(alternativesValue)) {
    throw new DeclarativeResultParseError(
      declaration.alternativesProperty,
      "expected an array",
    );
  }
  return {
    selected: parseCandidate(declaration, selected, declaration.selectedResultProperty),
    alternatives: alternativesValue.map((candidate, index) =>
      parseCandidate(
        declaration,
        asObject(candidate, `${declaration.alternativesProperty}[${index}]`),
        `${declaration.alternativesProperty}[${index}]`,
      )
    ),
  };
}

function parseCandidate(
  declaration: DeclarativeResultSchema,
  candidate: JsonObject,
  path: string,
): DeclarativeResultCandidate {
  if (declaration.segments !== undefined && declaration.pointSet !== undefined) {
    throw new DeclarativeResultParseError(path, "point_set and segments are mutually exclusive");
  }
  const parameters = declaration.parameters.map((parameter) => ({
    propertyId: parameter.propertyId,
    labelLocalizationKey: parameter.labelLocalizationKey,
    formatKind: parameter.formatKind,
    value: parseParameter(
      candidate[parameter.propertyId],
      parameter.formatKind,
      `${path}.${parameter.propertyId}`,
    ),
  }));
  const geometry = parseGeometry(
    candidate[declaration.geometryProperty],
    `${path}.${declaration.geometryProperty}`,
  );
  const objectReferences = declaration.objectReferences.flatMap((reference) => {
    const value = candidate[reference.propertyId];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new DeclarativeResultParseError(
        `${path}.${reference.propertyId}`,
        "expected an array of object-reference strings",
      );
    }
    return value.map((item) => {
      validateObjectReference(item, reference.valueKind, `${path}.${reference.propertyId}`);
      return {
        propertyId: reference.propertyId,
        labelLocalizationKey: reference.labelLocalizationKey,
        objectType: reference.objectType,
        valueKind: reference.valueKind,
        value: item,
      };
    });
  });
  const segments = declaration.segments === undefined
    ? []
    : parseSegments(declaration.segments, candidate, path);
  const pointSet = declaration.pointSet === undefined
    ? []
    : parsePointSet(
        declaration.pointSet,
        candidate,
        geometry,
        declaration.geometryProperty,
        path,
      );
  return { parameters, geometry, objectReferences, segments, pointSet };
}

function parsePointSet(
  declaration: NonNullable<DeclarativeResultSchema["pointSet"]>,
  candidate: JsonObject,
  aggregate: DeclarativeResultGeometry,
  aggregateProperty: string,
  path: string,
): readonly DeclarativeResultPointSetItem[] {
  const rawItems = candidate[declaration.itemsProperty];
  if (!Array.isArray(rawItems)) {
    throw new DeclarativeResultParseError(
      `${path}.${declaration.itemsProperty}`,
      "expected an array of point-set items",
    );
  }
  if (rawItems.length > DECLARATIVE_RESULT_POINT_SET_MAX_ITEMS) {
    throw new DeclarativeResultParseError(
      `${path}.${declaration.itemsProperty}`,
      `exceeds the ${DECLARATIVE_RESULT_POINT_SET_MAX_ITEMS}-item point-set limit`,
    );
  }
  const items = rawItems.map((rawItem, index) => {
    const itemPath = `${path}.${declaration.itemsProperty}[${index}]`;
    const item = asObject(rawItem, itemPath);
    const geometry = parseGeometry(
      item[declaration.geometryProperty],
      `${itemPath}.${declaration.geometryProperty}`,
    );
    if (geometry.type !== "Point") {
      throw new DeclarativeResultParseError(
        `${itemPath}.${declaration.geometryProperty}.type`,
        "expected a GeoJSON Point",
      );
    }
    const title = nonEmptyString(item[declaration.titleProperty], `${itemPath}.${declaration.titleProperty}`);
    const description = nonEmptyString(
      item[declaration.descriptionProperty],
      `${itemPath}.${declaration.descriptionProperty}`,
    );
    const link = absoluteHTTPSURL(
      item[declaration.linkProperty],
      `${itemPath}.${declaration.linkProperty}`,
    );
    if (declaration.imageProperty === "") {
      return { geometry, title, description, link };
    }
    const rawImage = item[declaration.imageProperty];
    if (rawImage === undefined) {
      return { geometry, title, description, link };
    }
    const image = absoluteHTTPSURL(rawImage, `${itemPath}.${declaration.imageProperty}`);
    return { geometry, title, description, link, image };
  });

  if (aggregate.type !== "MultiPoint") {
    throw new DeclarativeResultParseError(
      `${path}.${declaration.itemsProperty}`,
      "point-set aggregate geometry must be a GeoJSON MultiPoint",
    );
  }
  const itemCoordinates = items.map((item) => item.geometry.coordinates);
  if (!positionsEqual(aggregate.coordinates, itemCoordinates)) {
    throw new DeclarativeResultParseError(
      `${path}.${aggregateProperty}.coordinates`,
      "aggregate MultiPoint coordinates disagree with point-set items",
    );
  }
  return items;
}

function nonEmptyString(value: JsonValue | undefined, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DeclarativeResultParseError(path, "expected a non-empty string");
  }
  return value;
}

function absoluteHTTPSURL(value: JsonValue | undefined, path: string): string {
  const raw = nonEmptyString(value, path);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DeclarativeResultParseError(path, "expected an absolute HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new DeclarativeResultParseError(path, "expected an absolute HTTPS URL");
  }
  return raw;
}

function positionsEqual(
  left: readonly ResultPosition[],
  right: readonly ResultPosition[],
): boolean {
  return left.length === right.length && left.every((position, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      position.length === candidate.length &&
      position.every((coordinate, coordinateIndex) => coordinate === candidate[coordinateIndex]);
  });
}

function parseSegments(
  declaration: NonNullable<DeclarativeResultSchema["segments"]>,
  candidate: JsonObject,
  path: string,
): readonly DeclarativeResultSegment[] {
  const value = candidate[declaration.segmentsProperty];
  if (!Array.isArray(value)) {
    throw new DeclarativeResultParseError(
      `${path}.${declaration.segmentsProperty}`,
      "expected an array of styled geometry segments",
    );
  }
  return value.map((item, index) => {
    const segmentPath = `${path}.${declaration.segmentsProperty}[${index}]`;
    const segment = asObject(item, segmentPath);
    const geometry = parseGeometry(
      segment[declaration.geometryProperty],
      `${segmentPath}.${declaration.geometryProperty}`,
    );
    const rawStyle = segment[declaration.styleProperty];
    if (typeof rawStyle !== "string") {
      throw new DeclarativeResultParseError(
        `${segmentPath}.${declaration.styleProperty}`,
        "expected a JSON style string",
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawStyle);
    } catch {
      throw new DeclarativeResultParseError(
        `${segmentPath}.${declaration.styleProperty}`,
        "invalid JSON style",
      );
    }
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new DeclarativeResultParseError(
        `${segmentPath}.${declaration.styleProperty}`,
        "expected a JSON style object",
      );
    }
    const style = decoded as JsonObject;
    if (
      declaration.colorRequired &&
      (typeof style.color !== "string" || style.color.length === 0)
    ) {
      throw new DeclarativeResultParseError(
        `${segmentPath}.${declaration.styleProperty}.color`,
        "required segment color is missing",
      );
    }
    return { geometry, style };
  });
}

function parseParameter(
  value: JsonValue | undefined,
  format: DeclarativeValueFormatKind,
  path: string,
): DeclarativeResultParameterValue {
  switch (format) {
    case DeclarativeValueFormatKind.TEXT:
    case DeclarativeValueFormatKind.COLOR:
      if (typeof value === "string") return value;
      break;
    case DeclarativeValueFormatKind.NUMBER:
      if (typeof value === "number" && Number.isFinite(value)) return value;
      break;
    case DeclarativeValueFormatKind.INTEGER:
    case DeclarativeValueFormatKind.DURATION_MINUTES:
      if (typeof value === "number" && Number.isSafeInteger(value)) return value;
      break;
    case DeclarativeValueFormatKind.STRING_LIST:
      if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        return value;
      }
      break;
    case DeclarativeValueFormatKind.UNSPECIFIED:
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        (Array.isArray(value) && value.every((item) => typeof item === "string"))
      ) {
        return value;
      }
      break;
  }
  throw new DeclarativeResultParseError(path, `value does not match format ${format}`);
}

function validateObjectReference(
  value: string,
  kind: ObjectReferenceValueKind,
  path: string,
): void {
  if (
    kind === ObjectReferenceValueKind.ID &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  ) {
    return;
  }
  if (
    kind === ObjectReferenceValueKind.HID &&
    /^[a-z0-9][a-z0-9-]{1,62}$/.test(value)
  ) {
    return;
  }
  throw new DeclarativeResultParseError(path, `invalid object reference ${JSON.stringify(value)}`);
}

function asObject(value: JsonValue | undefined, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DeclarativeResultParseError(path, "expected an object");
  }
  return value;
}

function parseGeometry(value: JsonValue | undefined, path: string): DeclarativeResultGeometry {
  const geometry = asObject(value, path);
  switch (geometry.type) {
    case "Point":
      return { type: "Point", coordinates: position(geometry.coordinates, `${path}.coordinates`) };
    case "LineString":
    case "MultiPoint":
      return {
        type: geometry.type,
        coordinates: positions(geometry.coordinates, `${path}.coordinates`),
      };
    case "Polygon":
    case "MultiLineString":
      return {
        type: geometry.type,
        coordinates: positionGroups(geometry.coordinates, `${path}.coordinates`),
      };
    case "MultiPolygon": {
      const polygons = array(geometry.coordinates, `${path}.coordinates`);
      return {
        type: "MultiPolygon",
        coordinates: polygons.map((polygon, index) =>
          positionGroups(polygon, `${path}.coordinates[${index}]`)
        ),
      };
    }
    case "GeometryCollection": {
      const geometries = array(geometry.geometries, `${path}.geometries`);
      return {
        type: "GeometryCollection",
        geometries: geometries.map((item, index) => parseGeometry(item, `${path}.geometries[${index}]`)),
      };
    }
    default:
      throw new DeclarativeResultParseError(`${path}.type`, "unsupported GeoJSON geometry type");
  }
}

function position(value: JsonValue | undefined, path: string): ResultPosition {
  const coordinates = array(value, path);
  if (
    coordinates.length < 2 ||
    !coordinates.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  ) {
    throw new DeclarativeResultParseError(path, "expected a finite GeoJSON position");
  }
  const numeric = coordinates as number[];
  const lon = numeric[0]!;
  const lat = numeric[1]!;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new DeclarativeResultParseError(path, "longitude or latitude is out of range");
  }
  return numeric as unknown as ResultPosition;
}

function positions(value: JsonValue | undefined, path: string): readonly ResultPosition[] {
  return array(value, path).map((item, index) => position(item, `${path}[${index}]`));
}

function positionGroups(
  value: JsonValue | undefined,
  path: string,
): readonly (readonly ResultPosition[])[] {
  return array(value, path).map((item, index) => positions(item, `${path}[${index}]`));
}

function array(value: JsonValue | undefined, path: string): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new DeclarativeResultParseError(path, "expected an array");
  }
  return value;
}
