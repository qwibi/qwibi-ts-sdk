import { Code, createClient } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { AppDataService } from "../src/gen/qwibi/v1/app_data_pb.js";
import { createQwibiClient, createQwibiTransport } from "../src/index.js";

const baseUrl = process.env.QWIBI_APP_DATA_TEST_GATEWAY_WEB_URL;
const login = process.env.QWIBI_APP_DATA_TEST_LOGIN;
const password = process.env.QWIBI_APP_DATA_TEST_PASSWORD;

it.skipIf(!baseUrl || !login || !password)("accepts an issued App id over gateway gRPC-web and rejects a malformed id", async () => {
  const auth = await createQwibiClient({ baseUrl: baseUrl! }).authenticate({
    credential: { method: { case: "basic", value: { login: login!, password: password! } } },
  });
  const options = { baseUrl: baseUrl!, token: auth.session?.accessToken };
  const app = await createQwibiClient(options).getApp({ hid: "hk-mtr" });
  expect(app.app?.uid).toBeTruthy();
  const data = createClient(AppDataService, createQwibiTransport(options));
  await expect(data.listAppObjects({ appId: app.app!.uid })).resolves.toHaveProperty("objects");
  await expect(data.listAppObjects({ appId: "not-a-uuid" }))
    .rejects.toMatchObject({ code: Code.InvalidArgument });
});
