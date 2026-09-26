import { clone, create, fromJsonString, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  AppReleaseSchema,
  canonicalReleaseBytes,
  currentAppRelease,
  laterRelease,
  ListAppReleasesResponseSchema,
  releaseContentSha256,
  releaseIdFor,
  sealRelease,
  type AppRelease,
} from "../src/index.js";

// Shared, byte for byte, with the Go SDK test (app_loop_test.go). Its maps have
// integer-like, upper-case, empty and non-BMP keys and it carries negative
// zeros. The API server's canonical hash of it is FIXTURE_SHA256.
const FIXTURE = String.raw`{
  "releaseId": "0192f0c1-7b3a-7d4e-8a1b-2c3d4e5f6a7b",
  "appId": "5f0c2a8e-3b41-4c9d-9e7f-1a2b3c4d5e6f",
  "semanticVersion": "1.2.0",
  "publishedAt": "2026-09-26T10:00:00.123456Z",
  "contractRange": {"minimumInclusive": "0.3.0", "maximumExclusive": "2.0.0"},
  "actions": [{
    "actionId": "visit",
    "effectClass": 2,
    "inputSchema": {
      "type": "object",
      "properties": {
        "10": {"type": "string"},
        "2": {"type": "number", "minimum": -0.5},
        "b": {},
        "a": {"enum": [1, "x", true, null]}
      },
      "required": ["a"]
    },
    "titleLocalizationKey": "action.visit",
    "iconAssetSha256": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
  }],
  "uiContributions": [{
    "contributionId": "card",
    "kind": 1,
    "objectType": "country",
    "objectCollections": [{"collectionId": "near", "kind": 1, "objectType": "country", "radiusMetres": -0}]
  }],
  "localizations": [{
    "locale": "en",
    "entries": {"2": "two", "10": "ten", "a": "A", "Z": "z", "é": "e", "～": "tilde", "😀": "smile", "": "empty"}
  }],
  "safeFallbacks": {"unknownObject": 1, "unknownUi": 1, "unknownAction": 1},
  "publisherMetadata": {"publisherName": "Qwibi SDK fixture", "licenseName": "Apache-2.0"},
  "optionalExtensions": {"z": 1, "1": "one", "nested": {"k2": [1, 2.5, -0], "k1": false}},
  "primaryActionId": "visit",
  "marks": [{"markId": "visited", "objectType": "country", "labelLocalizationKey": "mark.visited", "markedStyle": "accent", "showCount": true}]
}`;
const FIXTURE_SHA256 = "6fd0e20ecb5150e80857a177411a86dafc96a2beabe208c0b7f96468e7385354";
const FIXTURE_ID = "52c6d16e-b3ad-571a-ab9b-6462968c0648";

const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
const fixture = () => fromJsonString(AppReleaseSchema, FIXTURE);
const sha256 = async (bytes: Uint8Array) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)));

describe("release content hash", () => {
  it("equals the server's canonical hash, which toBinary does not", async () => {
    const release = fixture();
    const before = toBinary(AppReleaseSchema, release);
    expect(hex(await releaseContentSha256(release))).toBe(FIXTURE_SHA256);
    expect(toBinary(AppReleaseSchema, release)).toEqual(before);
    const naive = clone(AppReleaseSchema, release);
    naive.releaseId = naive.appId = naive.semanticVersion = "";
    naive.canonicalContentSha256 = new Uint8Array(0);
    naive.publishedAt = undefined;
    expect(await sha256(toBinary(AppReleaseSchema, naive))).not.toBe(FIXTURE_SHA256);
  });

  it("ignores identity, the hash and the publication time and sees a declaration change", async () => {
    const release = fixture();
    release.releaseId = "";
    release.semanticVersion = "9.9.9";
    release.canonicalContentSha256 = new Uint8Array([1]);
    release.publishedAt = { $typeName: "google.protobuf.Timestamp", seconds: 1n, nanos: 0 };
    expect(hex(await releaseContentSha256(release))).toBe(FIXTURE_SHA256);
    release.marks[0]!.showCount = false;
    expect(hex(await releaseContentSha256(release))).not.toBe(FIXTURE_SHA256);
  });

  it("drops top-level unknown fields as the server does", async () => {
    const release = fixture();
    release.$unknown = [{ no: 99, wireType: 0, data: new Uint8Array([1]) }];
    expect(hex(await releaseContentSha256(release))).toBe(FIXTURE_SHA256);
    expect(canonicalReleaseBytes(release).length).toBeGreaterThan(0);
  });
});

describe("release id and sealing", () => {
  it("derives the same UUIDv5 as the Go SDK", async () => {
    const id = await releaseIdFor("5f0c2a8e-3b41-4c9d-9e7f-1a2b3c4d5e6f", "1.2.0");
    expect(id).toBe(FIXTURE_ID);
    expect(id[14]).toBe("5");
    expect(await releaseIdFor("5f0c2a8e-3b41-4c9d-9e7f-1a2b3c4d5e6f", "1.2.1")).not.toBe(id);
  });

  it("seals a copy with App id, derived release id and hash; sealing twice is identical", async () => {
    const release = fixture();
    const appId = release.appId;
    release.appId = release.releaseId = "";
    release.canonicalContentSha256 = new Uint8Array(0);
    const sealed = await sealRelease(appId, release);
    expect(release.releaseId).toBe("");
    expect(sealed.appId).toBe(appId);
    expect(sealed.releaseId).toBe(FIXTURE_ID);
    expect(hex(sealed.canonicalContentSha256)).toBe(FIXTURE_SHA256);
    expect(toBinary(AppReleaseSchema, await sealRelease(appId, release))).toEqual(toBinary(AppReleaseSchema, sealed));
  });

  it("refuses what the server would refuse", async () => {
    const appId = "5f0c2a8e-3b41-4c9d-9e7f-1a2b3c4d5e6f";
    const bad = (mutate: (r: AppRelease) => void) => {
      const r = fixture();
      mutate(r);
      return sealRelease(appId, r);
    };
    await expect(bad(r => { r.publishedAt = undefined; })).rejects.toThrow(/publishedAt/u);
    await expect(bad(r => { r.publishedAt!.nanos = 1; })).rejects.toThrow(/microsecond/u);
    await expect(bad(r => { r.semanticVersion = ""; })).rejects.toThrow(/semantic version/u);
    await expect(sealRelease(appId.toUpperCase(), fixture())).rejects.toThrow(/lower-case/u);
  });
});

describe("current release", () => {
  const at = (seconds: bigint, nanos = 0) => ({ $typeName: "google.protobuf.Timestamp" as const, seconds, nanos });
  const release = (releaseId: string, seconds: bigint, nanos = 0) => create(AppReleaseSchema, { releaseId, publishedAt: at(seconds, nanos) });

  it("is the latest publication across every page, ties broken by release id", async () => {
    const pages = [
      [release("b", 20n), release("a", 10n)],
      [release("c", 20n)],
      [release("d", 19n, 999_000)],
    ];
    const cursors: string[] = [];
    const client = {
      async listAppReleases(request: { appId: string; page?: { cursor: string } }) {
        cursors.push(request.page?.cursor ?? "");
        const i = cursors.length - 1;
        const nextCursor = i + 1 < pages.length ? `page-${i + 1}` : "";
        return create(ListAppReleasesResponseSchema, { releases: pages[i], page: { nextCursor, hasMore: nextCursor !== "" } });
      },
    };
    expect((await currentAppRelease(client, "app"))?.releaseId).toBe("c");
    expect(cursors).toEqual(["", "page-1", "page-2"]);
    const empty = { listAppReleases: async () => create(ListAppReleasesResponseSchema, {}) };
    expect(await currentAppRelease(empty, "app")).toBeUndefined();
    expect(laterRelease(release("x", 1n), undefined)).toBe(true);
    expect(laterRelease(undefined, release("x", 1n))).toBe(false);
  });
});
