import { CopilotClient, CopilotRequestHandler } from "@github/copilot-sdk";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Bridge, requestSessionId, shouldBypassLerna } from "./bridge.mjs";
import { ensureBinary } from "./install.mjs";
import { configure, ensureHydraFusion } from "./setup.mjs";
import { createVerboseReporter, startupAnnouncement } from "./verbose.mjs";

const manifest = JSON.parse(await readFile(new URL("../../plugin.json", import.meta.url), "utf8"));
const capiHosts = new Set([
  "api.individual.githubcopilot.com", "api.business.githubcopilot.com",
  "api.enterprise.githubcopilot.com", "api.githubcopilot.com",
]);
let bridge;
let client;
let session;
let ready;
let status = { configured: false, enabled: false, verbose: true };
let eventQueue = Promise.resolve();
let verboseReporter;
let configuring = false;
const attached = Promise.withResolvers();

async function setup(action) {
  if (configuring) return;
  configuring = true;
  try {
    await ready;
    if (!bridge) throw new Error("Lerna could not start. Check the extension log, then reload the plugin.");
    status = await configure(session, bridge, action) || await bridge.invoke("status");
    if (!status.verbose) verboseReporter?.reset();
  } catch (error) {
    await session.log(error.message, { level: "warning" });
  } finally { configuring = false; }
}

class Handler extends CopilotRequestHandler {
  async openWebSocket(context) {
    const url = new URL(context.url);
    // Declining the upgrade selects native HTTP/SSE fallback.
    if (capiHosts.has(url.hostname) && ["/responses", "/v1/messages"].includes(url.pathname)) {
      throw new Error("Lerna uses HTTP streaming for Copilot model responses.");
    }
    return super.openWebSocket(context);
  }

  async sendRequest(request, context) {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || !capiHosts.has(url.hostname)
        || !["/model/fusion", "/responses", "/v1/messages"].includes(url.pathname)) {
      return super.sendRequest(request, context);
    }
    await attached.promise;
    await ready;
    const sessionId = requestSessionId(request, context, session.sessionId);
    if (!bridge || sessionId !== session.sessionId || !status.enabled || await shouldBypassLerna(request)) {
      return super.sendRequest(request, context);
    }
    await eventQueue;
    return bridge.forward(request, { ...context, sessionId });
  }
}

const commands = [{
  name: "lerna",
  description: "Manage HydraFusion verbosity and routing.",
  handler: context => setup(context.args.trim()),
}];
const sdk = process.env.COPILOT_SDK_PATH;
const version = sdk ? JSON.parse(await readFile(join(dirname(sdk), "package.json"), "utf8")).version : undefined;

async function resumeSession(activeClient) {
  await activeClient.start();
  const send = activeClient.connection.sendRequest.bind(activeClient.connection);
  activeClient.connection.sendRequest = (method, params, ...rest) =>
    send(method, method === "session.resume" ? { ...params, requestPermission: false } : params, ...rest);
  try {
    return await activeClient.resumeSessionForExtension(process.env.SESSION_ID, {
      suppressResumeEvent: true, streaming: true, includeSubAgentStreamingEvents: true, commands,
    });
  } finally { activeClient.connection.sendRequest = send; }
}

// Try the interceptor on the installed Copilot CLI. The attach handshake is the
// compatibility check, so a new CLI version can work without a hard-coded gate.
let interceptionActive = true;
client = new CopilotClient({
  _internalConnection: { kind: "parent-process" },
  requestHandler: new Handler(),
});
try {
  session = await resumeSession(client);
} catch (error) {
  interceptionActive = false;
  console.error(`Lerna could not attach live routing in this process (${error.message}); continuing without it.`);
  client = new CopilotClient({ _internalConnection: { kind: "parent-process" } });
  session = await resumeSession(client);
}

const forwarded = new Set([
  "session.fusion_resolved", "assistant.fusion_phase_started", "assistant.fusion_phase_completed",
  "assistant.fusion_phase_failed", "session.fusion_route_failed", "session.fusion_completed", "session.model_change",
]);
verboseReporter = createVerboseReporter({
  log: (message, options) => session.log(message, options),
  isEnabled: () => status.verbose === true,
});
session.on(event => {
  void verboseReporter.handle(event).catch(() => {});
  if (!bridge || !forwarded.has(event.type)) return;
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
      onResponse: response => {
        void verboseReporter?.reportResponse(response).catch(() => {});
      },
    });
    status = await bridge.invoke("status");
    await bridge.invoke("attach", { sessionId: session.sessionId });
    await ensureHydraFusion(session, client.rpc.user.settings);
    await session.log(startupAnnouncement(status), { ephemeral: false, level: "info" });
    process.once("exit", () => bridge?.close());
    process.once("SIGTERM", () => { bridge?.close(); process.exit(0); });
    process.once("SIGINT", () => { bridge?.close(); process.exit(0); });
    console.error(`Lerna ${manifest.version} ready; interception ${interceptionActive && status.enabled ? "enabled" : "inactive"}.`);
    if (!interceptionActive) {
      await session.log(
        `Lerna is active, but live routing could not attach to Copilot CLI${version ? ` ${version}` : ""} in this session. Resume with \`copilot --session-id=<id>\` instead of \`--resume\` to keep routing.`,
        { level: "warning" },
      );
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
  await session.log("Lerna has no HydraFusion routes configured. Run /lerna for status and setup options.");
}
