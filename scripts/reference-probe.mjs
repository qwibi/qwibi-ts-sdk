import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@connectrpc/connect";
import {
  AppInstallationStatus, AppInvocationService, InvocationStatus, InvocationTrigger,
  createQwibiClient, createQwibiInstallationClient, createQwibiTransport,
} from "../dist/index.js";

const appHid = process.env.REFERENCE_APP_HID;
if (appHid !== "hk-mtr" && appHid !== "geopedia") throw new Error("REFERENCE_APP_HID must name a reference App");
const timeoutMs = Number(process.env.REFERENCE_APP_REQUEST_TIMEOUT_MS);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("invalid reference App timeout");
const baseUrl = process.env.REFERENCE_APP_GATEWAY_URL;
if (!baseUrl) throw new Error("REFERENCE_APP_GATEWAY_URL is required");
const started = Date.now();
const deadline = AbortSignal.timeout(timeoutMs);
const callOptions = { signal: deadline };
let token = "";
const options = { baseUrl, token: () => token, timeoutMs };
const qwibi = createQwibiClient(options);
const installations = createQwibiInstallationClient(options);
const invocations = createClient(AppInvocationService, createQwibiTransport(options));
const auth = await qwibi.authenticate({ credential: { method: { case: "anonymous", value: { deviceId: `qwibi-reference-${appHid}-readiness-v2` } } } }, callOptions);
token = auth.session?.accessToken ?? "";
if (!token) throw new Error("anonymous authentication returned no access token");
const resolved = await qwibi.resolveLayerHumanID({ layerHid: appHid }, callOptions);
const layerId = resolved.layer?.uid;
if (!layerId) throw new Error(`${appHid} Layer was not resolved`);
let cursor = "";
const matches = [];
do {
  const page = await installations.listAppInstallations({ scope: { case: "layerId", value: layerId }, page: { limit: 200, cursor } }, callOptions);
  for (const installation of page.installations) {
    if (installation.status !== AppInstallationStatus.ACTIVE) continue;
    const app = (await qwibi.getApp({ appId: installation.appId }, callOptions)).app;
    if (app?.hid === appHid) matches.push(installation);
  }
  cursor = page.page?.nextCursor ?? "";
} while (cursor);
if (matches.length !== 1) throw new Error(`expected one active ${appHid} installation, got ${matches.length}`);
const inputs = appHid === "hk-mtr"
  ? { from: "sta-cen", to: "sta-adm", prefer: "fewer-changes" }
  : { map_area: { bbox: { west: 4.839, south: 52.355, east: 4.963, north: 52.408 }, zoom: 13 } };
const actionId = appHid === "hk-mtr" ? "plan-route" : "nearby_places";
const accepted = await invocations.invokeAction({
  layerId, appId: matches[0].appId, actionId, inputs,
  idempotencyKey: crypto.randomUUID(), trigger: InvocationTrigger.PERSON, locale: "en",
}, callOptions);
if (!accepted.invocationId) throw new Error(`${actionId} returned no invocation ID`);
let answer;
while (!deadline.aborted) {
  const update = await invocations.getInvocation({ invocationId: accepted.invocationId }, callOptions);
  if (update.status === InvocationStatus.SUCCEEDED || update.status === InvocationStatus.FAILED || update.status === InvocationStatus.EXPIRED || update.status === InvocationStatus.UNAVAILABLE) {
    answer = update;
    break;
  }
  await delay(200, undefined, callOptions);
}
if (!answer) throw new Error(`${actionId} produced no answer within ${timeoutMs} ms`);
if (answer.status !== InvocationStatus.SUCCEEDED) throw new Error(`${actionId} ended with status ${InvocationStatus[answer.status]}`);
if (appHid === "hk-mtr") {
  const route = answer.result?.route;
  if (!Array.isArray(route?.stations) || route.stations[0] !== inputs.from || route.stations.at(-1) !== inputs.to) throw new Error("route endpoints differ from the request");
  for (const field of ["duration_minutes", "stops", "changes"]) if (!Number.isFinite(route[field])) throw new Error(`route omitted ${field}`);
  console.log(`hk-mtr=PASS request=plan-route result=stops:${route.stops} elapsed_ms:${Date.now()-started}`);
} else {
  const result = answer.result;
  const places = result?.result?.places;
  if (!Array.isArray(places) || places.length === 0) throw new Error("nearby_places returned no places");
  for (const place of places) {
    if (!place?.title || !place?.description || place.geometry?.type !== "Point" || !Array.isArray(place.geometry.coordinates) || place.geometry.coordinates.length !== 2) throw new Error("invalid place");
    const link = new URL(place.link);
    if (link.protocol !== "https:" || !/(^|\.)wikipedia\.org$/u.test(link.hostname)) throw new Error("non-Wikipedia link");
  }
  if (!Array.isArray(result?.alternatives) || result.alternatives.length !== 0) throw new Error("unexpected alternatives");
  console.log(`geopedia=PASS request=nearby_places result=places:${places.length} elapsed_ms:${Date.now()-started}`);
}
