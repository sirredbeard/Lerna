import { CopilotClient, CopilotRequestHandler } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Bridge, requestSessionId } from "./bridge.mjs";
import { ensureBinary } from "./install.mjs";
import { configure } from "./setup.mjs";

const manifest = JSON.parse(await readFile(new URL("../../plugin.json", import.meta.url), "utf8"));
const capiHosts = new Set([
  "api.individual.githubcopilot.com", "api.business.githubcopilot.com",
  "api.enterprise.githubcopilot.com", "api.githubcopilot.com",
]);
let bridge;
let session;
let ready;
let status = { configured: false, enabled: false };
let eventQueue = Promise.resolve();
let configuring = false;
const attached = Promise.withResolvers();

async function setup(action) {
  if (configuring) return;
  configuring = true;
  try {
    await ready;
    if (!bridge) throw new Error("Lerna could not start. Check the extension log, then reload the plugin.");
    status = await configure(session, bridge, action) || await bridge.invoke("status");
  } catch (error) {
    await session.log(error.message, { level: "warning" });
  } finally { configuring = false; }
}

class Handler extends CopilotRequestHandler {
  async openWebSocket(context) {
    const url = new URL(context.url);
    // In 1.0.83, declining the upgrade selects native HTTP/SSE fallback.
    if (capiHosts.has(url.hostname) && url.pathname === "/responses") {
      throw new Error("Lerna uses HTTP streaming for Copilot Responses.");
    }
    return super.openWebSocket(context);
  }

  async sendRequest(request, context) {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || !capiHosts.has(url.hostname)
        || !["/model/fusion", "/responses"].includes(url.pathname)) {
      return super.sendRequest(request, context);
    }
    await attached.promise;
    await ready;
    const sessionId = requestSessionId(request, context, session.sessionId);
    if (!bridge || sessionId !== session.sessionId || !status.enabled) {
      return super.sendRequest(request, context);
    }
    await eventQueue;
    return bridge.forward(request, { ...context, sessionId });
  }
}

const commands = [{ name: "lerna", description: "Sign into Azure and configure Lerna.", handler: context => setup(context.args.trim()) }];
const sdk = process.env.COPILOT_SDK_PATH;
const version = sdk ? JSON.parse(await readFile(join(dirname(sdk), "package.json"), "utf8")).version : undefined;
const compatible = version === "1.0.83";

if (compatible) {
  // 1.0.83 only accepts the interceptor in the initial connection handshake.
  const client = new CopilotClient({
    _internalConnection: { kind: "parent-process" },
    requestHandler: new Handler(),
  });
  await client.start();
  const send = client.connection.sendRequest.bind(client.connection);
  // Lerna has no permission hook. Match joinSession's permission-neutral contract.
  client.connection.sendRequest = (method, params, ...rest) =>
    send(method, method === "session.resume" ? { ...params, requestPermission: false } : params, ...rest);
  try {
    session = await client.resumeSessionForExtension(process.env.SESSION_ID, {
      suppressResumeEvent: true, commands,
    });
  } finally { client.connection.sendRequest = send; }
} else {
  session = await joinSession({ commands });
}

const forwarded = new Set([
  "session.fusion_resolved", "assistant.fusion_phase_started", "assistant.fusion_phase_completed",
  "assistant.fusion_phase_failed", "session.fusion_route_failed", "session.fusion_completed", "session.model_change",
]);
session.on(event => {
  if (!bridge || !forwarded.has(event.type)) return;
  console.error(JSON.stringify({ event: event.type }));
  const data = event.data || {};
  const keys = ["fusionId", "primaryModel", "model", "phaseKind", "status"];
  eventQueue = eventQueue.then(() => bridge.invoke("event", {
    sessionId: session.sessionId, event: event.type,
    data: Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key]])),
  }));
  eventQueue.catch(() => { status = { ...status, enabled: false }; });
});

ready = (async () => {
  try {
    bridge = new Bridge(await ensureBinary(manifest.version), ["serve"], {
      onResponse: response => console.error(JSON.stringify({ event: "lerna.response", ...response })),
    });
    status = await bridge.invoke("status");
    await bridge.invoke("attach", { sessionId: session.sessionId });
    process.once("exit", () => bridge?.close());
    process.once("SIGTERM", () => { bridge?.close(); process.exit(0); });
    process.once("SIGINT", () => { bridge?.close(); process.exit(0); });
    console.error(`Lerna ${manifest.version} ready; interception ${compatible && status.enabled ? "enabled" : "inactive"}.`);
    if (!compatible) {
      await session.log("Lerna can configure Azure, but this build only intercepts Copilot CLI 1.0.83.", { level: "warning" });
    }
  } catch (error) {
    bridge?.close();
    bridge = undefined;
    status = { configured: false, enabled: false };
    await session.log(error.message, { level: "warning" });
  }
})();
attached.resolve();
await ready;
if (bridge && !status.configured) {
  if (session.capabilities.ui?.elicitation) setImmediate(() => { void setup("setup"); });
  else await session.log("Run /lerna in an interactive session to sign into Azure.");
}
