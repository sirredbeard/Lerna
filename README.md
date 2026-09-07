# Lerna

*Named after the Hydra of Lerna.*

<img width="1103" height="761" alt="Screenshot From 2026-09-07 13-27-31" src="https://github.com/user-attachments/assets/19438bda-46c9-4150-abc6-6b9e4e9561bb" />

Lerna is a plugin for GitHub Copilot CLI that adds more detail to [HydraFusion](https://github.blog/ai-and-ml/github-copilot/project-hydrafusion-frontier-quality-via-multi-model-orchestration/) and can route selected model calls to Microsoft Foundry.

HydraFusion is an experimental orchestrator. It's planner chooses from a fixed set of GitHub Copilot models, then Lerna can answer a chosen model call with your deployment of that model from Microsoft Foundry on Azure.

Lerna cannot add models to HydraFusion. HydraFusion currently accepts six model IDs and rejects everything else, so Lerna can only route models HydraFusion already knows about.

Four of the six have direct equivalents on Microsoft Foundry:

| HydraFusion model | Microsoft Foundry | Wire format |
| --- | --- | --- |
| `gpt-5.6-sol` | yes | OpenAI Responses |
| `gpt-5.6-luna` | yes | OpenAI Responses |
| `gpt-5.6-terra` | yes | OpenAI Responses |
| `claude-opus-5` | yes | Anthropic Messages (`/v1/messages` intercepted and forwarded to Foundry) |
| `mai-code-1.1-flash` | no equivalent | stays on Copilot |
| `mai-code-1-flash-picker` | no equivalent | stays on Copilot |

Lerna does not change HydraFusion's chosen model ID. It looks up that exact ID in your settings and forwards the request to the deployment you mapped, so you are responsible for mapping it to the same underlying model. The two MAI models cannot be mapped and stay on Copilot's native request path.

Each Lerna release tracks the Copilot CLI build it supports.

## Contents

- [Requirements](#requirements) - What you need for verbose output, and what Azure routing adds.
- [Build and platforms](#build-and-platforms) - Native AOT details, supported platforms, and binary size.
- [Install](#install) - Install the plugin from Copilot CLI.
- [Use in Copilot CLI](#use-in-copilot-cli) - Manage routing and verbose output.
- [Configure](#configure) - Add Azure identity and model mappings.
- [Fresh Microsoft Foundry setup](#fresh-azure-ai-foundry-setup) - Build the Azure side from scratch.
- [Troubleshooting](#troubleshooting) - Separate Lerna failures from HydraFusion failures.
- [Notes](#notes) - Routing behavior and deeper research.

## Requirements

Lerna's verbose HydraFusion display does not require Azure or model routing. It only requires a supported GitHub Copilot CLI build with experimental features enabled.

Azure is only required if you want Lerna to route model calls. Routing requires:

- An Microsoft Foundry resource and `Cognitive Services User` access to run inference.
- One Azure deployment for each HydraFusion model you want Lerna to serve.

## Build and platforms

Lerna is built with .NET 11 Preview 7 Native AOT as a self-contained native binary. You do not need to install .NET to run it.

Release builds support:

- Linux x64 and Arm64.
- Windows x64 and Arm64.
- macOS Arm64.

## Install

From inside Copilot CLI:

```text
/plugin install sirredbeard/Lerna:integration
```

## Use in Copilot CLI

Start a fresh Copilot CLI process after installing or updating Lerna. The request interceptor has to attach before the first session starts, so `/restart` and `--resume` cannot activate routing in a process that is already running.

When Lerna starts, it checks whether experimental features are enabled. If they are off, Lerna will ask you to enable them and writes the setting for you. Lerna also checks the current model and automatically selects HydraFusion when another model is selected. A restart may be required after enabling experimental features before HydraFusion becomes available.

`/lerna`

- `/lerna` - Open the routing menu.
- `/lerna status` - Show whether routing is enabled, which HydraFusion models are mapped, and whether verbose diagnostics are on.
- `/lerna enable` / `/lerna disable` - Start or stop routing without deleting the mappings.
- `/lerna verbose on` / `/lerna verbose off` - Show or hide HydraFusion routing, phase, tool, subagent, and skill activity.
- `/lerna login` / `/lerna logout` - Refresh or remove the cached Azure sign-in.

Verbose mode is on by default; turn it off with `/lerna verbose off`. It does not require Azure, a route mapping, or routing to be enabled.

Route, phase-start, and tool-operation messages appear immediately and remain in the timeline while verbose mode is on. Model reasoning is shown live during an active HydraFusion phase, with the completed reasoning retained when the SDK supplies it.

Tool activity includes useful file names, search expressions, shell and git commands, URLs, and MCP queries. Lerna hides detail-free calls, duplicate searches, and prompt-like text accidentally appended to a search expression, and shows no more than four unique operations for each subagent. Completion totals still count all operations. Partial tool output and provider response bodies are not copied into the timeline, and obvious credential values are redacted.

## Configure

Authentication uses Microsoft Entra tokens. Run `/lerna login` inside Copilot CLI, or run `lerna login` if you downloaded the native binary, then sign in with the device code. Lerna stores the refresh token and short-lived access token in `lerna-auth.json` beside Copilot's settings file, separate from `settings.json`, and refreshes the access token automatically.

Lerna stores routing settings and nonsecret Azure identifiers in Copilot's settings file. There is no API key to paste and no secrets repo to point at. `endpoint` is the bare resource base, and Lerna appends the path required by each wire format at request time.

```json
{
  "lerna": {
    "enabled": true,
    "auth": {
      "type": "azure",
      "tenantId": "...",
      "clientId": "...",
      "subscriptionId": "..."
    },
    "models": {
      "gpt-5.6-terra": {
        "resourceId": "/subscriptions/.../accounts/YOUR-RESOURCE",
        "resourceName": "YOUR-RESOURCE",
        "deployment": "gpt-5.6-terra",
        "endpoint": "https://YOUR-RESOURCE.services.ai.azure.com",
        "wire": "responses"
      },
      "claude-opus-5": {
        "resourceId": "/subscriptions/.../accounts/YOUR-RESOURCE",
        "resourceName": "YOUR-RESOURCE",
        "deployment": "claude-opus-5",
        "endpoint": "https://YOUR-RESOURCE.services.ai.azure.com",
        "wire": "anthropic"
      }
    }
  }
}
```

`clientId` is an Entra app registration you own. It needs to be a public client with delegated `user_impersonation` on Azure Cognitive Services. `tenantId` defaults to `organizations` when omitted. `subscriptionId` is retained as nonsecret configuration context; token requests use `tenantId` and `clientId`.

Each `models` key must be one of HydraFusion's six accepted model IDs. Lerna rejects the two MAI IDs because they have no Azure equivalent. Lerna validates the mapping shape, but it does not query Azure Resource Manager during inference to prove which model backs a deployment. Map each key to a deployment of that same model.

## Fresh Microsoft Foundry setup

The Azure estate is the fiddly part. Lerna needs (1) an `AIServices` account, (2) one deployment for each HydraFusion model you want to pay for, (3) an Entra public-client app, and (4) inference permission for the person signing in.

Before creating anything, check the model catalog and quota for the region. Model versions, SKUs, and capacity vary by subscription and region, so do not copy an old version number from this README and assume Azure still offers it.

A PowerShell session to create the resource and inspect the available models looks like this:

```powershell
$subscriptionId = "00000000-0000-0000-0000-000000000000"
$resourceGroup = "lerna-rg"
$location = "eastus2"
$accountName = "lerna-foundry"

az login
az account set --subscription $subscriptionId
az provider register --namespace Microsoft.CognitiveServices --wait

az group create --name $resourceGroup --location $location
az cognitiveservices account create `
  --name $accountName `
  --resource-group $resourceGroup `
  --location $location `
  --kind AIServices `
  --sku S0 `
  --custom-domain $accountName

az cognitiveservices model list --location $location `
  --query "[?name=='gpt-5.6-sol' || name=='gpt-5.6-luna' || name=='gpt-5.6-terra' || name=='claude-opus-5'].{model:name,format:format,version:version,skus:skus[].name}" `
  --output table
```

Create deployments one at a time using the version and SKU Azure returned. I recommend keeping `--deployment-name` identical to `--model-name`; Lerna uses the deployment name from your mapping and does not inspect the backing model during inference.

```powershell
$modelName = "gpt-5.6-sol"
$modelFormat = "OpenAI"
$modelVersion = "VERSION-FROM-THE-CATALOG"

az cognitiveservices account deployment create `
  --resource-group $resourceGroup `
  --name $accountName `
  --deployment-name $modelName `
  --model-format $modelFormat `
  --model-name $modelName `
  --model-version $modelVersion `
  --sku-name GlobalStandard `
  --sku-capacity 1000
```

Repeat that command only for models available in the account's region. Use `Anthropic` as the model format for `claude-opus-5`. Deployment capacity is billable and quota-backed, so check it before accepting the command.

Give your signed-in Azure user inference access to the account:

```powershell
$resourceId = az cognitiveservices account show `
  --resource-group $resourceGroup `
  --name $accountName `
  --query id -o tsv
$userObjectId = az ad signed-in-user show --query id -o tsv

az role assignment create `
  --assignee-object-id $userObjectId `
  --assignee-principal-type User `
  --role "Cognitive Services User" `
  --scope $resourceId
```

Lerna also needs an Entra app registration it can use for device-code sign-in. In the Azure portal, open **Microsoft Entra ID → App registrations** and create an app in the tenant that owns the Foundry account. Under **Authentication**, enable public client flows. Under **API permissions**, add the Azure Cognitive Services delegated `user_impersonation` permission and grant consent if the tenant requires it. Put the application's client ID, tenant ID, and subscription ID under `lerna.auth`.

Get the base endpoint and deployment details Azure actually created:

```powershell
az cognitiveservices account show `
  --resource-group $resourceGroup `
  --name $accountName `
  --query "{id:id,endpoint:properties.endpoints.'AI Foundry API'}"

az cognitiveservices account deployment list `
  --resource-group $resourceGroup `
  --name $accountName `
  --query "[].{deployment:name,model:properties.model.name,version:properties.model.version,format:properties.model.format,state:properties.provisioningState}" `
  --output table
```

Use the `AI Foundry API` base URL, not a full model URL and not `properties.endpoint` when the two differ. Lerna adds `/openai/v1/responses` or `/anthropic/v1/messages` at request time. Run `/lerna login`, then `/lerna status`, after the settings are in place.

The native binary has the same core controls for shell use:

- `lerna login` - Sign in to Azure with a device code.
- `lerna logout` - Forget the cached sign-in.
- `lerna status` - Show which models are routed and where.
- `lerna enable` / `lerna disable` - Start or stop routing, keeping the mapping.

## Troubleshooting

For a stuck run, use `/diagnose`, then inspect the current process log and the newest `plugin-lerna_lerna-*.log` under `~/.copilot/logs/extensions/`. A hang is likely in Lerna if the extension log stops before `ready`, reports that the helper stopped, or the timeline reports a failed Azure response. A stall after clean route and phase entries is normally HydraFusion's planner or cancellation path.

`ctrl+c` requests cancellation, `esc esc` also interrupts active work, and `ctrl+c` twice exits the CLI. A cancelled Hydra phase may take a moment to unwind if the model is between requests, however Lerna forwards the request abort to its native helper immediately.

Concurrent Copilot CLI instances are supported. Each process starts its own stdio-connected Lerna helper, there is no shared port, lock file, or singleton service, and the helper exits when its parent extension closes, including after a forced Copilot exit.

`Cannot set LLM inference provider while sessions are active` refers to another session inside the same Copilot process, not another terminal or an orphaned Lerna helper. Fully quit that one Copilot process and start it again. `/restart` and `--resume` reuse session state too late for the interceptor registration used by the supported Copilot CLI build.

## Notes

HydraFusion picks the model, not you. Lerna only gets to answer for a model once HydraFusion's planner has already chosen it, so a mapped model that the planner never picks will never see traffic.

Cost comparison, prompt-cache behavior, plugin boundaries, and Entra flow are documented in [RESEARCH.md](RESEARCH.md).

## License

[MIT](LICENSE)

This project is not affiliated with, sponsored, or endorsed by GitHub, Inc., Microsoft Corporation, OpenAI, or Anthropic. GitHub® and GitHub Copilot® are registered trademarks of GitHub, Inc. Azure® is a registered trademark of Microsoft Corporation. Claude® is a registered trademark of Anthropic PBC. All other trademarks mentioned herein are the property of their respective owners.
