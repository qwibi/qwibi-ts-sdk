import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
  DECLARATIVE_RESULT_POINT_SET_MAX_ITEMS,
  DeclarativeResultParseError,
  DeclarativeResultSchemaSchema,
  DeclarativeValueFormatKind,
  ObjectReferenceValueKind,
  parseDeclarativeResult,
} from "../src/index.js";

const declaration = create(DeclarativeResultSchemaSchema, {
  selectedResultProperty: "route",
  alternativesProperty: "alternatives",
  parameters: [
    {
      propertyId: "duration_minutes",
      labelLocalizationKey: "result.duration",
      formatKind: DeclarativeValueFormatKind.DURATION_MINUTES,
    },
    {
      propertyId: "lines",
      labelLocalizationKey: "result.lines",
      formatKind: DeclarativeValueFormatKind.STRING_LIST,
    },
  ],
  geometryProperty: "geometry",
  objectReferences: [{
    propertyId: "stations",
    labelLocalizationKey: "result.stations",
    objectType: "station",
    valueKind: ObjectReferenceValueKind.HID,
  }],
  segments: {
    segmentsProperty: "segments",
    geometryProperty: "geometry",
    styleProperty: "style",
    colorRequired: true,
  },
});

function candidate(duration: number, stations: string[]) {
  return {
    duration_minutes: duration,
    lines: ["Island Line"],
    geometry: {
      type: "LineString",
      coordinates: [[114.16, 22.28], [114.17, 22.29]],
    },
    stations,
    segments: [{
      geometry: {
        type: "LineString",
        coordinates: [[114.16, 22.28], [114.17, 22.29]],
      },
      style: JSON.stringify({ color: "#00529B", strokeWidth: 2.5 }),
    }],
  };
}

describe("declarative result model", () => {
  it("parses selected and alternative geometry, parameters and typed object references", () => {
    const result = parseDeclarativeResult(declaration, {
      route: candidate(6, ["sta-a", "sta-b"]),
      alternatives: [candidate(8, ["sta-a", "sta-c", "sta-b"])],
    });

    expect(result.selected.parameters.map(({ propertyId, value }) => [propertyId, value])).toEqual([
      ["duration_minutes", 6],
      ["lines", ["Island Line"]],
    ]);
    expect(result.selected.geometry).toEqual({
      type: "LineString",
      coordinates: [[114.16, 22.28], [114.17, 22.29]],
    });
    expect(result.selected.objectReferences).toEqual([
      {
        propertyId: "stations",
        labelLocalizationKey: "result.stations",
        objectType: "station",
        valueKind: ObjectReferenceValueKind.HID,
        value: "sta-a",
      },
      {
        propertyId: "stations",
        labelLocalizationKey: "result.stations",
        objectType: "station",
        valueKind: ObjectReferenceValueKind.HID,
        value: "sta-b",
      },
    ]);
    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives[0]?.geometry).toMatchObject({ type: "LineString" });
    expect(result.selected.segments[0]).toMatchObject({
      geometry: { type: "LineString" },
      style: { color: "#00529B", strokeWidth: 2.5 },
    });
  });

  it("rejects an invalid declared object reference instead of silently defaulting", () => {
    expect(() => parseDeclarativeResult(declaration, {
      route: candidate(6, ["INVALID HID"]),
      alternatives: [],
    })).toThrow(DeclarativeResultParseError);
  });

  it("rejects a candidate without per-alternative geometry", () => {
    const alternative = candidate(8, ["sta-a", "sta-b"]);
    delete (alternative as Partial<typeof alternative>).geometry;
    expect(() => parseDeclarativeResult(declaration, {
      route: candidate(6, ["sta-a", "sta-b"]),
      alternatives: [alternative],
    })).toThrow("alternatives[0].geometry");
  });

  it("rejects an alternative segment without the color required by the declaration", () => {
    const alternative = candidate(8, ["sta-a", "sta-b"]);
    alternative.segments[0]!.style = JSON.stringify({ strokeWidth: 2.5 });
    expect(() => parseDeclarativeResult(declaration, {
      route: candidate(6, ["sta-a", "sta-b"]),
      alternatives: [alternative],
    })).toThrow("alternatives[0].segments[0].style.color");
  });
});

const pointSetDeclaration = create(DeclarativeResultSchemaSchema, {
  selectedResultProperty: "nearest",
  alternativesProperty: "alternatives",
  geometryProperty: "geometry",
  pointSet: {
    itemsProperty: "items",
    geometryProperty: "geometry",
    titleProperty: "title",
    descriptionProperty: "description",
    linkProperty: "link",
  },
});

const pointSetImageDeclaration = create(DeclarativeResultSchemaSchema, {
  selectedResultProperty: "nearest",
  alternativesProperty: "alternatives",
  geometryProperty: "geometry",
  pointSet: {
    itemsProperty: "items",
    geometryProperty: "geometry",
    titleProperty: "title",
    descriptionProperty: "description",
    linkProperty: "link",
    imageProperty: "image",
  },
});

function pointSetCandidate(coordinates: number[][], imageIndex = -1) {
  return {
    geometry: { type: "MultiPoint", coordinates },
    items: coordinates.map((point, index) => ({
      geometry: { type: "Point", coordinates: point },
      title: `Shelter ${index + 1}`,
      description: `Shelter description ${index + 1}`,
      link: `https://shelters.example.test/${index + 1}`,
      ...(index === imageIndex
        ? { image: `https://images.example.test/shelter-${index + 1}.jpg` }
        : {}),
    })),
  };
}

describe("declarative point-set result model", () => {
  it("parses ordered point items and an explicit empty alternative", () => {
    const selected = pointSetCandidate([[114.16, 22.28], [114.17, 22.29]]);
    const result = parseDeclarativeResult(pointSetDeclaration, {
      nearest: selected,
      alternatives: [pointSetCandidate([])],
    });

    expect(result.selected.pointSet).toEqual(selected.items);
    expect(result.alternatives[0]?.pointSet).toEqual([]);
    expect(result.alternatives[0]?.geometry).toEqual({ type: "MultiPoint", coordinates: [] });
  });

  it("rejects more than the named ADR-0027 item cap", () => {
    const coordinates = Array.from(
      { length: DECLARATIVE_RESULT_POINT_SET_MAX_ITEMS + 1 },
      (_, index) => [114 + index / 1000, 22],
    );
    expect(() => parseDeclarativeResult(pointSetDeclaration, {
      nearest: pointSetCandidate(coordinates),
      alternatives: [],
    })).toThrow(`${DECLARATIVE_RESULT_POINT_SET_MAX_ITEMS}-item point-set limit`);
  });

  it("rejects aggregate and item coordinate disagreement", () => {
    const selected = pointSetCandidate([[114.16, 22.28]]);
    selected.geometry.coordinates = [[114.17, 22.29]];
    expect(() => parseDeclarativeResult(pointSetDeclaration, {
      nearest: selected,
      alternatives: [],
    })).toThrow("aggregate MultiPoint coordinates disagree");
  });

  it("rejects an unsafe point-set link", () => {
    const selected = pointSetCandidate([[114.16, 22.28]]);
    selected.items[0]!.link = "http://shelters.example.test/1";
    expect(() => parseDeclarativeResult(pointSetDeclaration, {
      nearest: selected,
      alternatives: [],
    })).toThrow("expected an absolute HTTPS URL");
  });

  it("parses an optional image with the same HTTPS boundary as a link", () => {
    const selected = pointSetCandidate([[114.16, 22.28], [114.17, 22.29]], 0);
    const result = parseDeclarativeResult(pointSetImageDeclaration, {
      nearest: selected,
      alternatives: [],
    });

    expect(result.selected.pointSet[0]?.image).toBe(
      "https://images.example.test/shelter-1.jpg",
    );
    expect(result.selected.pointSet[1]).not.toHaveProperty("image");
  });

  it("rejects an unsafe optional point-set image", () => {
    const selected = pointSetCandidate([[114.16, 22.28]], 0);
    selected.items[0]!.image = "http://images.example.test/shelter-1.jpg";
    expect(() => parseDeclarativeResult(pointSetImageDeclaration, {
      nearest: selected,
      alternatives: [],
    })).toThrow("expected an absolute HTTPS URL");
  });

  it("rejects a declaration combining point_set and segments", () => {
    const conflicting = create(DeclarativeResultSchemaSchema, {
      ...pointSetDeclaration,
      segments: {
        segmentsProperty: "segments",
        geometryProperty: "geometry",
        styleProperty: "style",
      },
    });
    expect(() => parseDeclarativeResult(conflicting, {
      nearest: pointSetCandidate([]),
      alternatives: [],
    })).toThrow("point_set and segments are mutually exclusive");
  });
});
