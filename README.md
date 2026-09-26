# @qwibi/sdk

TypeScript/browser client for the `qwibi.v1` contract — the web mirror of
`qwibi-go-sdk`. Types and the service descriptor are generated from the proto
with protobuf-es v2; clients are built with Connect-Web.

```ts
import { createQwibiClient, signInAnonymously } from "@qwibi/sdk";

const baseUrl = "http://localhost:7903";
let accessToken: string | undefined;
const qwibi = createQwibiClient({ baseUrl, token: () => accessToken });
const { session, account } = await signInAnonymously(qwibi, { deviceId: "web-demo-0001" });
accessToken = session.accessToken;
```

The gateway exposes the browser **gRPC-Web edge** on `:7903`; api-server `:7901` is
health/metrics HTTP only. Unary RPCs and server-streaming (`StreamLayer` — the live-layer
subscription) are supported; only bidirectional `Subscribe` is unavailable over gRPC-Web.

## Anonymous sign-in

`signInAnonymously(client, { deviceId, humanCheckToken })` sends the same request the Qwibi
web app sends and returns `{ session, account }`.

- **Device id.** Generate it once (a random UUID is fine), persist it and reuse it: the same
  device id resumes the same anonymous account. 8 to 256 characters.
- **Human-check token.** Needed only when the device id is new to a server that runs the human
  check. It comes from the invisible Cloudflare Turnstile widget rendered with that server's
  public site key (`action: "anonymous-sign-in"`, executed once per sign-in). The server accepts
  it only if Cloudflare issued it on one of the site hostnames it is configured for, so it
  works from pages served there. Tokens are single-use: get a fresh one for every attempt. A
  server without the human check (local development) ignores it.
- **Session.** Hand the access token to `createQwibiClient` through the `token` getter. Keep the
  refresh token and rotate it with `refreshSession(client, refreshToken)`; persist the new refresh
  token before using the new access token, because the old one is spent.
- **Refusals** are thrown as `AnonymousSignInError` with `reason`:
  `"human-check-failed"` (token missing, refused or for another site), `"rate-limited"` (too many
  new accounts from this address; `retryAfterMs` carries the server's hint), `"unavailable"`
  (provider, limiter or network; retry with backoff and a fresh token), `"invalid-request"`, or
  `"refused"`. `cause` is the original `ConnectError`.

```ts
try {
  await signInAnonymously(qwibi, { deviceId, humanCheckToken });
} catch (err) {
  if (err instanceof AnonymousSignInError && err.reason === "rate-limited") {
    // wait err.retryAfterMs, then try again with a new token
  }
}
```

**Programs without a browser** cannot produce a token and should not create anonymous accounts:
those are for people on their own devices. An App authenticates with its publish key or App token
(see below), automation with an organization access key, and a script acting for a person with
that person's account (password or email link). There is no client-side way around the check.

## Installations and releases

An App's process never lists, follows or acknowledges installations. Publishing a release makes it
current in every installation at once; there is no pending release, readiness report or promotion,
and only the features that need a newly added sensitive right wait for each person's consent.
`createQwibiInstallationClient` serves the people who add Apps to Layers and remove them.

The generated client exposes one-call installation and a person's per-right consent operation.

## A whole App

One set of client options serves every part of an App; the helpers copy no server code and open
no transport of their own.

```ts
import {
  createQwibiAppDataClient, createQwibiClient, createQwibiInvocationClient,
  currentAppRelease, failed, putAppPicture, sealRelease, serveInvocations, succeeded,
} from "@qwibi/sdk";

const opts = { baseUrl, token: publishKey };
const release = await sealRelease(appId, draft);          // release id + canonical hash
await createQwibiClient(opts).publishAppRelease(release);  // a repeat of the same version replays
const current = await currentAppRelease(createQwibiClient(opts), appId);

const data = createQwibiAppDataClient(opts);
const picture = await putAppPicture(data, appId, pngBytes);
await data.replaceAppObjects({ appId, objects });          // the whole data set, matched by hid

await serveInvocations(createQwibiInvocationClient(opts), (call) =>
  call.actionId === "visit" ? succeeded(call, { ok: true }) : failed(call, "Unknown action"),
  { signal });
```

- `sealRelease`, `releaseContentSha256`, `releaseIdFor` — the canonical content hash is the
  server's (Go deterministic encoding: fields by number, map keys in byte order); `toBinary` is
  not canonical. `releaseIdFor` is the UUIDv5 of `<appId>/<version>`, the same id the Go SDK
  derives, so republishing a version is a replay. `publishedAt` must be set and advance.
- `currentAppRelease` — the latest publication by `publishedAt`, then release id, over every page.
- `createQwibiAppDataClient`, `listAllAppObjects`, `putAppPicture` — the App's own data and
  pictures (PNG, JPEG, GIF, WebP up to 4 MiB).
- `serveInvocations` answers each delivery before the next, reopens an ended connection and
  rejects when Qwibi refuses it; `succeeded`, `progress`, `failed`, `busy` and `validateAnswer`
  refuse an answer Qwibi would refuse before it is sent. `blockLayer`, `blockCaller` and
  `unblockSource` block by the opaque Layer key or the call id.
- `createQwibiMarkClient` — a signed-in person's `setMark`, `listMyMarks` and `importMyMarks`.

## L1 object helpers

The SDK constructs ordinary generated `ObjectWrite` messages for the five L1
application helpers. They use validated geometry, set the helper's `object_type`,
and serialize only a style supplied by the caller.

```ts
import { marker } from "@qwibi/sdk";

const object = marker(114.16, 22.28, { hid: "pier-marker", name: "Pier" });
await qwibi.postObject({ layerId, object });
```

`marker`, `message`, `track`, `zone`, and `route` add no client abstraction and
no wire surface. `qstyle` accepts only the style-v0 keys and rejects invalid
numbers/schema tags before a request is sent. Applications remain free to use
any other `object_type` directly on an `ObjectWrite`.

## Client conformance

Any consumer of the live stream (`StreamLayer`) must follow these client-conformance rules:

1. **`SLOW_CONSUMER` ⇒ drop the cursor, re-open.** The server dropped deltas under
   backpressure — the view is stale. Discard the resume cursor and re-open the
   subscription **without** one, so a fresh Snapshot rebuilds the state.
2. **Per-object version gating.** Track the last applied `version` per object id
   (snapshot objects included) and drop any object event whose `version` is ≤ it.
   `version` is the per-OBJECT mutation counter (independent of the per-layer
   delivery `seq`); a delete carries the object's next version, so its tombstone
   supersedes any late delta for that object.
3. **`RESUME_TOKEN_EXPIRED` ⇒ same as rule 1.**
4. **`LayerDeleted` ⇒ drop the layer's state**; never auto-resubscribe with a cursor.

The SDK ships the managed `LiveLayer` wrapper for cursor resume, reconnect/backoff,
reset handling and per-object replay de-duplication:

```ts
import { LiveLayer, createStreamSource } from "@qwibi/sdk";

const live = new LiveLayer(createStreamSource(qwibi), {
  layerIds: [layerId],
  viewport,
});
live.on("snapshot", applySnapshot);
live.on("updated", applyObject);
live.on("deleted", applyDelete);
live.start();
```

`isSlowConsumer` and `shouldResetCursor` remain exported for lower-level callers that intentionally
manage the raw stream themselves.

State-enabled streams add the QTP §6.3 rules. Request
`stateKinds: ["position"]`, feed snapshots and state/delete events through one
bounded `StateGate`, and render only callbacks that pass its lexicographic pair
and ledger-tombstone checks. `hydrateStateObject` converts a targeted
`GetObject` NotFound into a remembered drop. For publishing, keep one
`PositionWriterSession` per logical tab/device writer and reuse the prepared
frame on transport retry; it supplies the stable `writer_id` and per-key
`client_seq` required by `PublishBatch`.

```ts
const gate = new StateGate();
gate.applyServerEvent(event, {
  onStateEvent: applyPosition,
  onStateClear: clearPosition,
  onObjectDeleted: removeObject,
});

const writer = new PositionWriterSession();
const frame = writer.prepareFrame(layerId, [{ key: objectId, position }]);
await writer.publishPrepared(createStreamIngressClient({ baseUrl, token }), frame);
```

## Develop

```sh
npm install
npm run build        # tsc -> dist
npm test
```

`src/gen` is generated from the `qwibi.v1` protobuf contract and committed with the package.
