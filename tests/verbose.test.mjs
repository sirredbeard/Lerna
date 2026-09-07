import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createVerboseReporter, startupAnnouncement } from "../integration/extensions/lerna/verbose.mjs";

function fixture({ enabled = true } = {}) {
  const logs = [];
  let clock = 1_000;
  let active = enabled;
  const reporter = createVerboseReporter({
    log: async (message, options) => logs.push({ message, options }),
    isEnabled: () => active,
    cwd: "/repo",
    now: () => clock,
  });
  return {
    logs,
    reporter,
    tick: milliseconds => { clock += milliseconds; },
    enable: value => { active = value; },
  };
}

const event = (type, data = {}, extra = {}) => ({ type, data, ...extra });

test("startup announcement is a single line summarising routed models", () => {
  const line = startupAnnouncement({ models: ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "claude-opus-5", "grok-4.6"], verbose: true });
  assert.equal(line, "⎇ **Lerna** loaded: 5 HydraFusion models routed (gpt-5.6-sol, gpt-5.6-luna, gpt-5.6-terra, claude-opus-5, grok-4.6). Verbose on.");
  assert.doesNotMatch(line, /\n/);
  assert.match(startupAnnouncement({ models: [], verbose: false }), /no HydraFusion routes configured yet.*Verbose off/);
  assert.match(startupAnnouncement({ model: "gpt-5.6-sol", deployment: "sol-deploy", verbose: true }), /gpt-5\.6-sol routed through sol-deploy\. Verbose on\./);
});

test("extension subscribes to subagent events used by verbose reporting", async () => {
  const source = await readFile(new URL("../integration/extensions/lerna/extension.mjs", import.meta.url), "utf8");
  assert.match(source, /includeSubAgentStreamingEvents:\s*true/);
  assert.match(source, /"\/v1\/messages"/, "Anthropic model requests must be intercepted for Foundry routing");
  assert.doesNotMatch(source, /console\.error\(JSON\.stringify\(\{ event:/, "temporary per-event diagnostics must not remain enabled");
});

test("reports HydraFusion routing, phase progress, and persistent completions", async () => {
  const { logs, reporter, tick } = fixture();
  await reporter.handle(event("session.fusion_resolved", {
    pattern: "review", primaryModel: "gpt-5.6-sol", secondaryModel: "claude-opus-5",
  }));
  await reporter.handle(event("assistant.fusion_phase_started", {
    phaseId: "p1", phaseKind: "solver", role: "implementation", model: "gpt-5.6-sol",
  }));
  tick(2_100);
  await reporter.handle(event("assistant.streaming_delta", { totalResponseSizeBytes: 4096 }));
  await reporter.handle(event("assistant.fusion_phase_completed", {
    phaseId: "p1", phaseKind: "solver", role: "implementation", model: "gpt-5.6-sol",
    durationMs: 2500, usage: { inputTokens: 1200, outputTokens: 345, cachedTokens: 800, totalNanoAiu: 5_267_100_000 },
  }));

  assert.match(logs[0].message, /primary Sol, reviewer Opus 5/);
  assert.equal(logs[0].options.ephemeral, false);
  assert.match(logs[1].message, /started solver \(implementation\) on Sol/);
  assert.equal(logs[1].options.ephemeral, false);
  assert.match(logs[2].message, /Sol is streaming, 4 KiB received/);
  assert.match(logs[3].message, /1\.2K input, 345 output, 800 cached, 5\.27 AIC/);
  assert.match(logs[3].message, /^⎇ \*\*Lerna\*\* /);
  assert.equal(logs[3].options.ephemeral, false);
});

test("streams reasoning deltas while a HydraFusion phase is active", async () => {
  const { logs, reporter } = fixture();
  await reporter.handle(event("assistant.fusion_phase_started", {
    phaseId: "p1", phaseKind: "solver", model: "gpt-5.6-sol",
  }));
  await reporter.handle(event("assistant.reasoning_delta", { deltaContent: "Inspecting " }));
  await reporter.handle(event("assistant.reasoning_delta", { deltaContent: "the configuration." }));
  await reporter.handle(event("assistant.reasoning", { content: "Inspecting the configuration." }));

  assert.equal(logs[1].message, "⎇ **Lerna · Reasoning** Sol · Inspecting");
  assert.equal(logs[1].options.ephemeral, true);
  assert.equal(logs[2].message, "⎇ **Lerna · Reasoning** Sol · Inspecting the configuration.");
  assert.equal(logs[3].message, "⎇ **Lerna · Reasoning** Sol · Inspecting the configuration.");
  assert.equal(logs[3].options.ephemeral, false);
});

test("reports the safe reason for a failed Hydra phase", async () => {
  const { logs, reporter } = fixture();
  await reporter.handle(event("assistant.fusion_phase_failed", {
    phaseId: "p1", phaseKind: "primary", role: "solver", model: "mai-code-1.1-flash",
    durationMs: 1652, reason: "model_call", errorMessage: "fusion model call failed: Execution failed: 400 ",
    degradedToPhaseId: "repair",
  }));

  assert.match(logs[0].message, /mai-code-1\.1-flash failed after 1\.7s \(HTTP 400\); continuing with a fallback phase/);
  assert.equal(logs[0].options.level, "warning");
});

test("reports root Hydra tools immediately", async () => {
  const { logs, reporter } = fixture();
  await reporter.handle(event("tool.execution_start", {
    toolCallId: "fusion", toolName: "view", arguments: { path: "/repo/src/app.mjs" },
    fusion: { sourceModel: "gpt-5.6-terra", phaseKind: "solver", role: "implementation" },
  }));
  await reporter.handle(event("tool.execution_complete", {
    toolCallId: "fusion", success: true, toolTelemetry: { fileCount: 1 },
  }));

  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, "⎇ **Lerna · Read** Terra · `src/app.mjs`");
  await reporter.drain();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].options.ephemeral, false, "tool activity must persist in the transcript");
});

test("reports every rapid root Hydra tool as it starts", async () => {
  const { logs, reporter } = fixture();
  await reporter.handle(event("session.fusion_resolved", {
    pattern: "cascade", primaryModel: "gpt-5.6-luna", secondaryModel: "gpt-5.6-sol",
  }));
  await reporter.handle(event("assistant.fusion_phase_started", {
    phaseId: "p1", phaseKind: "solver", role: "primary", model: "gpt-5.6-luna",
  }));
  for (const [index, pattern] of ["alpha", "beta", "gamma", "delta"].entries()) {
    await reporter.handle(event("tool.execution_start", {
      toolCallId: `root-${index}`, toolName: "grep", model: "gpt-5.6-luna",
      arguments: { pattern, path: "/repo/src" },
    }));
    await reporter.handle(event("tool.execution_complete", {
      toolCallId: `root-${index}`, success: true, model: "gpt-5.6-luna",
    }));
  }

  assert.equal(logs.length, 6);
  assert.deepEqual(
    logs.slice(2).map(item => item.message),
    ["alpha", "beta", "gamma", "delta"].map(pattern => `⎇ **Lerna · Search** Luna · \`${pattern}\` in \`src\``),
  );
  await reporter.drain();
  assert.equal(logs.length, 6);
});

test("reports useful commands without intent or partial output", async () => {
  const { logs, reporter, tick } = fixture();
  await reporter.handle(event("session.fusion_route_started"));
  await reporter.handle(event("assistant.intent", { intent: "Call https://example.test/a?token=secret#frag with api_key=supersecret" }));
  await reporter.handle(event("tool.execution_start", {
    toolCallId: "t1", toolName: "bash", arguments: { command: "npm test -- --api-key=supersecret" },
    fusion: { sourceModel: "gpt-5.6-luna" },
  }));
  await reporter.handle(event("tool.execution_partial_result", { toolCallId: "t1", partialOutput: "TOP-SECRET-CONTENT" }));
  tick(2_100);
  await reporter.handle(event("tool.execution_partial_result", { toolCallId: "t1", partialOutput: "STILL-SECRET" }));
  await reporter.drain();

  const text = logs.map(log => log.message).join("\n");
  assert.equal(logs.length, 2);
  assert.match(text, /selecting a route/);
  assert.match(text, /\*\*Lerna · Shell\*\* Luna · npm test -- --api-key=\[redacted\]/);
  assert.doesNotMatch(text, /example|TOP-SECRET|STILL-SECRET|supersecret/);
});

test("reports concise subagent activity with the actual files and searches", async () => {
  const { logs, reporter, tick } = fixture();
  await reporter.handle(event("session.fusion_route_started"));
  await reporter.handle(event("subagent.started", { agentDisplayName: "Search Subagent" }, { agentId: "agent-1" }));
  const tools = [
    ["read_file", { filePath: "/repo/src/one.mjs" }],
    ["read_file", JSON.stringify({ path: "/repo/src/two.mjs" })],
    ["grep_search", { query: "createVerboseReporter", paths: ["/repo/integration"] }],
    ["file_search", { pattern: "**/*.test.mjs", path: "/repo/tests" }],
  ];
  for (const [index, [toolName, argumentsValue]] of tools.entries()) {
    await reporter.handle(event("tool.execution_start", {
      toolCallId: `tool-${index}`, toolName, arguments: argumentsValue,
    }, { agentId: "agent-1" }));
    tick(25);
    await reporter.handle(event("tool.execution_complete", {
      toolCallId: `tool-${index}`, success: true,
    }, { agentId: "agent-1" }));
  }
  await reporter.handle(event("subagent.completed", {
    agentDisplayName: "Search Subagent", durationMs: 500,
  }, { agentId: "agent-1" }));

  assert.equal(logs.length, 7);
  assert.deepEqual(logs.slice(2, 6).map(item => item.message), [
    "⎇ **Lerna · Search Subagent** `src/one.mjs`",
    "⎇ **Lerna · Search Subagent** `src/two.mjs`",
    "⎇ **Lerna · Search Subagent** `createVerboseReporter` in `integration`",
    "⎇ **Lerna · Search Subagent** `**/*.test.mjs` in `tests`",
  ]);
  assert.match(logs.at(-1).message, /Search Subagent completed in 500ms, 2 reads, 2 searches/);
});

test("bounds duplicate subagent searches and removes prompt-like query tails", async () => {
  const { logs, reporter } = fixture();
  await reporter.handle(event("session.fusion_route_started"));
  await reporter.handle(event("subagent.started", { agentDisplayName: "Search Subagent" }, { agentId: "agent-1" }));
  const patterns = [
    "request body|request body =|RequestBody ; keep track of everything in the user prompt",
    "request body|request body =|RequestBody ; keep track of everything in the user prompt",
    "gpt-5\\.6-luna", "input\\[.*\\]\\.id", "HTTP 400", "OpenAI Responses",
  ];
  for (const [index, pattern] of patterns.entries()) {
    await reporter.handle(event("tool.execution_start", {
      toolCallId: `search-${index}`, toolName: "grep_search", arguments: { query: pattern },
    }, { agentId: "agent-1" }));
    await reporter.handle(event("tool.execution_complete", {
      toolCallId: `search-${index}`, success: true,
    }, { agentId: "agent-1" }));
  }
  await reporter.handle(event("subagent.completed", {
    agentDisplayName: "Search Subagent", durationMs: 300,
  }, { agentId: "agent-1" }));

  assert.deepEqual(logs.slice(2, -1).map(item => item.message), [
    "⎇ **Lerna · Search Subagent** `request body|request body =|RequestBody`",
    "⎇ **Lerna · Search Subagent** `gpt-5\\.6-luna`",
    "⎇ **Lerna · Search Subagent** `input\\[.*\\]\\.id`",
    "⎇ **Lerna · Search Subagent** `HTTP 400`",
  ]);
  assert.match(logs.at(-1).message, /6 searches/);
  assert.doesNotMatch(logs.map(item => item.message).join("\n"), /keep track|OpenAI Responses/);
});

test("suppresses detail-free subagent noise but retains a concise failure", async () => {
  const { logs, reporter } = fixture();
  await reporter.handle(event("session.fusion_route_started"));
  await reporter.handle(event("subagent.started", { agentDisplayName: "Search Subagent" }, { agentId: "agent-1" }));
  for (const [index, [toolName, success]] of [["read_file", true], ["file_search", true], ["read_file", false]].entries()) {
    await reporter.handle(event("tool.execution_start", {
      toolCallId: `generic-${index}`, toolName,
    }, { agentId: "agent-1" }));
    await reporter.handle(event("tool.execution_complete", {
      toolCallId: `generic-${index}`, success,
    }, { agentId: "agent-1" }));
  }
  await reporter.handle(event("subagent.completed", {
    agentDisplayName: "Search Subagent", durationMs: 250,
  }, { agentId: "agent-1" }));

  assert.deepEqual(logs.map(item => item.message), [
    "⎇ **Lerna · Route** HydraFusion is selecting a route.",
    "⎇ **Lerna** Subagent: Search Subagent started.",
    "⎇ **Lerna · Search Subagent** read failed.",
    "⎇ **Lerna** Subagent: Search Subagent completed in 250ms, 2 reads, 1 search, 1 failure.",
  ]);
  assert.equal(logs[2].options.level, "warning");
});

test("reports MCP server, tool, and query details", async () => {
  const { logs, reporter } = fixture();
  await reporter.handle(event("tool.execution_start", {
    toolCallId: "mcp-1", toolName: "mcp", mcpServerName: "github-mcp-server",
    mcpToolName: "search_code", arguments: JSON.stringify({ query: "requestSessionId" }),
    fusion: { sourceModel: "gpt-5.6-sol" },
  }));

  assert.equal(logs[0].message,
    "⎇ **Lerna · search_code** Sol · github-mcp-server · search_code · requestSessionId");
});

test("reports subagents and skills while fusion is active", async () => {
  const { logs, reporter } = fixture();
  await reporter.handle(event("session.fusion_route_started"));
  await reporter.handle(event("subagent.started", { agentDisplayName: "Code review", model: "claude-opus-5", executionMode: "background" }));
  await reporter.handle(event("skill.invoked", { name: "routing" }));
  await reporter.handle(event("subagent.failed", { agentDisplayName: "Code review" }));

  assert.match(logs[1].message, /Code review started on Opus 5 in background mode/);
  assert.match(logs[2].message, /Skill: routing invoked/);
  assert.equal(logs[3].options.level, "warning");
  assert.equal(logs[3].options.ephemeral, false);
});

test("disabling clears stale tool state and suppresses later events", async () => {
  const { logs, reporter, enable } = fixture();
  await reporter.handle(event("tool.execution_start", {
    toolCallId: "t1", toolName: "view", fusion: { sourceModel: "gpt-5.6-sol" },
  }));
  enable(false);
  await reporter.handle(event("assistant.intent", { intent: "hidden" }));
  enable(true);
  await reporter.handle(event("tool.execution_complete", { toolCallId: "t1", success: true }));

  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /\*\*Lerna · Read\*\* Sol · view/);
});

test("reports confirmed Azure routing without successful HTTP status noise", async () => {
  const { logs, reporter } = fixture();
  await reporter.reportResponse({ status: 200, via: "byok", adaptedModel: "claude-opus-5" });
  await reporter.reportResponse({ status: 429, via: "byok", adaptedModel: "gpt-5.6-sol" });
  await reporter.reportResponse({ status: 200, via: "copilot", adaptedModel: "mai-code-1.1-flash" });

  assert.deepEqual(logs, [{
    message: "⎇ **Lerna · Route** Opus 5 → Azure Foundry",
    options: { ephemeral: false, level: "info" },
  }, {
    message: "⎇ **Lerna · Route** Sol → Azure Foundry · HTTP 429",
    options: { ephemeral: false, level: "warning" },
  }]);
});
