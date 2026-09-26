// The fields QTProtocol depends on (seq, cursor,
// per-object version) must survive a wire round-trip through the GENERATED
// encode/decode, for the three event shapes a client's reducer folds: the
// snapshot baseline, a created delta, and a deleted delta. A regeneration that
// renumbers, retypes, or drops one of these fields fails here before it ships.
import { describe, it, expect, expectTypeOf } from "vitest";
import { create, equals, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ConnectError, type Interceptor, type UnaryRequest } from "@connectrpc/connect";
import * as sdk from "../src/index.js";
import {
  createQwibiClient,
  ErrorCode,
  CreateLayerRequestSchema,
  GetLayerRequestSchema,
  JoinPolicy,
  LayerListingIntent,
  ListDiscoverableLayersRequestSchema,
  ListDiscoverableLayersResponseSchema,
  ListMyLayersRequestSchema,
  ListMyLayersResponseSchema,
  TransferLayerOwnershipRequestSchema,
  GeoObjectSchema,
  OauthProvider,
  QwibiService,
  ServerEventSchema,
  point,
  RetireAppRequestSchema,
  type QwibiClient,
  type ServerEvent,
} from "../src/index.js";

// Compile-time exhaustiveness: adding a ServerEvent oneof member makes the default
// assignment fail until the client-conformance surface deliberately handles it.
function assertKnownServerEventPayload(ev: ServerEvent): void {
  switch (ev.payload.case) {
    case undefined:
    case "snapshot":
    case "objectCreated":
    case "objectUpdated":
    case "objectMoved":
    case "objectDeleted":
    case "layerUpdated":
    case "presence":
    case "heartbeat":
    case "error":
    case "viewerCount":
    case "clusterSnapshot":
    case "aggregateUpdated":
    case "layerDeleted":
    case "stateEvent":
    case "stateClear":
    case "layerArchived":
    case "layerUnarchived":
      return;
    default: {
      const unknownPayload: never = ev.payload;
      return unknownPayload;
    }
  }
}

// Encode → decode through the generated binary codec, as the gateway/server and
// the browser client do on the wire.
function roundTrip(ev: ServerEvent): ServerEvent {
  return fromBinary(ServerEventSchema, toBinary(ServerEventSchema, ev));
}

function geoObject(uid: string, version: bigint) {
  return create(GeoObjectSchema, {
    uid,
    layerId: "layer-1",
    name: `object ${uid}`,
    objectType: "station",
    geometry: point(114.16, 22.28),
    version,
  });
}

describe("qwibi.v1 ServerEvent round-trip", () => {
  it("TransferLayerOwnership preserves only the Layer and target Account UUIDs", () => {
    const request = create(TransferLayerOwnershipRequestSchema, {
      layerId: "019d0000-0000-7000-8000-000000000003",
      newOwnerAccountId: "019d0000-0000-7000-8000-000000000004",
    });
    const decoded = fromBinary(
      TransferLayerOwnershipRequestSchema,
      toBinary(TransferLayerOwnershipRequestSchema, request),
    );

    expect(decoded).toEqual(request);
  });

  it("RetireApp distinguishes an absent revision expectation from explicit zero", () => {
    const appId = "019d0000-0000-7000-8000-000000000003";
    const absent = create(RetireAppRequestSchema, { appId });
    const exactZero = create(RetireAppRequestSchema, {
      appId,
      expectedLifecycleRevision: 0n,
    });

    expect(absent.expectedLifecycleRevision).toBeUndefined();
    expect(exactZero.expectedLifecycleRevision).toBe(0n);
    expect(toBinary(RetireAppRequestSchema, absent))
      .not.toEqual(toBinary(RetireAppRequestSchema, exactZero));
  });

  it("manual client exposes only Layer-first Layer methods and arguments", () => {
    const client = createQwibiClient({ baseUrl: "http://127.0.0.1:7903" });
    expect(client).toHaveProperty("createLayer");
    expect(client).toHaveProperty("getLayer");
    expect(client).toHaveProperty("resolveLayerHumanID");
    expect(client).toHaveProperty("listDiscoverableLayers");
    expect(client).toHaveProperty("listMyLayers");
    expect(client).not.toHaveProperty("listLayers");
    expect(client).not.toHaveProperty("listJoinedLayers");

    expectTypeOf<QwibiClient>().not.toHaveProperty("listLayers");
    expectTypeOf<QwibiClient>().not.toHaveProperty("listJoinedLayers");
    expectTypeOf<Parameters<QwibiClient["createLayer"]>[0]>().toHaveProperty("organizationId").toEqualTypeOf<string>();
    expectTypeOf<Parameters<QwibiClient["createLayer"]>[0]>().not.toHaveProperty("appId");
    expectTypeOf<Parameters<QwibiClient["getLayer"]>[0]>().toEqualTypeOf<{ layerId: string }>();
  });

  it("rebuilds Layer requests from allowed fields and preserves call semantics", async () => {
    const sentinel = new ConnectError("transport sentinel");
    const captured: UnaryRequest[] = [];
    const interceptor: Interceptor = (_next) => async (request) => {
      if (!request.stream) captured.push(request);
      throw sentinel;
    };
    const client = createQwibiClient({
      baseUrl: "http://127.0.0.1:7903",
      interceptors: [interceptor],
    });
    const controller = new AbortController();
    const options = {
      headers: new Headers([["x-contract-probe", "preserved"]]),
      signal: controller.signal,
      timeoutMs: 4321,
    };
    const acceptedCreate = create(CreateLayerRequestSchema, {
      organizationId: "organization-1",
      hid: "layer-hid",
      name: "Layer",
      description: "description",
      public: true,
      properties: { byteMeaning: "unchanged" },
      style: "{\"color\":\"#123456\"}",
      zIndex: 7,
      opacity: 0.75,
      join: JoinPolicy.OPEN,
      listingIntent: LayerListingIntent.LISTED,
    });
    const escapedCreate = {
      ...acceptedCreate,
      appId: "app-probe",
      onBehalfOfAccountId: "account-probe",
      $typeName: "runtime.escape.CreateLayerRequest",
    } as unknown as Parameters<QwibiClient["createLayer"]>[0];

    let createError: unknown;
    try {
      await client.createLayer(escapedCreate, options);
    }
    catch (error) {
      createError = error;
    }
    expect(createError).toBe(sentinel);

    const escapedGet = {
      layerId: "layer-1",
      appId: "app-probe",
      hid: "legacy-hid",
      $typeName: "runtime.escape.GetLayerRequest",
    } as unknown as Parameters<QwibiClient["getLayer"]>[0];
    let getError: unknown;
    try {
      await client.getLayer(escapedGet, options);
    }
    catch (error) {
      getError = error;
    }
    expect(getError).toBe(sentinel);

    expect(captured.map((request) => request.method.localName)).toEqual([
      "createLayer",
      "getLayer",
    ]);
    const actualCreate = captured[0]!.message as typeof acceptedCreate;
    expect(toBinary(CreateLayerRequestSchema, actualCreate)).toEqual(
      toBinary(CreateLayerRequestSchema, acceptedCreate),
    );
    expect(actualCreate).not.toHaveProperty("appId");
    expect(actualCreate.onBehalfOfAccountId).toBe("");
    expect(actualCreate.$typeName).toBe(acceptedCreate.$typeName);

    const acceptedGet = create(GetLayerRequestSchema, { layerId: "layer-1" });
    const actualGet = captured[1]!.message as typeof acceptedGet;
    expect(toBinary(GetLayerRequestSchema, actualGet)).toEqual(
      toBinary(GetLayerRequestSchema, acceptedGet),
    );
    expect(actualGet).not.toHaveProperty("appId");
    expect(actualGet.hid).toBe("");
    expect(actualGet.$typeName).toBe(acceptedGet.$typeName);
    for (const request of captured) {
      expect(request.header.get("x-contract-probe")).toBe("preserved");
      expect(request.header.get("grpc-timeout")).toBe("4321m");
    }
  });

  it("Layer-first list cursors remain opaque bytes through generated codecs", () => {
    const discoverCursor = Uint8Array.from([0x00, 0xff, 0x7f, 0x01]);
    const discoverRequest = create(ListDiscoverableLayersRequestSchema, {
      limit: 7,
      cursor: discoverCursor,
    });
    const decodedDiscoverRequest = fromBinary(
      ListDiscoverableLayersRequestSchema,
      toBinary(ListDiscoverableLayersRequestSchema, discoverRequest),
    );
    expect(decodedDiscoverRequest.cursor).toEqual(discoverCursor);

    const discoverResponse = create(ListDiscoverableLayersResponseSchema, {
      nextCursor: Uint8Array.from([0xfe, 0x01, 0x00]),
    });
    expect(fromBinary(
      ListDiscoverableLayersResponseSchema,
      toBinary(ListDiscoverableLayersResponseSchema, discoverResponse),
    ).nextCursor).toEqual(discoverResponse.nextCursor);

    const myCursor = Uint8Array.from([0x10, 0x00, 0x80, 0xfe]);
    const myRequest = create(ListMyLayersRequestSchema, {
      includeOwned: true,
      includeJoined: true,
      includeArchived: true,
      limit: 9,
      cursor: myCursor,
    });
    const decodedMyRequest = fromBinary(
      ListMyLayersRequestSchema,
      toBinary(ListMyLayersRequestSchema, myRequest),
    );
    expect(decodedMyRequest.cursor).toEqual(myCursor);

    const myResponse = create(ListMyLayersResponseSchema, {
      nextCursor: Uint8Array.from([0xab, 0xcd, 0x00]),
    });
    expect(fromBinary(
      ListMyLayersResponseSchema,
      toBinary(ListMyLayersResponseSchema, myResponse),
    ).nextCursor).toEqual(myResponse.nextCursor);
  });

  it("does not export the removed App usage projection", () => {
    const removedMessage = ["Get", "App", "Usage"].join("");
    const removedMethod = `${removedMessage[0]!.toLowerCase()}${removedMessage.slice(1)}`;
    expect(QwibiService.methods.map((method) => method.localName)).not.toContain(removedMethod);
    expect(sdk).not.toHaveProperty(`${removedMessage}RequestSchema`);
    expect(sdk).not.toHaveProperty(`${removedMessage}ResponseSchema`);
  });

  it("pins the additive auth provider and error-code values", () => {
    expect(OauthProvider.GOOGLE).toBe(1);
    expect(ErrorCode.TOKEN_REUSED).toBe(1005);
    expect(ErrorCode.QUOTA_EXCEEDED).toBe(3003);
  });

  it("client conformance switch recognizes every generated ServerEvent payload", () => {
    expect(() => assertKnownServerEventPayload(create(ServerEventSchema))).not.toThrow();
  });

  it("snapshot preserves seq, cursor, snapshot_seq and every object's version", () => {
    const ev = create(ServerEventSchema, {
      seq: 42n,
      cursor: "cursor-42",
      payload: {
        case: "snapshot",
        value: {
          layerId: "layer-1",
          snapshotSeq: 41n,
          nextCursor: "page-2",
          objects: [geoObject("o1", 7n), geoObject("o2", 9n)],
        },
      },
    });

    const got = roundTrip(ev);
    expect(got.seq).toBe(42n);
    expect(got.cursor).toBe("cursor-42");
    expect(got.payload.case).toBe("snapshot");
    if (got.payload.case !== "snapshot") return;
    expect(got.payload.value.layerId).toBe("layer-1");
    expect(got.payload.value.snapshotSeq).toBe(41n);
    expect(got.payload.value.nextCursor).toBe("page-2");
    expect(got.payload.value.objects.map((o) => [o.uid, o.version])).toEqual([
      ["o1", 7n],
      ["o2", 9n],
    ]);
    // The whole message survives untouched, not just the asserted fields.
    expect(equals(ServerEventSchema, got, ev)).toBe(true);
  });

  it("objectCreated preserves seq, cursor and the object (uid, version, geometry)", () => {
    const ev = create(ServerEventSchema, {
      seq: 43n,
      cursor: "cursor-43",
      payload: {
        case: "objectCreated",
        value: { layerId: "layer-1", object: geoObject("o3", 43n) },
      },
    });

    const got = roundTrip(ev);
    expect(got.seq).toBe(43n);
    expect(got.cursor).toBe("cursor-43");
    expect(got.payload.case).toBe("objectCreated");
    if (got.payload.case !== "objectCreated") return;
    const o = got.payload.value.object;
    expect(o?.uid).toBe("o3");
    expect(o?.version).toBe(43n); // per-object dedup key across snapshot/live seam
    expect(o?.geometry?.geometry.case).toBe("point");
    if (o?.geometry?.geometry.case !== "point") return;
    expect(o.geometry.geometry.value.coordinates?.lon).toBeCloseTo(114.16);
    expect(o.geometry.geometry.value.coordinates?.lat).toBeCloseTo(22.28);
    expect(equals(ServerEventSchema, got, ev)).toBe(true);
  });

  it("objectDeleted preserves seq, cursor, object_id and version", () => {
    const ev = create(ServerEventSchema, {
      seq: 44n,
      cursor: "cursor-44",
      payload: {
        case: "objectDeleted",
        value: { layerId: "layer-1", objectId: "o3", version: 44n },
      },
    });

    const got = roundTrip(ev);
    expect(got.seq).toBe(44n);
    expect(got.cursor).toBe("cursor-44");
    expect(got.payload.case).toBe("objectDeleted");
    if (got.payload.case !== "objectDeleted") return;
    expect(got.payload.value.objectId).toBe("o3");
    expect(got.payload.value.version).toBe(44n);
    expect(equals(ServerEventSchema, got, ev)).toBe(true);
  });

  it("defaults are wire-stable: an event without cursor/payload decodes to the same defaults", () => {
    const got = roundTrip(create(ServerEventSchema, { seq: 1n }));
    expect(got.seq).toBe(1n);
    expect(got.cursor).toBe("");
    expect(got.payload.case).toBeUndefined();
  });
});
