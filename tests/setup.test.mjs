import assert from "node:assert/strict";
import test from "node:test";
import { azureSetup } from "../integration/extensions/lerna/setup.mjs";

function fixture({ confirm = true, progress, deployments } = {}) {
  const calls = [];
  const session = {
    capabilities: { ui: { elicitation: true } },
    ui: { confirm: async () => confirm, select: async (_message, options) => options[0] },
    log: async () => {},
    rpc: { model: { switchTo: async value => calls.push(["switch", value]) } },
  };
  const bridge = {
    invoke: async (op, data, options) => {
      calls.push([op, data]);
      if (op === "azure.login") {
        if (progress) await options.onProgress(progress);
        return { authenticated: true, persistentCache: true };
      }
      if (op === "azure.subscriptions") return {
        subscriptions: [{ subscriptionId: "subscription", tenantId: "tenant", displayName: "Test" }],
      };
      if (op === "azure.deployments") return { deployments: deployments ?? [{
        resourceId: "resource", deployment: "terra", model: "gpt-5.6-terra",
      }] };
      if (op === "status") return { configured: true, enabled: true, deployment: "terra", model: "gpt-5.6-terra" };
      return {};
    },
  };
  return { session, bridge, calls };
}

test("Azure setup signs in, selects metadata, and switches to Hydra", async () => {
  const { session, bridge, calls } = fixture();
  const result = await azureSetup(session, bridge);
  assert.equal(result.configured, true);
  assert.deepEqual(calls.find(([op]) => op === "azure.select")[1], {
    subscriptionId: "subscription", tenantId: "tenant", resourceId: "resource", deployment: "terra",
  });
  assert.deepEqual(calls.at(-1), ["switch", { modelId: "hydrafusion" }]);
});

test("declining first-run setup does not start authentication", async () => {
  const { session, bridge, calls } = fixture({ confirm: false });
  assert.equal(await azureSetup(session, bridge), null);
  assert.equal(calls.length, 0);
});

test("setup rejects non-Microsoft login links", async () => {
  const { session, bridge } = fixture({ progress: {
    verificationUri: "https://example.com/login", userCode: "ABC12345",
  } });
  await assert.rejects(azureSetup(session, bridge), /unexpected sign-in/);
});

test("no compatible deployments leaves configuration unchanged", async () => {
  const { session, bridge, calls } = fixture({ deployments: [] });
  await assert.rejects(azureSetup(session, bridge), /No compatible/);
  assert.equal(calls.some(([op]) => op === "azure.select"), false);
});
