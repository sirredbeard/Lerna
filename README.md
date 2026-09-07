# Lerna

*Named after the Hydra of Lerna.*

Plugin for GitHub Copilot CLI that gives [HydraFusion](https://github.blog/ai-and-ml/github-copilot/project-hydrafusion-frontier-quality-via-multi-model-orchestration/) more verbosity and can re-route model calls (currently to Azure Foundry).

HydraFusion is an experimental AI orchestrator that dispatches work to various GitHub Copilot models. Lerna re-routes those model calls to equivalent model endpoints deployed on Azure Foundry instead of GitHub Copilot.

Lerna cannot currently add additional models to HydraFusion. HydraFusion appears to accept six model IDs and rejects everything else, so the most it can do is serve the models HydraFusion already knows about.

Four of the six have same-name equivalents on Azure Foundry:

| HydraFusion model | Azure AI Foundry | Wire format |
| --- | --- | --- |
| `gpt-5.6-sol` | yes | OpenAI Responses |
| `gpt-5.6-luna` | yes | OpenAI Responses |
| `gpt-5.6-terra` | yes | OpenAI Responses |
| `claude-opus-5` | yes | Anthropic Messages (`/v1/messages` intercepted and forwarded to Foundry) |
| `mai-code-1.1-flash` | no equivalent | stays on Copilot |
| `mai-code-1-flash-picker` | no equivalent | stays on Copilot |

Lerna never relabels one model as another. A model is either served by your own deployment of that same model, or it is left on GitHub Copilot. The two MAI models bypass Lerna's forwarding bridge entirely and use Copilot's native request path.

Lerna versions follow the Copilot CLI version they support.

## Requirements

- A supported GitHub Copilot CLI build with experimental features enabled. Run `copilot --version` against the process you are about to start; the launcher can keep more than one CLI build in its per-user cache.
- An Azure AI Foundry resource, and permission to read it's deployments and run inference against them.
- Azure deployments named for the HydraFusion models you want to serve.

## Install

From inside Copilot CLI:

```text
/plugin install sirredbeard/Lerna:integration
```

## Use in Copilot CLI

Start a fresh Copilot CLI process after installing or updating Lerna. The request interceptor has to attach before the first session starts, so `/restart` and `--resume` cannot activate routing in a process that is already running.

When Lerna starts, it checks whether experimental features are enabled. If they are off, Lerna asks whether to enable them and writes the setting for you. Lerna also checks the current model and automatically selects HydraFusion when another model is selected, with a timeline message explaining the change. A restart may be required after enabling experimental features before HydraFusion becomes available.

`/lerna`

- `/lerna` - Open the routing menu.
- `/lerna status` - Show whether routing is enabled, which HydraFusion models are mapped, and whether verbose diagnostics are on.
- `/lerna enable` / `/lerna disable` - Start or stop routing without deleting the mappings.
- `/lerna verbose on` / `/lerna verbose off` - Show or hide safe HydraFusion routing, phase, tool, subagent, and skill activity.
- `/lerna login` / `/lerna logout` - Refresh or remove the cached Azure sign-in.

Verbose mode is on by default (it is the main reason to install Lerna); turn it off with `/lerna verbose off`. It does not require Azure, a route mapping, or routing to be enabled. You can install Lerna only for the extra HydraFusion activity display and leave `/lerna disable` in place.

Route, phase-start, and tool-operation messages are emitted immediately and remain in the timeline while verbose mode is on. Model reasoning deltas are shown live during an active HydraFusion phase, with the completed reasoning retained when the SDK supplies it. A successful Azure response appears as `Lerna · Route Opus 5 → Azure Foundry`; HTTP status is only included for a failed response. Tool activity shows the useful bit Copilot shows, including file names, search expressions, shell and git commands, URLs, and MCP queries, without repeating `Search Search Subagent` for every operation. Partial tool output and provider response bodies are not copied into the timeline, and obvious credential values are still redacted.

## Configure

Authentication uses Microsoft Entra tokens. Run `/lerna login` inside Copilot CLI, or `lerna login` from a shell, then sign in with the device code. The token is cached beside your settings file, owner-readable only, and refreshed automatically.

Lerna stores only the mapping from Hydra model to Azure deployment, in Copilot's own settings file. There is no API key to paste and no secrets repo to point at. `endpoint` is the bare resource base, and Lerna appends the right path for the wire format at request time.

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

`clientId` is an Entra app registration you own. It needs to be a public client with delegated `user_impersonation` on Azure Cognitive Services.

The key must be one of the six HydraFusion model IDs, and the Azure deployment it points at has to be that same model.

## Fresh Azure AI Foundry setup

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

Create deployments one at a time using the version and SKU Azure returned. Keep `--deployment-name` identical to `--model-name`; Lerna deliberately refuses model relabeling.

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

Inside Copilot CLI, `/lerna logout` also disables routing before it removes the cached sign-in. The shell command only removes authentication, so run `lerna disable` first when using the native binary directly.


## Troubleshooting

`HydraFusion · choosing a workflow` is the planner step on GitHub Copilot. Lerna can observe and pass that request through, but no Azure model call has started yet. A later `Lerna · Route <model> → Azure Foundry` timeline entry confirms Azure accepted that model request. Failed responses retain their HTTP status.

For a stuck run, use `/diagnose`, then inspect the current process log and the newest `plugin-lerna_lerna-*.log` under `~/.copilot/logs/extensions/`. A hang is likely in Lerna if the extension log stops before `ready`, reports that the helper stopped, or the timeline reports a failed Azure response. A stall after clean route and phase entries is normally HydraFusion's planner or cancellation path.

`ctrl+c` requests cancellation, `esc esc` also interrupts active work, and `ctrl+c` twice exits the CLI. A cancelled Hydra phase may take a moment to unwind if the model is between requests, however Lerna forwards the request abort to its native helper immediately.

Concurrent Copilot CLI processes are supported. Each process starts its own stdio-connected Lerna helper, there is no shared port, lock file, or singleton service, and the helper exits when its parent extension closes, including after a forced Copilot exit. One leftover Copilot process does not block a new one.

`Cannot set LLM inference provider while sessions are active` refers to another session inside the same Copilot process, not another terminal or an orphaned Lerna helper. Fully quit that one Copilot process and start it again. `/restart` and `--resume` reuse session state too late for the interceptor registration used by the supported Copilot CLI build.

## Notes

HydraFusion picks the model, not you. Lerna only gets to answer for a model once HydraFusion's planner has already chosen it, so a mapped model that the planner never picks will never see traffic.

Cost comparison, prompt-cache behavior, plugin boundaries, and Entra flow are documented in [RESEARCH.md](RESEARCH.md).

## License

[MIT](LICENSE)

This project is not affiliated with, sponsored, or endorsed by GitHub, Inc., Microsoft Corporation, OpenAI, or Anthropic. GitHub® and GitHub Copilot® are registered trademarks of GitHub, Inc. Azure® is a registered trademark of Microsoft Corporation. Claude® is a registered trademark of Anthropic PBC. All other trademarks mentioned herein are the property of their respective owners.
