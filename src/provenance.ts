import type {
  ProvenancedEvent,
  ServerEvent,
} from "./gen/qwibi/v1/events_pb.js";
import type { Provenance } from "./gen/qwibi/v1/provenance_pb.js";

export type DeliveryPayload = Exclude<
  ServerEvent["payload"],
  { case: "provenancedEvent" }
>;

/** Returns the server-owned provenance carried by the production envelope. */
export function eventProvenance(event: ServerEvent): Provenance | undefined {
  return event.payload.case === "provenancedEvent"
    ? event.payload.value.provenance
    : undefined;
}

/**
 * Returns the delivered payload without discarding its enclosing ServerEvent.
 * Callers that need attribution retain the original event and read it through
 * eventProvenance; this view exists only for payload dispatch and reconciliation.
 */
export function deliveryPayload(event: ServerEvent): DeliveryPayload {
  if (event.payload.case !== "provenancedEvent") {
    return event.payload as DeliveryPayload;
  }
  return event.payload.value.payload as ProvenancedEvent["payload"] as DeliveryPayload;
}
