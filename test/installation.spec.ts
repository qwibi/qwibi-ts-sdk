import { ConnectError, type Interceptor, type UnaryRequest } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import {
  AppInstallationService,
  AppRight,
  InstallationParticipantConsentDecision,
  createQwibiInstallationClient,
} from "../src/index.js";

describe("App installation client", () => {
  it("exposes one-call install and per-person consent with the configured bearer", async () => {
    const methods = AppInstallationService.methods.map((method) => method.localName);
    expect(methods).toContain("installApp");
    expect(methods).toContain("setInstallationParticipantConsent");
    expect(methods).not.toContain("updateAppInstallation");

    const captured: UnaryRequest[] = [];
    const sentinel = new ConnectError("transport sentinel");
    const interceptor: Interceptor = (_next) => async (request) => {
      captured.push(request);
      throw sentinel;
    };
    const client = createQwibiInstallationClient({
      baseUrl: "http://127.0.0.1:7903",
      token: "person-token",
      interceptors: [interceptor],
    });

    await expect(client.installApp({ layerId: "layer", appId: "app" })).rejects.toBe(sentinel);
    await expect(client.setInstallationParticipantConsent({
      appId: "app",
      right: AppRight.LIVE_LOCATION,
      decision: InstallationParticipantConsentDecision.CONSENTED,
    })).rejects.toBe(sentinel);

    expect(captured).toHaveLength(2);
    expect(captured.map((request) => request.header.get("Authorization"))).toEqual([
      "Bearer person-token", "Bearer person-token",
    ]);
    expect(captured[0]?.message).toMatchObject({ layerId: "layer", appId: "app" });
    expect(captured[1]?.message).toMatchObject({
      appId: "app", right: AppRight.LIVE_LOCATION,
      decision: InstallationParticipantConsentDecision.CONSENTED,
    });
  });
});
