import { defineConfig } from "vitest/config";

// Plain node-environment specs over the
// generated qwibi.v1 bindings. No DOM, no transport — contract shape only.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
  },
});
