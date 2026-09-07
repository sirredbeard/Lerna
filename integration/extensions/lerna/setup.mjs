async function choose(session, message, items, label) {
  if (!items.length) throw new Error("No accessible entries were found.");
  if (items.length === 1) return items[0];
  const options = items.map((item, index) => `${index + 1}. ${label(item)}`);
  const selected = await session.ui.select(message, options);
  return selected === null ? null : items[options.indexOf(selected)];
}

export async function azureSetup(session, bridge) {
  if (!session.capabilities.ui?.elicitation) {
    throw new Error("Run /lerna in an interactive Copilot session to sign into Azure.");
  }
  if (!await session.ui.confirm("Sign into Azure and choose a Foundry deployment for Lerna?")) return null;
  const result = await bridge.invoke("azure.login", {}, {
    onProgress: async ({ verificationUri, userCode }) => {
      const url = new URL(verificationUri);
      if (url.protocol !== "https:" || !["microsoft.com", "www.microsoft.com", "login.microsoftonline.com"].includes(url.hostname)
          || !/^[A-Z0-9-]{6,20}$/i.test(userCode)) {
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
  const { subscriptions } = await bridge.invoke("azure.subscriptions");
  if (!subscriptions?.length) throw new Error("This Azure account has no accessible subscriptions.");
  const subscription = await choose(session, "Choose an Azure subscription.", subscriptions,
    item => `${item.displayName} (${item.subscriptionId})`);
  if (!subscription) return null;
  const scope = { subscriptionId: subscription.subscriptionId, tenantId: subscription.tenantId };
  const { deployments } = await bridge.invoke("azure.deployments", scope);
  if (!deployments?.length) {
    throw new Error("No compatible GPT-5.6 Terra deployment was found. This preview only supports that model through Responses.");
  }
  const selected = await choose(session, "Choose a Foundry deployment.", deployments,
    item => `${item.deployment} on ${item.resourceName || item.resourceId} (${item.location || item.model})`);
  if (!selected) return null;
  if (!await session.ui.confirm(`Use ${selected.deployment} (${selected.model}) for HydraFusion? Azure usage is billed to your subscription.`)) {
    return null;
  }
  await bridge.invoke("azure.select", {
    ...scope, resourceId: selected.resourceId, deployment: selected.deployment,
  });
  const status = await bridge.invoke("status");
  try { await session.rpc.model.switchTo({ modelId: "hydrafusion" }); }
  catch { await session.log("Azure is configured. Select HydraFusion with /model when it is available."); }
  await session.log(`Lerna is using ${status.deployment} for ${status.model}.`);
  return status;
}

export async function configure(session, bridge, action) {
  if (!action) {
    if (!session.capabilities.ui?.elicitation) throw new Error("Run /lerna in an interactive session.");
    const options = ["Sign into Azure / change deployment", "Show status", "Enable", "Disable", "Sign out of Azure"];
    const selected = await session.ui.select("Lerna", options);
    if (!selected) return null;
    action = ["setup", "status", "enable", "disable", "logout"][options.indexOf(selected)];
  }
  if (action === "setup" || action === "login") return azureSetup(session, bridge);
  if (action === "logout") {
    if (!session.capabilities.ui?.elicitation || !await session.ui.confirm("Sign out of Azure and disable Lerna?")) return null;
    await bridge.invoke("azure.logout");
  } else if (["enable", "disable"].includes(action)) {
    await bridge.invoke(action);
  } else if (action !== "status") {
    throw new Error("Use /lerna, /lerna status, /lerna enable, or /lerna disable.");
  }
  const status = await bridge.invoke("status");
  await session.log(status.configured
    ? `Lerna ${status.enabled ? "enabled" : "disabled"}: ${status.model} through ${status.deployment}.`
    : "Lerna is not configured. Run /lerna to sign into Azure.");
  return status;
}
