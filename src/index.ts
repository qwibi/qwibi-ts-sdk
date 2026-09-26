// Public surface of the Qwibi TypeScript SDK. The generated message/service
// types are re-exported so consumers import everything from "@qwibi/sdk".
// Regenerate the gen/ tree with `pnpm generate` after a contract change.
export * from "./gen/qwibi/v1/account_pb.js";
export * from "./gen/qwibi/v1/app_pb.js";
export * from "./gen/qwibi/v1/app_data_pb.js";
export * from "./gen/qwibi/v1/app_release_pb.js";
export * from "./gen/qwibi/v1/app_release_service_pb.js";
export * from "./gen/qwibi/v1/app_installation_pb.js";
export * from "./gen/qwibi/v1/app_member_pb.js";
export * from "./gen/qwibi/v1/auth_pb.js";
export * from "./gen/qwibi/v1/auth_options_pb.js";
export * from "./gen/qwibi/v1/common_pb.js";
export * from "./gen/qwibi/v1/events_pb.js";
export * from "./gen/qwibi/v1/geometry_pb.js";
export * from "./gen/qwibi/v1/invocation_pb.js";
export * from "./gen/qwibi/v1/layer_pb.js";
export * from "./gen/qwibi/v1/mark_pb.js";
export * from "./gen/qwibi/v1/media_pb.js";
export * from "./gen/qwibi/v1/object_pb.js";
export * from "./gen/qwibi/v1/organization_pb.js";
export * from "./gen/qwibi/v1/push_pb.js";
export * from "./gen/qwibi/v1/query_pb.js";
export * from "./gen/qwibi/v1/search_pb.js";
export * from "./gen/qwibi/v1/service_pb.js";
export * from "./gen/qwibi/v1/signal_pb.js";
export * from "./gen/qwibi/v1/subscribe_pb.js";
export * from "./gen/qwibi/stream/v1/stream_pb.js";

// The protobuf-es message constructor and binary codec. The generated *Schema
// symbols above are useless to a consumer without them: building an exact
// AppRelease manifest goes through create(). The release's canonical content
// hash is not SHA-256 over toBinary (map order differs); use
// releaseContentSha256 or sealRelease from ./release.js.
export { create, toBinary } from "@bufbuild/protobuf";

// Ergonomic geometry constructors (point, lineString, polygon, multi*, …).
export * from "./geometry.js";
export * from "./l1.js";
export * from "./livelayer.js";
export * from "./state.js";
export * from "./stream.js";
export * from "./errors.js";
export * from "./retry.js";
export * from "./deadline.js";
export * from "./transport.js";
export * from "./localization.js";
export * from "./declarativeResult.js";
export * from "./installation.js";
export * from "./provenance.js";
export * from "./release.js";
export * from "./app.js";

import { create } from "@bufbuild/protobuf";
import { createClient, type Client } from "@connectrpc/connect";
import { createQwibiTransport, type QwibiClientOptions } from "./transport.js";
import {
  AppReleaseSchema,
  AppReleaseSelectorSchema,
  AppVersionSelectorSchema,
  ReleaseAssetSchema,
  type AppRelease,
  type ReleaseAsset,
} from "./gen/qwibi/v1/app_release_pb.js";
import { AppReleaseService } from "./gen/qwibi/v1/app_release_service_pb.js";
import type { SortOrder } from "./gen/qwibi/v1/common_pb.js";
import { ErrorCode } from "./gen/qwibi/v1/common_pb.js";
import type { ServerEvent } from "./gen/qwibi/v1/events_pb.js";
import { deliveryPayload } from "./provenance.js";
import { QwibiService } from "./gen/qwibi/v1/service_pb.js";
import { StreamIngressService } from "./gen/qwibi/stream/v1/stream_pb.js";

/**
 * isSlowConsumer reports whether a ServerEvent is the in-band
 * `StreamError{SLOW_CONSUMER}`: the server dropped deltas for this stream under
 * backpressure, so the client's view is now stale and cannot be trusted.
 *
 * On this event a client MUST discard its resume cursor and re-open the subscription without
 * one, so the server sends a fresh Snapshot. Prefer {@link shouldResetCursor},
 * which also covers the expired-cursor case; this predicate exists for callers
 * that want to distinguish backpressure specifically (e.g. for telemetry).
 */
export function isSlowConsumer(ev: ServerEvent): boolean {
  const payload = deliveryPayload(ev);
  return payload.case === "error" && payload.value.error?.code === ErrorCode.SLOW_CONSUMER;
}

/**
 * shouldResetCursor reports whether a ServerEvent invalidates the client's QTP
 * resume cursor: `StreamError{SLOW_CONSUMER}` (deltas were dropped — the view is
 * stale) or `StreamError{RESUME_TOKEN_EXPIRED}` (the cursor is no longer
 * replayable). The client MUST then discard the cursor and re-open the
 * subscription WITHOUT one, taking the fresh Snapshot as its new baseline. Any
 * other in-band StreamError is non-fatal: surface it and keep the stream (and
 * the cursor). Managed consumers should use LiveLayer; these predicates remain
 * for intentionally low-level stream integrations.
 */
export function shouldResetCursor(ev: ServerEvent): boolean {
  const payload = deliveryPayload(ev);
  if (payload.case !== "error") return false;
  const code = payload.value.error?.code;
  return code === ErrorCode.SLOW_CONSUMER || code === ErrorCode.RESUME_TOKEN_EXPIRED;
}

type GeneratedQwibiClient = Client<typeof QwibiService>;
type GeneratedAppReleaseClient = Client<typeof AppReleaseService>;
type GeneratedCreateLayerInput = Parameters<GeneratedQwibiClient["createLayer"]>[0];
type ExactRequest<Shape, Request extends Shape> =
  Request & Record<Exclude<keyof Request, keyof Shape>, never>;

/** Public Layer-first creation input. App and delegation fields are excluded. */
export type CreateLayerInput =
  Pick<
    GeneratedCreateLayerInput,
    | "description"
    | "public"
    | "properties"
    | "style"
    | "zIndex"
    | "opacity"
    | "join"
    | "listingIntent"
    | "ownerAccountId"
  >
  & {
    organizationId: string;
    hid: string;
    name: string;
  };

/** Public immutable-ID lookup input. App-scoped HID lookup is not exposed. */
export interface GetLayerInput {
  layerId: string;
}

interface LayerFirstClientMethods {
  createLayer<Request extends CreateLayerInput>(
    request: ExactRequest<CreateLayerInput, Request>,
    options?: Parameters<GeneratedQwibiClient["createLayer"]>[1],
  ): ReturnType<GeneratedQwibiClient["createLayer"]>;
  getLayer<Request extends GetLayerInput>(
    request: ExactRequest<GetLayerInput, Request>,
    options?: Parameters<GeneratedQwibiClient["getLayer"]>[1],
  ): ReturnType<GeneratedQwibiClient["getLayer"]>;
  resolveLayerHumanID(
    request: Parameters<GeneratedQwibiClient["resolveLayerHumanID"]>[0],
    options?: Parameters<GeneratedQwibiClient["resolveLayerHumanID"]>[1],
  ): ReturnType<GeneratedQwibiClient["resolveLayerHumanID"]>;
  listDiscoverableLayers(
    request: Parameters<GeneratedQwibiClient["listDiscoverableLayers"]>[0],
    options?: Parameters<GeneratedQwibiClient["listDiscoverableLayers"]>[1],
  ): ReturnType<GeneratedQwibiClient["listDiscoverableLayers"]>;
  listMyLayers(
    request: Parameters<GeneratedQwibiClient["listMyLayers"]>[0],
    options?: Parameters<GeneratedQwibiClient["listMyLayers"]>[1],
  ): ReturnType<GeneratedQwibiClient["listMyLayers"]>;
}

/** One exact immutable-release selector; latest/active/install selectors do not exist. */
export type ExactAppReleaseSelector =
  | {
    releaseId: string;
    appId?: never;
    semanticVersion?: never;
  }
  | {
    releaseId?: never;
    appId: string;
    semanticVersion: string;
  };

/** Exact release selector plus the caller's supported Qwibi contract version. */
export type GetAppReleaseInput =
  | {
    releaseId: string;
    appId?: never;
    semanticVersion?: never;
    consumerContractVersion?: string;
  }
  | {
    releaseId?: never;
    appId: string;
    semanticVersion: string;
    consumerContractVersion?: string;
  };

/** Opaque keyset pagination for one exact App's immutable releases. */
export interface ListAppReleasesInput {
  appId: string;
  page?: {
    limit: number;
    cursor: string;
    order: SortOrder;
  };
}

/** Exact content-addressed public asset lookup. */
export interface GetReleaseAssetInput {
  contentSha256: Uint8Array;
}

/** Exact publisher-authorized immutable asset upload. */
export interface UploadReleaseAssetInput {
  appId: string;
  asset: ReleaseAsset;
  content: Uint8Array;
}

interface ExactReleaseClientMethods {
  publishAppRelease<Release extends AppRelease>(
    release: ExactRequest<AppRelease, Release>,
    options?: Parameters<GeneratedAppReleaseClient["publishAppRelease"]>[1],
  ): ReturnType<GeneratedAppReleaseClient["publishAppRelease"]>;
  getAppRelease<Selector extends GetAppReleaseInput>(
    selector: ExactRequest<GetAppReleaseInput, Selector>,
    options?: Parameters<GeneratedAppReleaseClient["getAppRelease"]>[1],
  ): ReturnType<GeneratedAppReleaseClient["getAppRelease"]>;
  listAppReleases<Request extends ListAppReleasesInput>(
    request: ExactRequest<ListAppReleasesInput, Request>,
    options?: Parameters<GeneratedAppReleaseClient["listAppReleases"]>[1],
  ): ReturnType<GeneratedAppReleaseClient["listAppReleases"]>;
  getReleaseAsset<Request extends GetReleaseAssetInput>(
    request: ExactRequest<GetReleaseAssetInput, Request>,
    options?: Parameters<GeneratedAppReleaseClient["getReleaseAsset"]>[1],
  ): ReturnType<GeneratedAppReleaseClient["getReleaseAsset"]>;
  uploadReleaseAsset<Request extends UploadReleaseAssetInput>(
    request: ExactRequest<UploadReleaseAssetInput, Request>,
    options?: Parameters<GeneratedAppReleaseClient["uploadReleaseAsset"]>[1],
  ): ReturnType<GeneratedAppReleaseClient["uploadReleaseAsset"]>;
}

type ReplacedLayerMethods =
  | "createLayer"
  | "getLayer"
  | "resolveLayerHumanID"
  | "listDiscoverableLayers"
  | "listMyLayers";

/**
 * A ready-to-use Layer-first client whose create/get inputs are rebuilt from
 * the public allowed fields.
 */
export type QwibiClient =
  Omit<GeneratedQwibiClient, ReplacedLayerMethods>
  & LayerFirstClientMethods
  & ExactReleaseClientMethods;
export type QwibiStreamIngressClient = Client<typeof StreamIngressService>;

/**
 * createQwibiClient builds a browser client for the qwibi.v1 service over
 * gRPC-Web through the gateway edge (a raw gRPC server is not reachable from a
 * browser). Unary RPCs AND server-streaming (StreamLayer — the live-layer
 * subscription) are supported over gRPC-Web; only bidirectional streaming
 * (Subscribe) is not available from a browser.
 */
export function createQwibiClient(opts: QwibiClientOptions): QwibiClient {
  const transport = createQwibiTransport(opts);
  const generated = createClient(QwibiService, transport);
  const releases = createClient(AppReleaseService, transport);
  const {
    createLayer: generatedCreateLayer,
    getLayer: generatedGetLayer,
    ...layerFirst
  } = generated;
  return {
    ...layerFirst,
    createLayer(request, options) {
      return generatedCreateLayer({
        organizationId: request.organizationId,
        hid: request.hid,
        name: request.name,
        description: request.description,
        public: request.public,
        properties: request.properties,
        style: request.style,
        zIndex: request.zIndex,
        opacity: request.opacity,
        join: request.join,
        listingIntent: request.listingIntent,
        ownerAccountId: request.ownerAccountId,
      }, options);
    },
    getLayer(request, options) {
      return generatedGetLayer({ layerId: request.layerId }, options);
    },
    publishAppRelease(release, options) {
      return releases.publishAppRelease({
        release: copyExactRelease(release),
      }, options);
    },
    getAppRelease(selector, options) {
      const exactSelector = selector.releaseId !== undefined
        ? create(AppReleaseSelectorSchema, {
            selector: { case: "releaseId", value: selector.releaseId },
          })
        : create(AppReleaseSelectorSchema, {
            selector: {
              case: "appVersion",
              value: create(AppVersionSelectorSchema, {
                appId: selector.appId,
                semanticVersion: selector.semanticVersion,
              }),
            },
          });
      return releases.getAppRelease({
        selector: exactSelector,
        consumerContractVersion: selector.consumerContractVersion ?? "",
      }, options);
    },
    listAppReleases(request, options) {
      return releases.listAppReleases({
        appId: request.appId,
        page: request.page
          ? {
              limit: request.page.limit,
              cursor: request.page.cursor,
              order: request.page.order,
            }
          : undefined,
      }, options);
    },
    getReleaseAsset(request, options) {
      return releases.getReleaseAsset({
        contentSha256: request.contentSha256,
      }, options);
    },
    uploadReleaseAsset(request, options) {
      return releases.uploadReleaseAsset({
        appId: request.appId,
        asset: create(ReleaseAssetSchema, {
          contentSha256: request.asset.contentSha256,
          mediaType: request.asset.mediaType,
          sizeBytes: request.asset.sizeBytes,
          logicalName: request.asset.logicalName,
        }),
        content: request.content,
      }, options);
    },
  };
}

// Rebuild the manifest from the immutable generated fields. Besides producing
// the exact AppRelease wire type, this strips runtime-cast legacy GeoApp fields
// such as commands instead of forwarding them into transport construction.
function copyExactRelease(release: AppRelease): AppRelease {
  return create(AppReleaseSchema, {
    releaseId: release.releaseId,
    appId: release.appId,
    semanticVersion: release.semanticVersion,
    canonicalContentSha256: release.canonicalContentSha256,
    contractRange: release.contractRange,
    actions: release.actions,
    objectSchemas: release.objectSchemas,
    objectPresentations: release.objectPresentations,
    uiContributions: release.uiContributions,
    localizations: release.localizations,
    safeFallbacks: release.safeFallbacks,
    assets: release.assets,
    publisherMetadata: release.publisherMetadata,
    publishedAt: release.publishedAt,
    optionalExtensions: release.optionalExtensions,
    primaryActionId: release.primaryActionId,
    marks: release.marks,
  });
}

/** A browser-compatible client for the Stream API unary PublishBatch surface. */
export function createStreamIngressClient(opts: QwibiClientOptions): QwibiStreamIngressClient {
  return createClient(StreamIngressService, createQwibiTransport(opts));
}
