import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ConnectError, type Interceptor, type UnaryRequest } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  AppReleaseSchema,
  createQwibiClient,
  ReleaseAssetSchema,
} from "../src/index.js";

describe("exact App release client", () => {
  it("preserves exact identity, hashes, cursor, options and server errors", async () => {
    const appId = "019d0000-0000-7000-8000-000000000001";
    const releaseId = "019d0000-0000-7000-8000-000000000002";
    const canonicalHash = Uint8Array.from({ length: 32 }, () => 0xa1);
    const assetHash = Uint8Array.from({ length: 32 }, () => 0xb2);
    const release = create(AppReleaseSchema, {
      releaseId,
      appId,
      semanticVersion: "1.2.3",
      canonicalContentSha256: canonicalHash,
      assets: [create(ReleaseAssetSchema, {
        contentSha256: assetHash,
        mediaType: "image/png",
        sizeBytes: 42n,
        logicalName: "icon",
      })],
      primaryActionId: "primary-action",
      marks: [{ markId: "visited", objectType: "country", labelLocalizationKey: "mark.visited", showCount: true }],
    });
    const releaseBytes = toBinary(AppReleaseSchema, release);
    const readRelease = fromBinary(AppReleaseSchema, releaseBytes);
    const escapedRelease = {
      ...readRelease,
      commands: [{ name: "legacy-mutable-command" }],
    } as unknown as typeof release;
    const escapedAsset = {
      contentSha256: assetHash,
      appId,
      logicalName: "legacy-mutable-lookup",
    } as unknown as { contentSha256: Uint8Array };
    const cursor = "\u0000\u007fopaque\u00ff";
    const sentinel = new ConnectError("exact release sentinel");
    const captured: UnaryRequest[] = [];
    const interceptor: Interceptor = (_next) => async (request) => {
      captured.push(request);
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

    const calls = [
      client.uploadReleaseAsset({
        appId,
        asset: release.assets[0]!,
        content: Uint8Array.from([1, 2, 3, 4]),
      }, options),
      client.publishAppRelease(escapedRelease, options),
      client.getAppRelease({ releaseId }, options),
      client.getAppRelease({ appId, semanticVersion: "1.2.3" }, options),
      client.getAppRelease({ releaseId, consumerContractVersion: "0.2.0" }, options),
      client.listAppReleases({ appId, page: { limit: 17, cursor, order: 2 } }, options),
      client.getReleaseAsset(escapedAsset, options),
    ];
    for (const call of calls) {
      await expect(call).rejects.toBe(sentinel);
    }

    expect(captured.map((request) => request.method.localName)).toEqual([
      "uploadReleaseAsset",
      "publishAppRelease",
      "getAppRelease",
      "getAppRelease",
      "getAppRelease",
      "listAppReleases",
      "getReleaseAsset",
    ]);
    for (const request of captured) {
      expect(request.header.get("x-contract-probe")).toBe("preserved");
      expect(request.header.get("grpc-timeout")).toBe("4321m");
    }
    expect(controller.signal.aborted).toBe(false);

    expect(captured[0]!.message).toMatchObject({
      appId,
      asset: {
        contentSha256: assetHash,
        mediaType: "image/png",
        sizeBytes: 42n,
        logicalName: "icon",
      },
      content: Uint8Array.from([1, 2, 3, 4]),
    });

    const published = captured[1]!.message as { release?: typeof release };
    expect(published.release).toBeDefined();
    expect(published.release).not.toHaveProperty("commands");
    expect(toBinary(AppReleaseSchema, published.release!)).toEqual(releaseBytes);
    expect(published.release!.canonicalContentSha256).toEqual(canonicalHash);
    expect(published.release!.assets[0]!.contentSha256).toEqual(assetHash);

    expect(captured[2]!.message).toMatchObject({
      selector: { selector: { case: "releaseId", value: releaseId } },
    });
    expect(captured[3]!.message).toMatchObject({
      selector: {
        selector: {
          case: "appVersion",
          value: { appId, semanticVersion: "1.2.3" },
        },
      },
      consumerContractVersion: "",
    });
    expect(captured[4]!.message).toMatchObject({
      selector: { selector: { case: "releaseId", value: releaseId } },
      consumerContractVersion: "0.2.0",
    });
    expect(captured[5]!.message).toMatchObject({
      appId,
      page: { limit: 17, cursor, order: 2 },
    });
    expect(captured[5]!.message).not.toHaveProperty("latest");
    expect(captured[5]!.message).not.toHaveProperty("active");
    expect(captured[6]!.message).toMatchObject({ contentSha256: assetHash });
    expect(captured[6]!.message).not.toHaveProperty("appId");
    expect(captured[6]!.message).not.toHaveProperty("logicalName");
  });
});
