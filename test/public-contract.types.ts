import { create } from "@bufbuild/protobuf";
import {
  AppReleaseSchema,
  blockLayer,
  createQwibiAppDataClient,
  createQwibiClient,
  createQwibiInvocationClient,
  createQwibiMarkClient,
  currentAppRelease,
  listAllAppObjects,
  putAppPicture,
  sealRelease,
  serveInvocations,
  succeeded,
  GeoAppSchema,
  JoinPolicy,
  LayerListingIntent,
  OrganizationAccessKeyScope,
  type CreateLayerInput,
} from "../src/index.js";

const client = createQwibiClient({ baseUrl: "http://127.0.0.1:7903" });

const validCreate = {
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
  ownerAccountId: "019d0000-0000-7000-8000-000000000007",
} satisfies CreateLayerInput;
void client.createLayer(validCreate);

void client.createOrganizationAccessKey({
  organizationId: "019d0000-0000-7000-8000-000000000008",
  name: "automation",
  scopes: [OrganizationAccessKeyScope.APPS_MANAGE],
  ttlSeconds: 0,
});
void client.listOrganizationAccessKeys({
  organizationId: "019d0000-0000-7000-8000-000000000008",
});
void client.revokeOrganizationAccessKey({
  keyId: "019d0000-0000-7000-8000-000000000009",
});

const appScopedCreate = { ...validCreate, appId: "app-probe" };
// @ts-expect-error App-scoped creation is not part of the public Layer-first contract.
void client.createLayer(appScopedCreate);

const delegatedCreate = { ...validCreate, onBehalfOfAccountId: "account-probe" };
// @ts-expect-error Delegated creation is not part of the public Layer-first contract.
void client.createLayer(delegatedCreate);

const generatedCreate = { ...validCreate, $typeName: "qwibi.v1.CreateLayerRequest" as const };
// @ts-expect-error The generated message discriminator is not a public input field.
void client.createLayer(generatedCreate);

void client.getLayer({ layerId: "layer-1" });

const appScopedGet = { layerId: "layer-1", appId: "app-probe" };
// @ts-expect-error App-scoped lookup is not part of the public Layer-first contract.
void client.getLayer(appScopedGet);

const legacyHidGet = { layerId: "layer-1", hid: "legacy-hid" };
// @ts-expect-error HID lookup uses resolveLayerHumanID, never the immutable-ID method.
void client.getLayer(legacyHidGet);

const release = create(AppReleaseSchema, {
  releaseId: "019d0000-0000-7000-8000-000000000002",
  appId: "019d0000-0000-7000-8000-000000000001",
  semanticVersion: "1.2.3",
});
void client.publishAppRelease(release);
void client.getAppRelease({ releaseId: release.releaseId });
void client.getAppRelease({
  releaseId: release.releaseId,
  consumerContractVersion: "0.2.0",
});
void client.getAppRelease({ appId: release.appId, semanticVersion: release.semanticVersion });
void client.listAppReleases({ appId: release.appId, page: { limit: 10, cursor: "opaque", order: 1 } });
void client.getReleaseAsset({ contentSha256: new Uint8Array(32) });
void client.uploadReleaseAsset({
  appId: release.appId,
  asset: release.assets[0]!,
  content: new Uint8Array([1]),
});

// @ts-expect-error Upload always names one exact App.
void client.uploadReleaseAsset({ asset: release.assets[0]!, content: new Uint8Array([1]) });

const legacyCommands = { ...release, commands: [] };
// @ts-expect-error Mutable GeoApp commands are not accepted as release manifest fields.
void client.publishAppRelease(legacyCommands);

const mutableApp = create(GeoAppSchema, { uid: release.appId });
// @ts-expect-error A mutable GeoApp is not an immutable AppRelease.
void client.publishAppRelease(mutableApp);

// @ts-expect-error Release lookup never resolves latest.
void client.getAppRelease({ appId: release.appId, latest: true });

// @ts-expect-error Release lookup never resolves an installation's active release.
void client.getAppRelease({ installationId: "019d0000-0000-7000-8000-000000000003", active: true });

// @ts-expect-error Listing always names one exact App.
void client.listAppReleases({ page: { limit: 10, cursor: "", order: 1 } });

// @ts-expect-error Asset lookup is solely by the exact content hash.
void client.getReleaseAsset({ appId: release.appId, logicalName: "mutable-icon" });

// The whole App loop through the published package.
const appOptions = { baseUrl: "http://127.0.0.1:7903", token: "publish-key" };
const appData = createQwibiAppDataClient(appOptions);
void appData.putAppObjects({ appId: release.appId, objects: [], upsert: true });
void appData.replaceAppObjects({ appId: release.appId, objects: [] });
void appData.deleteAppObjects({ appId: release.appId, hids: ["gone"] });
void appData.moveAppObjects({ appId: release.appId, moves: [] });
void listAllAppObjects(appData, release.appId);
void putAppPicture(appData, release.appId, new Uint8Array([0x89]));
void sealRelease(release.appId, release).then(sealed => client.publishAppRelease(sealed));
void currentAppRelease(client, release.appId);
const invocations = createQwibiInvocationClient(appOptions);
void serveInvocations(invocations, call => succeeded(call, { ok: true }), { signal: new AbortController().signal });
void blockLayer(invocations, "opaque-key", "reason");
const marks = createQwibiMarkClient(appOptions);
void marks.setMark({ appId: release.appId, markId: "visited", objectId: release.appId, on: true });
void marks.listMyMarks({ appId: release.appId });
void marks.importMyMarks({ appId: release.appId, marks: [{ markId: "visited", objectId: release.appId }] });
