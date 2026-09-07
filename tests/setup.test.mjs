import assert from "node:assert/strict";
import test from "node:test";
import { azureSetup, configure, ensureHydraFusion } from "../integration/extensions/lerna/setup.mjs";

function fixture({ confirm = true, progress, configured = true, enabled = false } = {}) {
  const calls = [];
  const logs = [];
  const session = {
    capabilities: { ui: { elicitation: true } },
    ui: { confirm: async () => confirm, select: async (_message, options) => options[0] },
    log: async message => logs.push(message),
    rpc: { model: { switchTo: async value => calls.push(["switch", value]) } },
  };
  const bridge = {
    invoke: async (op, data, options) => {
      calls.push([op, data]);
      if (op === "azure.login") {
        if (progress) await options.onProgress(progress);
        return { authenticated: true, persistentCache: true };
      }
      if (op === "enable") enabled = true;
      if (op === "disable") enabled = false;
      if (op === "status") return {
        configured, enabled, verbose: false, model: null, deployment: null,
        models: configured ? ["gpt-5.6-terra"] : [],
      };
      return {};
    },
  };
  return { session, bridge, calls, logs };
}

test("Lerna enables experimental features and switches to HydraFusion", async () => {
  const logs = [];
  const calls = [];
  let modelId = "gpt-5.6-terra";
  const session = {
    capabilities: { ui: { elicitation: true } },
    ui: { confirm: async () => true },
    log: async message => logs.push(message),
    rpc: {
      settings: {
        get: async () => ({ settings: { experimental: { value: false } } }),
        set: async value => calls.push(["settings", value]),
      },
      model: {
        getCurrent: async () => ({ modelId }),
        switchTo: async value => { calls.push(["switch", value]); modelId = value.modelId; },
      },
    },
  };

  assert.equal(await ensureHydraFusion(session, session.rpc.settings), true);
  assert.deepEqual(calls, [["settings", { settings: { experimental: true } }], ["switch", { modelId: "hydrafusion", requireAvailable: true }]]);
  assert.match(logs[0], /Experimental features enabled/);
  assert.match(logs[1], /changed the selected model/);
});

test("a legacy setting override prevents switching to HydraFusion", async () => {
  const logs = [];
  const calls = [];
  const settings = {
    get: async () => ({ settings: { experimental: { value: false } } }),
    set: async value => { calls.push(value); return { shadowedKeys: ["experimental"] }; },
  };
  const session = {
    capabilities: { ui: { elicitation: true } },
    ui: { confirm: async () => true },
    log: async message => logs.push(message),
    rpc: { model: { switchTo: async value => calls.push(value) } },
  };

  assert.equal(await ensureHydraFusion(session, settings), false);
  assert.deepEqual(calls, [{ settings: { experimental: true } }]);
  assert.match(logs[0], /legacy config\.json still overrides it/);
});

test("declining experimental features leaves the selected model unchanged", async () => {
  const logs = [];
  const session = {
    capabilities: { ui: { elicitation: true } },
    ui: { confirm: async () => false },
    log: async message => logs.push(message),
    rpc: { settings: { get: async () => ({ settings: { experimental: { value: false } } }) }, model: { getCurrent: async () => ({ modelId: "gpt-5.6-terra" }) } },
  };

  assert.equal(await ensureHydraFusion(session, session.rpc.settings), false);
  assert.match(logs[0], /remain disabled/);
});

test("Lerna switches an already-enabled session to HydraFusion", async () => {
  const calls = [];
  const logs = [];
  const session = {
    capabilities: { ui: { elicitation: true } },
    log: async message => logs.push(message),
    rpc: {
      settings: { get: async () => ({ settings: { experimental: { value: true } } }) },
      model: {
        getCurrent: async () => ({ modelId: "gpt-5.6-terra" }),
        switchTo: async value => calls.push(value),
      },
    },
  };

  assert.equal(await ensureHydraFusion(session, session.rpc.settings), true);
  assert.deepEqual(calls, [{ modelId: "hydrafusion", requireAvailable: true }]);
  assert.match(logs[0], /changed the selected model/);
});

test("Azure setup signs in, enables configured routes, and switches to HydraFusion", async () => {
  const { session, bridge, calls } = fixture();
  const result = await azureSetup(session, bridge);
  assert.equal(result.configured, true);
  assert.equal(result.enabled, true);
  assert.equal(calls.some(([op]) => op === "enable"), true);
  assert.equal(calls.some(([op]) => op === "azure.subscriptions"), false);
  assert.deepEqual(calls.at(-1), ["switch", { modelId: "hydrafusion" }]);
});

test("declining first-run setup does not start authentication", async () => {
  const { session, bridge, calls } = fixture({ confirm: false });
  assert.equal(await azureSetup(session, bridge), null);
  assert.equal(calls.length, 0);
});

test("setup accepts Azure's login.microsoft.com device URL", async () => {
  const { session, bridge } = fixture({ progress: {
    verificationUri: "https://login.microsoft.com/device", userCode: "ABC12345",
  } });
  const result = await azureSetup(session, bridge);
  assert.equal(result.enabled, true);
});

test("setup rejects non-Microsoft and lookalike login links", async () => {
  for (const verificationUri of ["https://example.com/login", "https://notmicrosoft.com/login"]) {
    const { session, bridge } = fixture({ progress: { verificationUri, userCode: "ABC12345" } });
    await assert.rejects(azureSetup(session, bridge), /unexpected sign-in/);
  }
});

test("Azure setup reports when sign-in succeeds without configured routes", async () => {
  const { session, bridge, calls, logs } = fixture({ configured: false });
  const result = await azureSetup(session, bridge);
  assert.equal(result.configured, false);
  assert.equal(calls.some(([op]) => op === "enable"), false);
  assert.match(logs.at(-1), /Configure or import at least one HydraFusion route/);
});

test("status describes multi-model HydraFusion routing without null placeholders", async () => {
  const logs = [];
  const session = { log: async message => logs.push(message) };
  const bridge = { invoke: async () => ({
    configured: true, enabled: true, verbose: true,
    model: null, deployment: null, models: ["gpt-5.6-sol", "claude-opus-5"],
  }) };

  await configure(session, bridge, "status");
  assert.equal(logs[0], "Lerna enabled: 2 HydraFusion models routed (gpt-5.6-sol, claude-opus-5). Verbose on.");
  assert.doesNotMatch(logs[0], /null/);
});

test("verbose mode works without configured or enabled routing", async () => {
  const calls = [];
  const logs = [];
  let verbose = false;
  const session = { log: async message => logs.push(message) };
  const bridge = {
    invoke: async (op, data) => {
      calls.push([op, data]);
      if (op === "verbose") verbose = data.enabled;
      if (op === "status") return { configured: false, enabled: false, verbose, models: [] };
      return {};
    },
  };

  const status = await configure(session, bridge, "verbose on");
  assert.equal(status.verbose, true);
  assert.equal(status.enabled, false);
  assert.equal(status.configured, false);
  assert.match(logs[0], /not configured/);
  assert.match(logs[0], /Verbose on/);
});

test("logout disables routing before removing Azure authentication", async () => {
  const { session, bridge, calls } = fixture({ enabled: true });

  const status = await configure(session, bridge, "logout");

  assert.deepEqual(calls.slice(0, 2).map(([op]) => op), ["disable", "azure.logout"]);
  assert.equal(status.enabled, false);
});

test("verbose commands persist on and off with case-insensitive whitespace", async () => {
  const calls = [];
  const logs = [];
  let verbose = false;
  const session = { log: async message => logs.push(message) };
  const bridge = {
    invoke: async (op, data) => {
      calls.push([op, data]);
      if (op === "verbose") verbose = data.enabled;
      if (op === "status") return { configured: true, enabled: true, verbose, model: "terra", deployment: "terra" };
      return {};
    },
  };

  const enabled = await configure(session, bridge, "  VERBOSE ON  ");
  assert.deepEqual(calls[0], ["verbose", { enabled: true }]);
  assert.equal(enabled.verbose, true);
  assert.match(logs[0], /Verbose on/);

  const disabled = await configure(session, bridge, "verbose off");
  assert.deepEqual(calls[2], ["verbose", { enabled: false }]);
  assert.equal(disabled.verbose, false);
  assert.match(logs[1], /Verbose off/);
});
