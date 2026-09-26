import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  AccountSchema,
  AnonymousSignInError,
  ErrorCode,
  ErrorDetailSchema,
  QwibiService,
  SessionSchema,
  anonymousSignInErrorFrom,
  refreshSession,
  signInAnonymously,
  type AuthenticateRequest,
  type RefreshTokenRequest,
} from "../src/index.js";

const session = create(SessionSchema, {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  tokenType: "Bearer",
});
const account = create(AccountSchema, { uid: "account-1" });

// A QwibiService over an in-memory Connect transport: requests and errors go
// through real serialization, so the test sees what the server would see.
function clientAnswering(authenticate: (req: AuthenticateRequest) => unknown, refresh?: (req: RefreshTokenRequest) => unknown) {
  const transport = createRouterTransport(({ service }) => {
    service(QwibiService, {
      authenticate: authenticate as never,
      refreshToken: (refresh ?? (() => ({ session }))) as never,
    });
  });
  return createClient(QwibiService, transport);
}

function rateLimited(message: string) {
  return new ConnectError(
    "too many anonymous accounts were created from this address; try again later",
    Code.ResourceExhausted,
    undefined,
    [{ desc: ErrorDetailSchema, value: { code: ErrorCode.RESOURCE_EXHAUSTED, message } }],
  );
}

describe("signInAnonymously", () => {
  it("sends the device id and the human-check token as the anonymous credential", async () => {
    let seen: AuthenticateRequest | undefined;
    const client = clientAnswering((req) => {
      seen = req;
      return { session, account };
    });

    const result = await signInAnonymously(client, {
      deviceId: "device-0001",
      humanCheckToken: "turnstile-token",
    });

    expect(seen?.credential?.method.case).toBe("anonymous");
    expect(seen?.credential?.method.value).toMatchObject({
      deviceId: "device-0001",
      humanCheckToken: "turnstile-token",
    });
    expect(result.session.accessToken).toBe("access-1");
    expect(result.session.refreshToken).toBe("refresh-1");
    expect(result.account.uid).toBe("account-1");
  });

  it("sends an empty token when none is given, so a known device resumes", async () => {
    let token: string | undefined;
    const client = clientAnswering((req) => {
      token = req.credential?.method.case === "anonymous" ? req.credential.method.value.humanCheckToken : undefined;
      return { session, account };
    });
    await signInAnonymously(client, { deviceId: "device-0001" });
    expect(token).toBe("");
  });

  it("maps a refused human check to human-check-failed", async () => {
    const client = clientAnswering(() => {
      throw new ConnectError("the human check did not pass", Code.PermissionDenied);
    });
    const err = await signInAnonymously(client, { deviceId: "device-0001", humanCheckToken: "bad" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnonymousSignInError);
    expect((err as AnonymousSignInError).reason).toBe("human-check-failed");
    expect((err as AnonymousSignInError).cause.code).toBe(Code.PermissionDenied);
  });

  it("maps the sign-up limit to rate-limited with the server's retry_after_seconds", async () => {
    const client = clientAnswering(() => {
      throw rateLimited("retry_after_seconds=3600");
    });
    const err = await signInAnonymously(client, { deviceId: "device-0001", humanCheckToken: "t" })
      .catch((e: unknown) => e as AnonymousSignInError);
    expect(err.reason).toBe("rate-limited");
    expect(err.retryAfterMs).toBe(3_600_000);
  });

  it("leaves retryAfterMs unset when the limit carries no hint", async () => {
    const err = anonymousSignInErrorFrom(new ConnectError("slow down", Code.ResourceExhausted));
    expect(err.reason).toBe("rate-limited");
    expect(err.retryAfterMs).toBeUndefined();
  });

  it.each([
    [Code.Unavailable, "unavailable"],
    [Code.DeadlineExceeded, "unavailable"],
    [Code.InvalidArgument, "invalid-request"],
    [Code.Internal, "refused"],
    [Code.Unauthenticated, "refused"],
  ] as const)("maps %s to %s", async (code, reason) => {
    const client = clientAnswering(() => {
      throw new ConnectError("no", code);
    });
    const err = await signInAnonymously(client, { deviceId: "device-0001" })
      .catch((e: unknown) => e as AnonymousSignInError);
    expect(err.reason).toBe(reason);
  });

  it("refuses an OK answer that carries no session", async () => {
    const client = clientAnswering(() => ({ account }));
    const err = await signInAnonymously(client, { deviceId: "device-0001" })
      .catch((e: unknown) => e as AnonymousSignInError);
    expect(err).toBeInstanceOf(AnonymousSignInError);
    expect(err.reason).toBe("refused");
  });
});

describe("refreshSession", () => {
  it("rotates the refresh token into the new session", async () => {
    let presented = "";
    const rotated = create(SessionSchema, { accessToken: "access-2", refreshToken: "refresh-2" });
    const client = clientAnswering(() => ({ session, account }), (req) => {
      presented = req.refreshToken;
      return { session: rotated };
    });
    const next = await refreshSession(client, "refresh-1");
    expect(presented).toBe("refresh-1");
    expect(next.refreshToken).toBe("refresh-2");
  });

  it("rejects an empty refresh token before any call", async () => {
    const client = clientAnswering(() => ({ session, account }), () => {
      throw new Error("must not be called");
    });
    await expect(refreshSession(client, "")).rejects.toThrow("refresh token is required");
  });
});
