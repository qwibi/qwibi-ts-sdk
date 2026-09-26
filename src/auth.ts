// Anonymous sign-in: a stable device id plus, for a device the server has not
// seen before, a human-check token exchanged for a Session. This is the same
// request the Qwibi web app sends; the helpers here only shape it, validate the
// answer and name the refusals, so a client can tell a failed human check from
// a rate limit or an outage.
import { Code, ConnectError } from "@connectrpc/connect";
import type { Account } from "./gen/qwibi/v1/account_pb.js";
import type { AuthenticateResponse, Session } from "./gen/qwibi/v1/auth_pb.js";
import { errorDetailFrom } from "./errors.js";
import type { QwibiClient } from "./index.js";
import { retryAfterMsFrom } from "./retryAfter.js";

type CallOptions = Parameters<QwibiClient["authenticate"]>[1];

export interface AnonymousSignInInput {
  /**
   * Stable per-device identifier, 8 to 256 characters. Generate it once (a
   * random UUID is fine), persist it, and send the same value on every sign-in:
   * the server keys the anonymous account off it, so the same device resumes
   * the same account.
   */
  deviceId: string;
  /**
   * The token the Cloudflare Turnstile widget produced for this sign-in. It is
   * verified only when the device id is new and an account would be created;
   * a device that already has its account signs in without one, and a server
   * that runs no human check ignores it. Tokens are single-use: obtain a fresh
   * one for every attempt, including a retry.
   */
  humanCheckToken?: string;
}

export interface AnonymousSession {
  /** Opaque access and refresh tokens and their expiries. */
  session: Session;
  /** The account the session belongs to (created on the first sign-in). */
  account: Account;
}

/** Why an anonymous sign-in was refused. */
export type AnonymousSignInFailure =
  /** The token was missing, refused, expired or issued for another site. */
  | "human-check-failed"
  /** Too many new accounts from this address; wait `retryAfterMs` if set. */
  | "rate-limited"
  /** The human-check provider, the limiter or the network did not answer; retry with backoff. */
  | "unavailable"
  /** The request was malformed, for example a device id outside 8 to 256 characters. */
  | "invalid-request"
  /** Any other refusal; inspect `cause`. */
  | "refused";

/**
 * AnonymousSignInError is thrown by {@link signInAnonymously}. `cause` keeps
 * the original ConnectError, so its code and details stay reachable.
 */
export class AnonymousSignInError extends Error {
  readonly reason: AnonymousSignInFailure;
  /** Server hint for `rate-limited`: wait at least this long before retrying. */
  readonly retryAfterMs?: number;
  override readonly cause: ConnectError;

  constructor(reason: AnonymousSignInFailure, cause: ConnectError, retryAfterMs?: number) {
    super(`anonymous sign-in ${reason}: ${cause.rawMessage}`);
    this.name = "AnonymousSignInError";
    this.reason = reason;
    this.cause = cause;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/**
 * anonymousSignInErrorFrom classifies an error from an anonymous Authenticate
 * call. An error that already is an AnonymousSignInError is returned as is.
 */
export function anonymousSignInErrorFrom(err: unknown): AnonymousSignInError {
  if (err instanceof AnonymousSignInError) return err;
  const cause = ConnectError.from(err);
  switch (cause.code) {
    case Code.PermissionDenied:
      return new AnonymousSignInError("human-check-failed", cause);
    case Code.ResourceExhausted:
      return new AnonymousSignInError("rate-limited", cause, retryAfterMsFrom(errorDetailFrom(cause)));
    case Code.Unavailable:
    case Code.DeadlineExceeded:
      return new AnonymousSignInError("unavailable", cause);
    case Code.InvalidArgument:
      return new AnonymousSignInError("invalid-request", cause);
    default:
      return new AnonymousSignInError("refused", cause);
  }
}

/**
 * signInAnonymously exchanges a device id and a human-check token for a
 * Session. Keep the returned refresh token and rotate it with
 * {@link refreshSession}; hand the access token to createQwibiClient through
 * its `token` getter. Every refusal is thrown as an AnonymousSignInError.
 */
export async function signInAnonymously(
  client: Pick<QwibiClient, "authenticate">,
  input: AnonymousSignInInput,
  options?: CallOptions,
): Promise<AnonymousSession> {
  let response: AuthenticateResponse;
  try {
    response = await client.authenticate({
      credential: {
        method: {
          case: "anonymous",
          value: { deviceId: input.deviceId, humanCheckToken: input.humanCheckToken ?? "" },
        },
      },
    }, options);
  }
  catch (err) {
    throw anonymousSignInErrorFrom(err);
  }
  const { session, account } = response;
  if (!session?.accessToken || !session.refreshToken) {
    throw new AnonymousSignInError(
      "refused",
      new ConnectError("the server returned no session", Code.Internal),
    );
  }
  if (!account) {
    throw new AnonymousSignInError(
      "refused",
      new ConnectError("the server returned no account", Code.Internal),
    );
  }
  return { session, account };
}

/**
 * refreshSession rotates a refresh token into a fresh Session. The presented
 * token is single-use: persist the returned refresh token before using the new
 * access token, and never retry the same token after an ambiguous failure.
 * UNAUTHENTICATED means the session has ended; sign in again.
 */
export async function refreshSession(
  client: Pick<QwibiClient, "refreshToken">,
  refreshToken: string,
  options?: CallOptions,
): Promise<Session> {
  if (!refreshToken) throw new Error("refresh token is required");
  const { session } = await client.refreshToken({ refreshToken }, options);
  if (!session?.accessToken || !session.refreshToken) {
    throw new ConnectError("the server returned no session", Code.Internal);
  }
  return session;
}
