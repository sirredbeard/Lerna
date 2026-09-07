import { isAbsolute, relative, resolve } from "node:path";

/// Single-line startup line. Verbose is on by default, so the announcement reports the routing
/// that is live rather than telling the user to turn anything on.
export function startupAnnouncement(status = {}) {
  const models = Array.isArray(status.models) ? status.models.filter(Boolean) : [];
  const routes = models.length
    ? `${models.length} HydraFusion model${models.length === 1 ? "" : "s"} routed (${models.join(", ")})`
    : status.model || status.deployment
      ? `${status.model || "HydraFusion"} routed through ${status.deployment || "the configured deployment"}`
      : "no HydraFusion routes configured yet, run /lerna";
  return `⎇ **Lerna** loaded: ${routes}. Verbose ${status.verbose === false ? "off, run /lerna verbose on" : "on"}.`;
}

const maxTrackedTools = 256;
const secretPattern = /\b(?:github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|sk-(?:ant-)?[A-Za-z0-9_-]{8,})\b/g;
const assignedSecretPattern = /\b(authorization|api[-_ ]?key|access[-_ ]?token|password)\s*[:=]\s*\S+/gi;

function clean(value, length = 160) {
  let text = String(value ?? "").replace(/[\r\n\t\0-\x1f\x7f]+/g, " ").trim();
  text = text.replace(secretPattern, "[redacted]").replace(assignedSecretPattern, "$1=[redacted]");
  text = text.replace(/https?:\/\/[^\s]+/gi, raw => {
    try {
      const url = new URL(raw);
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch { return "[url]"; }
  });
  return text.slice(0, length);
}

function durationText(milliseconds) {
  const value = Math.max(0, Number(milliseconds) || 0);
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function bytesText(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KiB`;
  return `${value} B`;
}

function tokensText(tokens) {
  const value = Math.max(0, Number(tokens) || 0);
  return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
}

function aiCreditText(usage = {}) {
  const nano = Number(usage.totalNanoAiu ?? usage.totalNanoAiUnits ?? 0);
  if (!Number.isFinite(nano) || nano <= 0) return "";
  const credits = nano / 1_000_000_000;
  return `${credits.toFixed(credits >= 10 ? 1 : 2).replace(/\.0+$/, "")} AIC`;
}

function modelText(model) {
  const aliases = {
    "gpt-5.6-sol": "Sol",
    "gpt-5.6-terra": "Terra",
    "gpt-5.6-luna": "Luna",
    "claude-opus-5": "Opus 5",
  };
  return aliases[model] || clean(model, 70) || "The selected model";
}

function safePath(value, cwd) {
  if (typeof value !== "string" || !value.trim()) return null;
  const absolute = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  const local = relative(cwd, absolute).replaceAll("\\", "/");
  if (local === "") return ".";
  if (local === ".." || local.startsWith("../") || isAbsolute(local)) return null;
  return clean(local, 100);
}

function toolArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function argumentPaths(argumentsValue, cwd) {
  const args = toolArguments(argumentsValue);
  const values = [];
  for (const key of ["path", "file", "filePath", "directory", "cwd"]) {
    if (typeof args[key] === "string") values.push(args[key]);
  }
  if (typeof args.paths === "string") values.push(args.paths);
  if (Array.isArray(args.paths)) values.push(...args.paths.filter(value => typeof value === "string"));
  return [...new Set(values.map(value => safePath(value, cwd)).filter(Boolean))].slice(0, 2);
}

function firstText(args, keys, length = 120) {
  for (const key of keys) {
    if (typeof args[key] === "string" && args[key].trim()) return clean(args[key], length);
  }
  return "";
}

function searchText(args, keys) {
  const value = firstText(args, keys, 200).split(/\s*;\s+(?=[A-Za-z])/)[0];
  const alternatives = value.split("|");
  const compact = alternatives.length > 4 ? `${alternatives.slice(0, 4).join("|")}|…` : value;
  return clean(compact, 72);
}

function baseToolName(data) {
  const raw = clean(data.mcpToolName || data.toolName || "tool", 90);
  return raw.includes(".") ? raw.split(".").at(-1) : raw;
}

function summarizeTool(data, cwd) {
  const name = baseToolName(data);
  const args = toolArguments(data.arguments);
  const paths = argumentPaths(args, cwd);
  const pathText = paths.map(path => `\`${path}\``).join(", ");
  const shortName = name.toLowerCase();

  if (data.mcpServerName) {
    const query = searchText(args, ["query", "prompt", "search", "path", "url", "name"]);
    return { name, item: [clean(data.mcpServerName, 60), name, query].filter(Boolean).join(" · ") };
  }
  if (["grep", "grep_search"].includes(shortName)) {
    const pattern = searchText(args, ["pattern", "query", "searchTerm"]);
    return { name, item: `${pattern ? `\`${pattern}\`` : "search"}${pathText ? ` in ${pathText}` : ""}` };
  }
  if (["glob", "file_search"].includes(shortName)) {
    const pattern = searchText(args, ["pattern", "query", "glob"]);
    return { name, item: `${pattern ? `\`${pattern}\`` : "files"}${pathText ? ` in ${pathText}` : ""}` };
  }
  if (["view", "read_file", "edit", "create", "write_file", "apply_patch"].includes(shortName)) {
    return { name, item: pathText || firstText(args, ["path", "file", "filePath"], 120) || name };
  }
  if (["bash", "powershell", "run_in_terminal"].includes(shortName)) {
    return { name, item: firstText(args, ["command", "script"], 180) || name };
  }
  if (shortName === "search_code_subagent") {
    return { name, item: searchText(args, ["query", "details"]) || "code search" };
  }
  if (shortName === "web_search") {
    return { name, item: searchText(args, ["query"]) || "web search" };
  }
  if (shortName === "web_fetch") {
    const url = firstText(args, ["url"], 180);
    try { return { name, item: new URL(url).hostname }; }
    catch { return { name, item: url || "web request" }; }
  }
  const detail = firstText(args, ["query", "prompt", "pattern", "command", "path", "name"], 140);
  return { name, item: detail || name };
}

function toolCategory(name) {
  const value = String(name || "").toLowerCase();
  if (["read_file", "view"].includes(value)) return "read";
  if (["grep_search", "file_search", "grep", "glob", "search_code_subagent"].includes(value)) return "search";
  if (["edit", "create", "write_file", "apply_patch"].includes(value)) return "change";
  if (["bash", "powershell", "run_in_terminal"].includes(value)) return "command";
  return "tool call";
}

function toolLabel(name) {
  return {
    read: "Read", search: "Search", change: "Edit", command: "Shell", "tool call": clean(name, 40),
  }[toolCategory(name)];
}

function compactCounts(counts) {
  const labels = {
    read: ["read", "reads"], search: ["search", "searches"], change: ["change", "changes"],
    command: ["command", "commands"], "tool call": ["other tool call", "other tool calls"], failure: ["failure", "failures"],
  };
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${count} ${labels[name]?.[count === 1 ? 0 : 1] || name}`)
    .join(", ");
}

function phaseFailureDetail(data) {
  const message = clean(data.errorMessage, 180);
  const status = message.match(/\b([45]\d\d)\b/)?.[1];
  if (status) return `HTTP ${status}`;
  const reason = clean(data.reason, 60).replaceAll("_", " ");
  return reason || message;
}

function phaseText(data) {
  const kind = clean(data.phaseKind || "phase", 50);
  const role = clean(data.role, 50);
  return role && role !== kind ? `${kind} (${role})` : kind;
}

function routeText(data) {
  const pattern = clean(data.pattern || "route", 40);
  const primary = modelText(data.primaryModel);
  const secondary = data.secondaryModel ? `, reviewer ${modelText(data.secondaryModel)}` : "";
  const fallback = data.fallbackModel ? `, fallback ${modelText(data.fallbackModel)}` : "";
  return `HydraFusion route: ${pattern}, primary ${primary}${secondary}${fallback}.`;
}

export function createVerboseReporter({
  log, isEnabled, cwd = process.cwd(), now = Date.now,
}) {
  const tools = new Map();
  const subagentTools = new Map();
  const subagentVisible = new Map();
  const subagents = new Map();
  let activeFusion = false;
  let activePhase = null;
  let reasoning = "";
  let queue = Promise.resolve();

  function reset() {
    tools.clear();
    subagentTools.clear();
    subagentVisible.clear();
    subagents.clear();
    activeFusion = false;
    activePhase = null;
    reasoning = "";
  }

  function emit(message, { ephemeral = true, level = "info", label } = {}) {
    if (!isEnabled() || !message) return Promise.resolve();
    const heading = label ? `Lerna · ${label}` : "Lerna";
    const task = queue.then(() => log(`⎇ **${heading}** ${message}`, { ephemeral, level }));
    queue = task.catch(() => {});
    return task;
  }

  function toolActor(event, data) {
    const subagent = event.agentId ? subagents.get(event.agentId) : null;
    if (subagent?.name) return subagent.name;
    const sourceModel = data.fusion?.sourceModel || data.model;
    if (sourceModel) return modelText(sourceModel);
    return activePhase?.model || (event.agentId ? "Subagent" : "HydraFusion");
  }

  function trimTools() {
    while (tools.size > maxTrackedTools) tools.delete(tools.keys().next().value);
  }

  async function handle(event) {
    if (!isEnabled()) {
      reset();
      return;
    }
    const data = event?.data || {};
    switch (event?.type) {
      case "session.fusion_route_started":
        activeFusion = true;
        await emit("HydraFusion is selecting a route.", { label: "Route" });
        break;
      case "session.fusion_resolved":
        activeFusion = true;
        await emit(routeText(data), { ephemeral: false, label: "Route" });
        break;
      case "session.fusion_route_failed":
        activeFusion = false;
        activePhase = null;
        await emit(`HydraFusion routing failed${data.fallbackModel ? `; falling back to ${modelText(data.fallbackModel)}` : ""}.`, { ephemeral: false, level: "warning", label: "Route" });
        break;
      case "assistant.fusion_phase_started":
        activeFusion = true;
        reasoning = "";
        activePhase = { id: data.phaseId, text: phaseText(data), model: modelText(data.model), lastBytesAt: 0 };
        await emit(`HydraFusion started ${activePhase.text} on ${activePhase.model}.`, { ephemeral: false, label: "Phase" });
        break;
      case "assistant.reasoning_delta": {
        if (!activeFusion || typeof data.deltaContent !== "string" || !data.deltaContent) break;
        reasoning = `${reasoning}${data.deltaContent}`.slice(-4000);
        const text = clean(reasoning.slice(-1200), 1200);
        if (text) await emit(`${activePhase?.model || "HydraFusion"} · ${text}`, { label: "Reasoning" });
        break;
      }
      case "assistant.reasoning": {
        if (!activeFusion) break;
        const text = clean(data.content || reasoning, 2000);
        if (text) await emit(`${activePhase?.model || "HydraFusion"} · ${text}`, { ephemeral: false, label: "Reasoning" });
        reasoning = "";
        break;
      }
      case "assistant.streaming_delta":
        if (activePhase && now() - activePhase.lastBytesAt >= 2000) {
          activePhase.lastBytesAt = now();
          await emit(`${activePhase.model} is streaming, ${bytesText(data.totalResponseSizeBytes)} received.`);
        }
        break;
      case "assistant.fusion_phase_completed": {
        const usage = data.usage || {};
        const cache = Number(usage.cachedTokens || 0) ? `, ${tokensText(usage.cachedTokens)} cached` : "";
        const aiCredits = aiCreditText(usage);
        await emit(`HydraFusion completed ${phaseText(data)} on ${modelText(data.model)} in ${durationText(data.durationMs)}: ${tokensText(usage.inputTokens)} input, ${tokensText(usage.outputTokens)} output${cache}${aiCredits ? `, ${aiCredits}` : ""}.`, { ephemeral: false });
        if (!activePhase?.id || activePhase.id === data.phaseId) activePhase = null;
        reasoning = "";
        break;
      }
      case "assistant.fusion_phase_failed": {
        const detail = phaseFailureDetail(data);
        await emit(`HydraFusion ${phaseText(data)} on ${modelText(data.model)} failed after ${durationText(data.durationMs)}${detail ? ` (${detail})` : ""}${data.degradedToPhaseId ? "; continuing with a fallback phase" : ""}.`, { ephemeral: false, level: "warning" });
        if (!activePhase?.id || activePhase.id === data.phaseId) activePhase = null;
        reasoning = "";
        break;
      }
      case "session.fusion_completed": {
        activeFusion = false;
        activePhase = null;
        reasoning = "";
        const aiCredits = aiCreditText(data.usage);
        await emit(`HydraFusion completed in ${durationText(data.durationMs)}${data.finalSourceModel ? ` using ${modelText(data.finalSourceModel)} as the final source` : ""}${aiCredits ? `, ${aiCredits}` : ""}.`, { ephemeral: false });
        break;
      }
      case "tool.execution_start": {
        if ((!activeFusion && !event.agentId && !data.fusion) || !data.toolCallId) break;
        const summary = summarizeTool(data, cwd);
        const actor = toolActor(event, data);
        tools.set(data.toolCallId, { summary, actor, agentId: event.agentId, startedAt: now() });
        trimTools();
        const item = summary.item || summary.name;
        const generic = [summary.name, "files", "search", "code search", "web search"].includes(item);
        let visible = !generic;
        if (event.agentId) {
          const activity = subagentVisible.get(event.agentId) || { shown: 0, seen: new Set() };
          const signature = `${toolCategory(summary.name)}:${item}`;
          visible = visible && activity.shown < 4 && !activity.seen.has(signature);
          activity.seen.add(signature);
          if (visible) activity.shown++;
          subagentVisible.set(event.agentId, activity);
        }
        if (!event.agentId || visible) {
          const operation = event.agentId ? item : `${actor} · ${item}`;
          await emit(operation, { ephemeral: false, label: event.agentId ? actor : toolLabel(summary.name) });
        }
        break;
      }
      case "tool.execution_complete": {
        const tracked = tools.get(data.toolCallId);
        tools.delete(data.toolCallId);
        if (!tracked) break;
        if (tracked.agentId) {
          const counts = subagentTools.get(tracked.agentId) || {};
          const category = toolCategory(tracked.summary.name);
          counts[category] = (counts[category] || 0) + 1;
          if (!data.success) counts.failure = (counts.failure || 0) + 1;
          subagentTools.set(tracked.agentId, counts);
        }
        if (!data.success) {
          const item = tracked.summary.item && tracked.summary.item !== tracked.summary.name
            ? tracked.summary.item : toolCategory(tracked.summary.name);
          await emit(tracked.agentId ? `${item} failed.` : `${tracked.actor} · ${item} failed.`, {
            ephemeral: false, level: "warning",
            label: tracked.agentId ? tracked.actor : toolLabel(tracked.summary.name),
          });
        }
        break;
      }
      case "subagent.started":
        if (activeFusion || event.agentId) {
          const name = clean(data.agentDisplayName || data.agentName, 90) || "Subagent";
          if (event.agentId) subagents.set(event.agentId, { name, model: data.model });
          await emit(`Subagent: ${name} started${data.model ? ` on ${modelText(data.model)}` : ""}${data.executionMode ? ` in ${clean(data.executionMode, 30)} mode` : ""}.`);
        }
        break;
      case "subagent.completed":
        if (activeFusion || event.agentId) {
          const activity = event.agentId ? compactCounts(subagentTools.get(event.agentId) || {}) : "";
          if (event.agentId) {
            subagentTools.delete(event.agentId);
            subagentVisible.delete(event.agentId);
            subagents.delete(event.agentId);
          }
          await emit(`Subagent: ${clean(data.agentDisplayName || data.agentName, 90)} ${data.cancelled ? "cancelled" : "completed"}${data.durationMs !== undefined ? ` in ${durationText(data.durationMs)}` : ""}${activity ? `, ${activity}` : ""}.`, { ephemeral: false });
        }
        break;
      case "subagent.failed":
        if (activeFusion || event.agentId) {
          const activity = event.agentId ? compactCounts(subagentTools.get(event.agentId) || {}) : "";
          if (event.agentId) {
            subagentTools.delete(event.agentId);
            subagentVisible.delete(event.agentId);
            subagents.delete(event.agentId);
          }
          await emit(`Subagent: ${clean(data.agentDisplayName || data.agentName, 90)} failed${activity ? ` after ${activity}` : ""}.`, { ephemeral: false, level: "warning" });
        }
        break;
      case "skill.invoked":
        if (activeFusion || event.agentId) {
          await emit(`Skill: ${clean(data.name, 100)} invoked.`);
        }
        break;
    }
  }

  return {
    handle,
    reset,
    reportResponse: ({ status, via, adaptedModel }) => {
      if (via !== "byok" || !adaptedModel) return Promise.resolve();
      const failure = Number(status) >= 400 ? ` · HTTP ${status}` : "";
      return emit(`${modelText(adaptedModel)} → Microsoft Foundry${failure}`, {
        ephemeral: false, level: failure ? "warning" : "info", label: "Route",
      });
    },
    drain: async () => {
      await queue;
    },
  };
}
