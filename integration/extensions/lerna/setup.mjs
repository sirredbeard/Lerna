export async function ensureHydraFusion(session, userSettings) {
  let experimental;
  try {
    experimental = (await userSettings.get())?.settings?.experimental?.value;
  } catch {
    await session.log("Lerna could not determine whether experimental features are enabled.", { level: "warning" });
    return false;
  }

  if (experimental !== true) {
    if (!session.capabilities.ui?.elicitation) {
      await session.log("Lerna needs experimental features enabled to use HydraFusion. Run /experimental on.", { level: "warning" });
      return false;
    }
    if (!await session.ui.confirm("Lerna needs experimental features enabled for HydraFusion. Enable them now?")) {
      await session.log("Experimental features remain disabled; HydraFusion was not selected.", { level: "warning" });
      return false;
    }
    try {
      const result = await userSettings.set({ settings: { experimental: true } });
      if (result.shadowedKeys?.includes("experimental")) {
        await session.log("Lerna wrote experimental=true, but legacy config.json still overrides it. Remove that legacy setting and restart Copilot CLI.", { level: "warning" });
        return false;
      }
      await session.log("Experimental features enabled for Lerna. Copilot CLI may need to be restarted before HydraFusion appears.");
    } catch (error) {
      await session.log(`Lerna could not enable experimental features: ${error.message}`, { level: "warning" });
      return false;
    }
  }

  try {
    const current = await session.rpc.model.getCurrent();
    if (current?.modelId !== "hydrafusion") {
      await session.rpc.model.switchTo({ modelId: "hydrafusion", requireAvailable: true });
      await session.log("Lerna changed the selected model to HydraFusion.");
    }
    return true;
  } catch {
    await session.log("Experimental features are enabled, but HydraFusion is not available in this Copilot CLI session. Restart Copilot CLI and try again.", { level: "warning" });
    return false;
  }
}

function isMicrosoftVerificationUrl(url) {
  const host = url.hostname.toLowerCase();
  return url.protocol === "https:"
    && (host === "microsoft.com" || host.endsWith(".microsoft.com")
      || host === "microsoftonline.com" || host.endsWith(".microsoftonline.com"));
}

export async function azureSetup(session, bridge) {
  if (!session.capabilities.ui?.elicitation) {
    throw new Error("Run /lerna in an interactive Copilot session to sign into Azure.");
  }
  if (!await session.ui.confirm("Sign into Azure for Lerna's HydraFusion routes?")) return null;
  const result = await bridge.invoke("azure.login", {}, {
    onProgress: async ({ verificationUri, userCode }) => {
      const url = new URL(verificationUri);
      if (!isMicrosoftVerificationUrl(url) || !/^[A-Z0-9-]{6,20}$/i.test(userCode)) {
        throw new Error("Azure returned an unexpected sign-in prompt.");
      }
      const confirmed = await session.ui.confirm(
        `Open ${url.href} and enter ${userCode}. Sign in to the account that owns your Foundry deployment, then continue.`,
      );
      if (!confirmed) throw new Error("Azure sign-in cancelled.");
    },
  });
  if (result.persistentCache === false) {
    await session.log("No working OS keyring was found. Azure tokens stay in memory; sign in again next launch.");
  }
  let status = await bridge.invoke("status");
  if (!status.configured) {
    await session.log("Azure sign-in complete. Configure or import at least one HydraFusion route before enabling Lerna.");
    return status;
  }
  if (!status.enabled) {
    await bridge.invoke("enable");
    status = await bridge.invoke("status");
  }
  try { await session.rpc.model.switchTo({ modelId: "hydrafusion" }); }
  catch { await session.log("Lerna is configured. Select HydraFusion with /model when it is available."); }
  await session.log(`Lerna enabled: ${routeSummary(status)}.`);
  return status;
}

function routeSummary(status) {
  const models = Array.isArray(status.models) ? status.models.filter(Boolean) : [];
  if (models.length) {
    return `${models.length} HydraFusion model${models.length === 1 ? "" : "s"} routed (${models.join(", ")})`;
  }
  if (status.model || status.deployment) {
    return `${status.model || "HydraFusion"} through ${status.deployment || "the configured deployment"}`;
  }
  return "HydraFusion routing configured";
}

export async function configure(session, bridge, action) {
  action = action?.trim().toLowerCase();
  if (!action) {
    if (!session.capabilities.ui?.elicitation) throw new Error("Run /lerna in an interactive session.");
    const options = ["Show routing status", "Enable routing", "Disable routing", "Verbose on", "Verbose off", "Sign into Azure / refresh authentication", "Sign out of Azure"];
    const selected = await session.ui.select("Lerna", options);
    if (!selected) return null;
    action = ["status", "enable", "disable", "verbose on", "verbose off", "setup", "logout"][options.indexOf(selected)];
  }
  if (action === "setup" || action === "login") return azureSetup(session, bridge);
  if (action === "logout") {
    if (!session.capabilities.ui?.elicitation || !await session.ui.confirm("Sign out of Azure and disable Lerna?")) return null;
    await bridge.invoke("disable");
    await bridge.invoke("azure.logout");
  } else if (["enable", "disable"].includes(action)) {
    await bridge.invoke(action);
  } else if (action === "verbose on" || action === "verbose off") {
    await bridge.invoke("verbose", { enabled: action === "verbose on" });
  } else if (action !== "status") {
    throw new Error("Use /lerna, /lerna status, /lerna enable, /lerna disable, /lerna verbose on|off, /lerna login, or /lerna logout.");
  }
  const status = await bridge.invoke("status");
  await session.log(status.configured
    ? `Lerna ${status.enabled ? "enabled" : "disabled"}: ${routeSummary(status)}. Verbose ${status.verbose ? "on" : "off"}.`
    : `Lerna is not configured. Run /lerna to configure HydraFusion routing. Verbose ${status.verbose ? "on" : "off"}.`);
  return status;
}
