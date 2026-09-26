import { createClient, type Client } from "@connectrpc/connect";
import { AppInstallationService } from "./gen/qwibi/v1/app_installation_pb.js";
import { createQwibiTransport, type QwibiClientOptions } from "./transport.js";

export type QwibiInstallationClient = Client<typeof AppInstallationService>;

/** Opens the App installation lifecycle through the gateway. */
export function createQwibiInstallationClient(opts: QwibiClientOptions): QwibiInstallationClient {
  return createClient(AppInstallationService, createQwibiTransport(opts));
}
