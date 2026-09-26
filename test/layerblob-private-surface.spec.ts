import { create } from "@bufbuild/protobuf";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  IssueLayerBlobReadResponseSchema,
  ReserveLayerBlobUploadResponseSchema,
  type IssueLayerBlobReadResponse,
  type ReserveLayerBlobUploadResponse,
} from "../src/index.js";

type ForbiddenURLField =
  | "uploadUrl"
  | "publicUrl"
  | "providerUrl"
  | "signedUrl";

describe("private LayerBlob public surface", () => {
  it("represents upload and read capabilities only as Qwibi-relative paths", () => {
    const upload = create(ReserveLayerBlobUploadResponseSchema, {
      uploadPath: "/v1/layer-blob-capabilities/upload-token",
    });
    const read = create(IssueLayerBlobReadResponseSchema, {
      readPath: "/v1/layer-blob-capabilities/read-token",
    });

    expect(upload.uploadPath).toMatch(/^\/v1\/layer-blob-capabilities\//);
    expect(read.readPath).toMatch(/^\/v1\/layer-blob-capabilities\//);
    for (const field of ["uploadUrl", "publicUrl", "providerUrl", "signedUrl"] as const) {
      expect(field in upload).toBe(false);
      expect(field in read).toBe(false);
    }
  });

  it("does not generate a raw URL field in either response type", () => {
    expectTypeOf<Extract<keyof ReserveLayerBlobUploadResponse, ForbiddenURLField>>()
      .toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof IssueLayerBlobReadResponse, ForbiddenURLField>>()
      .toEqualTypeOf<never>();
  });
});
