import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "sdk-dir": { type: "string" },
    settings: { type: "string", default: join(homedir(), ".copilot", "settings.json") },
    "qualified-id": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log("Usage: node experiments/hydra-byok.mjs --sdk-dir PATH [--settings PATH] [--qualified-id]");
  process.exit(0);
}
const expandHome = path => path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
const events = [];
const credentials = [];
const log = (kind, data = {}) => {
  events.push({ kind, ...data });
  console.log(JSON.stringify({ kind, ...data }));
};
let client, session, directory;
const deadline = setTimeout(() => {
  console.error("Probe exceeded its three-minute deadline");
  process.exit(1);
}, 180000);
deadline.unref();

try {
  assert(values["sdk-dir"], "--sdk-dir must point to the SDK bundled with Copilot CLI 1.0.83");
  const sdkDir = resolve(expandHome(values["sdk-dir"]));
  const { CopilotClient, CopilotRequestHandler, RuntimeConnection } =
    await import(pathToFileURL(join(sdkDir, "index.js")).href);
  const config = JSON.parse(await readFile(expandHome(values.settings), "utf8")).lerna?.probe;
  assert(config, "Add a lerna.probe section to Copilot settings first");
  const allowedKeys = new Set(["model", "deployment", "endpoint", "keyEnv", "keyFile"]);
  assert(Object.keys(config).every(key => allowedKeys.has(key)), "Unknown probe setting; literal keys are not supported");
  assert(typeof config.model === "string" && /^[\w.-]+$/.test(config.model), "model must be a native model ID");
  const deployment = config.deployment ?? config.model;
  assert(typeof deployment === "string" && /^[\w.-]+$/.test(deployment), "Invalid deployment name");
  const endpoint = new URL(config.endpoint);
  assert(endpoint.protocol === "https:" && !endpoint.username && !endpoint.password
    && !endpoint.search && !endpoint.hash, "endpoint must be HTTPS without credentials, query, or fragment");
  assert(endpoint.pathname.endsWith("/responses"), "This probe requires a Responses API endpoint");
  assert(!endpoint.hostname.endsWith("githubcopilot.com"), "BYOK endpoint must not be a Copilot host");
  assert(Boolean(config.keyEnv) !== Boolean(config.keyFile), "Set exactly one of keyEnv or keyFile");
  let apiKey;
  if (config.keyEnv) {
    assert(typeof config.keyEnv === "string", "keyEnv must name an environment variable");
    apiKey = process.env[config.keyEnv];
  } else {
    assert(typeof config.keyFile === "string", "keyFile must be a path");
    const keyPath = expandHome(config.keyFile);
    const info = await stat(keyPath);
    assert(info.isFile(), "keyFile must be a regular file");
    if (process.platform !== "win32") {
      assert(info.uid === process.getuid() && (info.mode & 0o077) === 0, "keyFile must be owned by you and owner-only");
    }
    apiKey = (await readFile(keyPath, "utf8")).trim();
  }
  assert(typeof apiKey === "string" && apiKey.trim(), "The configured credential is empty or unavailable");
  credentials.push({ value: apiKey, origin: endpoint.origin });
  const copilotOrigin = "https://api.individual.githubcopilot.com";
  const selectionId = `lerna-probe/${config.model}`;
  const plannedModel = values["qualified-id"] ? selectionId : config.model;
  let planAccepted = false;

  class LernaProbe extends CopilotRequestHandler {
    async sendRequest(request, context) {
      let url = new URL(request.url);
      let body;
      if (request.method === "POST") body = await request.clone().json();

      if (planAccepted && url.origin === copilotOrigin
          && url.pathname === "/responses" && body?.model === config.model) {
        assert(!body.previous_response_id, "Cannot transfer Copilot server-side response state to Azure");
        request = new Request(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "api-key": apiKey },
          body: JSON.stringify({ ...body, model: deployment }),
          signal: request.signal,
          redirect: "error",
        });
        context = { ...context, url: endpoint.href, headers: Object.fromEntries(request.headers) };
        url = endpoint;
        log("byok.request", { model: config.model });
      }

      const outgoing = JSON.stringify({
        headers: Object.fromEntries(request.headers),
        body: request.method === "POST" ? await request.clone().json() : null,
      });
      for (const credential of credentials) {
        assert(url.origin === credential.origin || !outgoing.includes(credential.value),
          "Credential crossed its provider boundary; request blocked");
      }
      if (url.origin === copilotOrigin) {
        const authorization = request.headers.get("authorization");
        if (authorization) credentials.push({ value: authorization, origin: copilotOrigin });
      }
      const response = await super.sendRequest(request, context);
      if (url.origin === endpoint.origin) log("byok.response", { status: response.status });
      if (url.origin !== copilotOrigin || url.pathname !== "/model/fusion") return response;

      log("hydra.plan.request", { fields: Object.keys(body), fusionMode: body.fusion_mode });
      assert(response.ok, `Hydra planner returned HTTP ${response.status}`);
      const plan = await response.clone().json();
      assert(plan.plan_version === "1" && plan.fusion_mode === "hydrafusion-max",
        "Unrecognized Hydra plan contract");
      assert(plan.fusion_pattern === "solo" && Array.isArray(plan.steps) && plan.steps.length === 1
        && plan.steps[0].role === "generation", "Only solo generation plans are verified by this probe");
      assert(typeof plan.session?.token === "string" && plan.session.token, "Hydra plan session token is missing");
      credentials.push({ value: plan.session.token, origin: copilotOrigin });
      log("hydra.plan.adapted", { from: plan.steps[0].model_id, to: plannedModel });
      plan.steps[0].model_id = plannedModel;
      const headers = new Headers(response.headers);
      for (const name of ["content-length", "content-encoding", "transfer-encoding", "etag"]) headers.delete(name);
      return new Response(JSON.stringify(plan), { status: response.status, headers });
    }
  }

  const gitHubToken = execFileSync("gh", ["auth", "token"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000,
  }).trim();
  assert(gitHubToken, "gh must be authenticated");
  credentials.push({ value: gitHubToken, origin: copilotOrigin });
  directory = await mkdtemp(join(tmpdir(), "lerna-probe-"));
  const work = join(directory, "work");
  const home = join(directory, "home");
  await mkdir(work, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("COPILOT_PROVIDER_") || key === "COPILOT_AGENT_SESSION_ID"
        || key === "COPILOT_LOADER_PID" || key === "COPILOT_SDK_DEFAULT_CONNECTION"
        || key === config.keyEnv) delete env[key];
  }
  const runtime = join(dirname(sdkDir), "prebuilds", `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime");
  client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: runtime }),
    mode: "empty", baseDirectory: home, workingDirectory: work,
    gitHubToken, env, logLevel: "error", requestHandler: new LernaProbe(),
  });
  await client.start();
  assert((await client.getAuthStatus()).isAuthenticated, "Copilot authentication failed");
  session = await client.createSession({
    configDirectory: home, workingDirectory: work,
    enableExperimentalMode: true, availableTools: [],
    onPermissionRequest: async () => ({ kind: "denied-interactively-by-user" }),
    enableConfigDiscovery: false, enableFileHooks: false, enableSkills: false,
    enableSessionStore: false, enableSessionTelemetry: false, enableHostGitOperations: false,
    remoteSession: "off",
    systemMessage: { mode: "replace", content: "Answer the supplied generic question. Do not use tools." },
  });
  session.on(event => {
    if (!event.type.includes("fusion")) return;
    const data = event.data ?? {};
    const selected = ["routeSource", "pattern", "primaryModel", "fallbackModel", "model", "phaseKind", "status", "reason"];
    log(event.type, Object.fromEntries(selected.filter(key => key in data).map(key => [key, data[key]])));
    if (event.type === "session.fusion_resolved" && data.primaryModel === plannedModel) planAccepted = true;
  });
  await session.rpc.options.update({
    isExperimentalMode: true,
    featureFlags: { HYDRAFUSION: true, HYDRAFUSION_ROLLOUT: true },
  });
  await session.rpc.provider.add({
    providers: [{ name: "lerna-probe", type: "azure", wireApi: "responses",
      baseUrl: endpoint.href.slice(0, -"/responses".length), apiKey }],
    models: [{ provider: "lerna-probe", id: config.model, modelId: config.model, wireModel: deployment }],
  });
  const models = (await session.rpc.model.list()).list.map(model => model.id);
  assert(models.includes("hydrafusion") && models.includes(config.model) && models.includes(selectionId),
    "Hydra, the native model, and the registered BYOK model must all be selectable");
  log("models.registered", { native: config.model, byok: selectionId });
  await session.rpc.model.switchTo({ modelId: "hydrafusion", requireAvailable: true });
  assert.equal((await session.rpc.model.getCurrent()).modelId, "hydrafusion", "Hydra was not selected");
  await session.sendAndWait({
    prompt: "Which is larger, 9.8 or 9.11? Explain in one sentence. Do not use tools.",
  }, 90000);
  assert(planAccepted && events.some(e => e.kind === "byok.response" && e.status === 200)
    && events.some(e => e.kind === "assistant.fusion_phase_completed" && e.model === plannedModel && e.status === "succeeded")
    && events.some(e => e.kind === "session.fusion_completed")
    && !events.some(e => e.kind === "session.fusion_route_failed"), "Hydra BYOK execution was not verified");
  log("verified", { model: config.model });
} catch (error) {
  let message = error instanceof Error ? error.message : "Probe failed";
  for (const credential of credentials) message = message.replaceAll(credential.value, "[redacted]");
  console.error(message);
  process.exitCode = 1;
} finally {
  try {
    if (session) await session.disconnect();
  } finally {
    try { if (client) await client.stop(); }
    finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      clearTimeout(deadline);
    }
  }
}
