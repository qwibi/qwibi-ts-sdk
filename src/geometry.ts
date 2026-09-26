// Ergonomic constructors for every GeoJSON geometry kind, mirroring the Go SDK
// helpers. Each returns a qwibi.v1 Geometry ready to drop into an ObjectWrite or
// a query. Points are given as [lon, lat] pairs (longitude first, EPSG:4326),
// matching the wire Position.
import { create } from "@bufbuild/protobuf";
import { GeometrySchema, type Geometry } from "./gen/qwibi/v1/geometry_pb.js";

export type LonLat = [number, number];

function pos(p: LonLat) {
  return { lon: p[0], lat: p[1] };
}

/** Rejects an out-of-range coordinate at construction (the same bound the server
 * enforces) so an invalid point fails here instead of after a round-trip. */
function checkLonLat([lon, lat]: LonLat): void {
  if (!(lon >= -180 && lon <= 180) || !(lat >= -90 && lat <= 90)) {
    throw new RangeError(`coordinate out of range: [${lon}, ${lat}] (lon ∈ [-180,180], lat ∈ [-90,90])`);
  }
}

/** Point geometry from a longitude/latitude. */
export function point(lon: number, lat: number): Geometry {
  checkLonLat([lon, lat]);
  return create(GeometrySchema, {
    geometry: { case: "point", value: { coordinates: { lon, lat } } },
  });
}

/** LineString from a sequence of [lon, lat] points (at least two). */
export function lineString(...points: LonLat[]): Geometry {
  if (points.length < 2) {
    throw new RangeError(`lineString needs at least two points, got ${points.length}`);
  }
  points.forEach(checkLonLat);
  return create(GeometrySchema, {
    geometry: { case: "lineString", value: { coordinates: points.map(pos) } },
  });
}

/**
 * Polygon from one or more rings of [lon, lat] points: the first ring is the
 * exterior boundary, the rest are holes. Each ring must be closed (first point
 * repeated as last).
 */
export function polygon(...rings: LonLat[][]): Geometry {
  for (const r of rings) {
    if (r.length < 4) {
      throw new RangeError(`polygon ring needs at least four points (closed), got ${r.length}`);
    }
    const first = r[0];
    const last = r[r.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      throw new RangeError("polygon ring must be closed (first point repeated as last)");
    }
    r.forEach(checkLonLat);
  }
  return create(GeometrySchema, {
    geometry: { case: "polygon", value: { rings: rings.map((r) => ({ coordinates: r.map(pos) })) } },
  });
}

/** MultiPoint from a set of [lon, lat] points. */
export function multiPoint(...points: LonLat[]): Geometry {
  return create(GeometrySchema, {
    geometry: { case: "multiPoint", value: { coordinates: points.map(pos) } },
  });
}

/** MultiLineString from one or more lines, each a sequence of [lon, lat] points. */
export function multiLineString(...lines: LonLat[][]): Geometry {
  return create(GeometrySchema, {
    geometry: {
      case: "multiLineString",
      value: { lineStrings: lines.map((l) => ({ coordinates: l.map(pos) })) },
    },
  });
}

/** MultiPolygon from one or more polygons; each polygon is a list of rings. */
export function multiPolygon(...polygons: LonLat[][][]): Geometry {
  return create(GeometrySchema, {
    geometry: {
      case: "multiPolygon",
      value: { polygons: polygons.map((poly) => ({ rings: poly.map((r) => ({ coordinates: r.map(pos) })) })) },
    },
  });
}

/**
 * GeometryCollection from other geometries. Per the contract the members must
 * not themselves be GeometryCollections.
 */
export function geometryCollection(...geometries: Geometry[]): Geometry {
  return create(GeometrySchema, {
    geometry: { case: "geometryCollection", value: { geometries } },
  });
}
