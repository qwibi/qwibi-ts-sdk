import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fromBinary } from "@bufbuild/protobuf";

import { ProvenancedEventSchema, ServerEventSchema } from "../dist/gen/qwibi/v1/events_pb.js";
import { LiveLayer, deliveryPayload, eventProvenance } from "../dist/index.js";

const fixtureDir = process.env.LF08_EVENT_FIXTURE;
if (!fixtureDir) throw new Error("LF08_EVENT_FIXTURE is required");

const shapes = [
  ["object_created", "created", "objectCreated"],
  ["object_deleted", "deleted", "objectDeleted"],
  ["state_event", "stateEvent", "stateEvent"],
];

async function deliver(shape, listener) {
  const event = fromBinary(ServerEventSchema, await readFile(join(fixtureDir, `${shape}.pb`)));
  const source = {
    async *open() {
      yield event;
    },
  };
  const layer = new LiveLayer(source, {
    layerIds: ["lf08-layer"],
    viewport: {
      bbox: {
        southWest: { lon: 0, lat: 0 },
        northEast: { lon: 1, lat: 1 },
      },
      zoom: 14,
    },
  });
  let delivered;
  layer.on("serverEvent", (received) => {
    delivered = received;
  });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TypeScript SDK ${shape} delivery timed out`)), 2_000);
    layer.on(listener, () => {
      clearTimeout(timer);
      layer.stop();
      resolve(delivered);
    });
    layer.start();
  });
}

function assertProvenance(shape, expectedCase, delivered) {
  const payload = deliveryPayload(delivered);
  if (payload.case !== expectedCase) {
    throw new Error(`LF08_CONSUMER_ASSERT_FAIL consumer=ts_sdk shape=${shape} element=payload: got=${String(payload.case)} want=${expectedCase}`);
  }
  const provenance = eventProvenance(delivered);
  if (!provenance?.producer || !provenance.mutationAudit?.actor) {
    throw new Error(`LF08_CONSUMER_ASSERT_FAIL consumer=ts_sdk shape=${shape} element=provenance`);
  }
  if (process.env.LF08_FAULT === "ts_sdk.actor_installation_id") {
    provenance.mutationAudit.actor.installationId = "";
  }
  const { producer, mutationAudit } = provenance;
  const { actor } = mutationAudit;
  const expected = [
    [producer.producerKind, 1, "producer.kind"],
    [producer.appId, "00000000-0000-7000-8000-000000000801", "producer.app_id"],
    [producer.releaseId, "00000000-0000-7000-8000-000000000802", "producer.release_id"],
    [producer.installationId, "00000000-0000-7000-8000-000000000803", "producer.installation_id"],
    [producer.creatorPrincipalId, shape === "state_event" ? "" : "00000000-0000-7000-8000-000000000806", "producer.creator_principal_id"],
    [actor.actorKind, 2, "actor.kind"],
    [actor.actorPrincipalId, "00000000-0000-7000-8000-000000000804", "actor.principal_id"],
    [actor.credentialId, "019f0808-0000-7000-8000-000000000805", "actor.credential_id"],
    [actor.appId, "00000000-0000-7000-8000-000000000801", "actor.app_id"],
    [actor.releaseId, "00000000-0000-7000-8000-000000000802", "actor.release_id"],
    [actor.installationId, "00000000-0000-7000-8000-000000000803", "actor.installation_id"],
    [mutationAudit.correlationId, "lf08-correlation", "correlation_id"],
    [mutationAudit.causationId, "lf08-causation", "causation_id"],
    [mutationAudit.recordedAt?.seconds, 1785715208n, "recorded_at.seconds"],
    [mutationAudit.recordedAt?.nanos, 123456000, "recorded_at.nanos"],
  ];
  for (const [actual, wanted, field] of expected) {
    if (actual !== wanted) {
      const fault = process.env.LF08_FAULT ?? "none";
      throw new Error(`LF08_CONSUMER_ASSERT_FAIL consumer=ts_sdk shape=${shape} element=${fault.replace(/^ts_sdk\./, "")}: changed ${field}: got=${String(actual)} want=${String(wanted)}`);
    }
  }
  console.log(`LF08_CONSUMER_PASS consumer=ts_sdk shape=${shape}`);
}

for (const [shape, listener, expectedCase] of shapes) {
  assertProvenance(shape, expectedCase, await deliver(shape, listener));
}

const generatedVariants = ProvenancedEventSchema.fields
  .filter((field) => field.oneof?.name === "payload")
  .map((field) => field.name)
  .sort();
console.log(`LF08_SDK_VARIANTS kit=ts cases=${generatedVariants.join(",")}`);
