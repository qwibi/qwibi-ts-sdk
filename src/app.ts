// The App side of Qwibi: App data, pictures, serving invocations with ready
// answers, blocking a caller or a Layer, and a person's marks. Each client is
// built from the same options as createQwibiClient, so an App needs one set
// of options and no second transport of its own.
import { create, type JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { AppDataService } from "./gen/qwibi/v1/app_data_pb.js";
import type { GeoObject } from "./gen/qwibi/v1/object_pb.js";
import {
  AppLayerKeySchema,
  InvocationStatus,
  RespondInvocationRequestSchema,
  type Invocation,
  type RespondInvocationRequest,
} from "./gen/qwibi/v1/invocation_pb.js";
import { MarkService } from "./gen/qwibi/v1/mark_pb.js";
import { AppInvocationService } from "./gen/qwibi/v1/service_pb.js";
import { createQwibiTransport, type QwibiClientOptions } from "./transport.js";

export type QwibiAppDataClient = Client<typeof AppDataService>;
export type QwibiInvocationClient = Client<typeof AppInvocationService>;
export type QwibiMarkClient = Client<typeof MarkService>;

/** The most objects one App data write carries. */
export const MAX_APP_OBJECTS_PER_CALL = 1000;
/** The largest picture Qwibi accepts. */
export const MAX_APP_PICTURE_BYTES = 4 << 20;
/** The longest FAILED answer message and block reason, in characters. */
export const MAX_ANSWER_MESSAGE_CHARACTERS = 280;

/**
 * The App's own data: put, replace, list, move and delete objects and upload
 * pictures. Authenticate with the App's publish key or App token.
 */
export function createQwibiAppDataClient(opts: QwibiClientOptions): QwibiAppDataClient {
  return createClient(AppDataService, createQwibiTransport(opts));
}

/**
 * The App's invocation connection: subscribe, answer, block and unblock. Use
 * {@link serveInvocations} for the subscription loop.
 */
export function createQwibiInvocationClient(opts: QwibiClientOptions): QwibiInvocationClient {
  return createClient(AppInvocationService, createQwibiTransport(opts));
}

/**
 * A signed-in person's marks on App data. An App token is refused; every call
 * needs a confirmed email.
 */
export function createQwibiMarkClient(opts: QwibiClientOptions): QwibiMarkClient {
  return createClient(MarkService, createQwibiTransport(opts));
}

/** listAllAppObjects follows the cursor to the last page and returns every object. */
export async function listAllAppObjects(
  client: Pick<QwibiAppDataClient, "listAppObjects">,
  appId: string,
): Promise<GeoObject[]> {
  const all: GeoObject[] = [];
  const seen = new Set<string>();
  let cursor = "";
  for (;;) {
    const response = await client.listAppObjects({ appId, page: { limit: MAX_APP_OBJECTS_PER_CALL, cursor } });
    all.push(...response.objects);
    const next = response.page?.nextCursor ?? "";
    if (!next) return all;
    if (seen.has(next)) throw new Error(`page cursor "${next}" repeated`);
    seen.add(next);
    cursor = next;
  }
}

/**
 * pictureContentType recognizes the picture types Qwibi accepts (PNG, JPEG,
 * GIF, WebP) from their first bytes, or returns undefined.
 */
export function pictureContentType(content: Uint8Array): string | undefined {
  const starts = (offset: number, ...bytes: number[]) =>
    content.length >= offset + bytes.length && bytes.every((b, i) => content[offset + i] === b);
  const ascii = (offset: number, text: string) => starts(offset, ...[...text].map(c => c.charCodeAt(0)));
  if (starts(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBPVP")) return "image/webp";
  return undefined;
}

/**
 * putAppPicture uploads picture bytes from the App process and returns the
 * picture reference to put in an object's picture property. Qwibi never
 * fetches a source; identical bytes give the same reference within the App.
 */
export async function putAppPicture(
  client: Pick<QwibiAppDataClient, "putAppPicture">,
  appId: string,
  content: Uint8Array,
): Promise<string> {
  if (content.length === 0 || content.length > MAX_APP_PICTURE_BYTES) {
    throw new Error("picture size must be between 1 byte and 4 MiB");
  }
  const contentType = pictureContentType(content);
  if (!contentType) throw new Error("unsupported picture type; use PNG, JPEG, GIF or WebP");
  const response = await client.putAppPicture({ appId, content, contentType });
  return response.pictureRef;
}

// --- answers ---------------------------------------------------------------

/** Answers an invocation with its result (omit it when the action declares none). */
export function succeeded(invocation: Pick<Invocation, "invocationId">, result?: JsonObject): RespondInvocationRequest {
  return create(RespondInvocationRequestSchema, {
    invocationId: invocation.invocationId,
    status: InvocationStatus.SUCCEEDED,
    result,
  });
}

/** A non-terminal answer before the terminal one; only an action that declares progress accepts it. */
export function progress(invocation: Pick<Invocation, "invocationId">, result?: JsonObject): RespondInvocationRequest {
  return create(RespondInvocationRequestSchema, {
    invocationId: invocation.invocationId,
    status: InvocationStatus.PROGRESS,
    result,
  });
}

/** Answers an invocation with a short person-facing text of at most 280 characters. */
export function failed(invocation: Pick<Invocation, "invocationId">, message = ""): RespondInvocationRequest {
  checkShortText("answer message", message, false);
  return create(RespondInvocationRequestSchema, {
    invocationId: invocation.invocationId,
    status: InvocationStatus.FAILED,
    message,
  });
}

/** Refuses an invocation as busy; the caller may try again later. */
export function busy(invocation: Pick<Invocation, "invocationId">): RespondInvocationRequest {
  return create(RespondInvocationRequestSchema, {
    invocationId: invocation.invocationId,
    status: InvocationStatus.BUSY,
  });
}

/**
 * validateAnswer throws unless the answer is one Qwibi accepts: an App status,
 * a message only with FAILED and a result only with SUCCEEDED or PROGRESS.
 */
export function validateAnswer(answer: RespondInvocationRequest): void {
  switch (answer.status) {
    case InvocationStatus.SUCCEEDED:
    case InvocationStatus.PROGRESS:
      if (answer.message) throw new Error(`a ${InvocationStatus[answer.status]} answer carries no message`);
      return;
    case InvocationStatus.FAILED:
      if (answer.result !== undefined) throw new Error("a FAILED answer carries no result");
      checkShortText("answer message", answer.message, false);
      return;
    case InvocationStatus.BUSY:
      if (answer.result !== undefined || answer.message) throw new Error("a BUSY answer carries no result and no message");
      return;
    default:
      throw new Error(`an App cannot answer with ${InvocationStatus[answer.status] ?? answer.status}`);
  }
}

/** Sends one answer outside the serve loop, after validating it. */
export async function respondInvocation(
  client: Pick<QwibiInvocationClient, "respondInvocation">,
  answer: RespondInvocationRequest,
): Promise<{ idempotentReplay: boolean }> {
  validateAnswer(answer);
  const response = await client.respondInvocation(answer);
  return { idempotentReplay: response.idempotentReplay };
}

// --- blocks ----------------------------------------------------------------

/**
 * blockLayer blocks the Layer an invocation came from, by the opaque Layer key
 * the invocation carried. The reason (1 to 280 characters) is quoted to the
 * Layer's owners and editors. Returns the block id for {@link unblockSource}.
 */
export async function blockLayer(
  client: Pick<QwibiInvocationClient, "blockSource">,
  layerKey: string,
  reason: string,
): Promise<string> {
  if (!layerKey) throw new Error("blockLayer needs the invocation's Layer key");
  checkShortText("block reason", reason, true);
  const response = await client.blockSource({
    source: { case: "layerId", value: create(AppLayerKeySchema, { value: layerKey }) },
    reason,
  });
  return response.blockId;
}

/** blockCaller blocks the person who made one invocation (resolvable for 30 days). */
export async function blockCaller(
  client: Pick<QwibiInvocationClient, "blockSource">,
  invocationId: string,
  reason: string,
): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(invocationId)) {
    throw new Error(`invocation id "${invocationId}" is not a lower-case UUID`);
  }
  checkShortText("block reason", reason, true);
  const response = await client.blockSource({ source: { case: "invocationId", value: invocationId }, reason });
  return response.blockId;
}

/** unblockSource lifts one block by the id blockLayer or blockCaller returned. */
export async function unblockSource(client: Pick<QwibiInvocationClient, "unblockSource">, blockId: string): Promise<void> {
  await client.unblockSource({ blockId });
}

// --- serving ---------------------------------------------------------------

/**
 * Answers one delivery. The platform may redeliver an invocation, so effects
 * must be idempotent on invocationId. The signal aborts at the invocation's
 * deadline or when serving stops.
 */
export type InvocationHandler = (
  invocation: Invocation,
  signal: AbortSignal,
) => RespondInvocationRequest | Promise<RespondInvocationRequest>;

export interface ServeInvocationsOptions {
  /** Stops serving; serveInvocations then resolves. */
  signal?: AbortSignal;
  /** Wait before reopening a connection that ended; default 1000 ms. */
  retryMs?: number;
}

const FINAL_CODES = new Set([
  Code.Unauthenticated, Code.PermissionDenied, Code.FailedPrecondition,
  Code.NotFound, Code.InvalidArgument, Code.Unavailable,
]);

/**
 * serveInvocations holds the App's one connection and answers every delivery
 * before taking the next; an unanswered call stays eligible for redelivery. A
 * connection that ends is reopened after `retryMs`. It resolves when the signal
 * aborts and rejects when Qwibi refuses the connection (sign in again), when
 * the handler throws or returns an answer for another call or an invalid one.
 */
export async function serveInvocations(
  client: Pick<QwibiInvocationClient, "subscribeInvocations" | "respondInvocation">,
  handler: InvocationHandler,
  options: ServeInvocationsOptions = {},
): Promise<void> {
  const { signal, retryMs = 1000 } = options;
  while (!signal?.aborted) {
    try {
      for await (const delivery of client.subscribeInvocations({}, { signal })) {
        if (delivery.payload.case !== "invocation") {
          throw new Error("App connection received an unknown delivery");
        }
        await answerOne(client, handler, delivery.payload.value, signal);
      }
    } catch (error) {
      if (signal?.aborted) return;
      if (!(error instanceof ConnectError)) throw error;
      if (FINAL_CODES.has(error.code)) throw error;
    }
    if (signal?.aborted) return;
    await sleep(retryMs, signal);
  }
}

async function answerOne(
  client: Pick<QwibiInvocationClient, "respondInvocation">,
  handler: InvocationHandler,
  invocation: Invocation,
  outer: AbortSignal | undefined,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (invocation.deadline) {
    const ms = Number(invocation.deadline.seconds) * 1000 + invocation.deadline.nanos / 1e6 - Date.now();
    timer = setTimeout(() => controller.abort(new Error("invocation deadline passed")), Math.max(0, ms));
  }
  let answer: RespondInvocationRequest;
  try {
    answer = await handler(invocation, controller.signal);
  } catch (error) {
    throw new Error(`handle invocation ${invocation.invocationId}`, { cause: error });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outer?.removeEventListener("abort", abort);
  }
  if (!answer || answer.invocationId !== invocation.invocationId) {
    throw new Error(`handler returned a mismatched answer for ${invocation.invocationId}`);
  }
  validateAnswer(answer);
  try {
    await client.respondInvocation(answer);
  } catch (error) {
    // The call has already ended or expired; the answer no longer matters.
    if (error instanceof ConnectError && (error.code === Code.DeadlineExceeded || error.code === Code.NotFound)) return;
    throw error;
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function checkShortText(what: string, text: string, required: boolean): void {
  const length = [...text].length;
  if (required && length === 0) throw new Error(`${what} is required`);
  if (length > MAX_ANSWER_MESSAGE_CHARACTERS) {
    throw new Error(`${what} is ${length} characters; at most ${MAX_ANSWER_MESSAGE_CHARACTERS}`);
  }
}
