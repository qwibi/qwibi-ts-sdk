import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  ErrorDetailSchema,
  FieldViolationSchema,
  errorDetailFrom,
} from "../src/index.js";

describe("errorDetailFrom", () => {
  it("decodes a serialized ErrorDetail", () => {
    const detail = create(ErrorDetailSchema, {
      code: ErrorCode.INVALID_ARGUMENT,
      message: "invalid object",
      traceId: "trace-1",
      violations: [create(FieldViolationSchema, { field: "object.hid", description: "required" })],
    });
    const err = new ConnectError("invalid object", Code.InvalidArgument);
    err.details = [
      {
        type: "qwibi.v1.ErrorDetail",
        value: toBinary(ErrorDetailSchema, detail),
      },
    ];

    expect(errorDetailFrom(err)).toEqual(detail);
  });

  it("returns undefined for a bare status", () => {
    expect(errorDetailFrom(new ConnectError("missing", Code.NotFound))).toBeUndefined();
  });
});
