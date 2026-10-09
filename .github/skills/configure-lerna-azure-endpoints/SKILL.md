---
name: configure-lerna-azure-endpoints
description: Use Azure CLI to discover Microsoft Foundry deployments and configure Lerna's local Copilot settings without committing machine-specific endpoint configuration.
---

# Configure Lerna Azure endpoints

Use this skill when an agent needs to configure Lerna to route HydraFusion model
calls to Microsoft Foundry. This skill changes the user's local Copilot settings,
not the repository.

## Safety and scope

- Read `README.md` and `.github/copilot-instructions.md` before changing behavior.
- Never write Azure tokens, API keys, refresh tokens, or deployment secrets to the
  repository, settings, logs, or this skill.
- Never commit `~/.copilot/settings.json` or other local endpoint configuration.
- Use the Foundry account's `AI Foundry API` endpoint as the bare base URL. Do not
  store a request path, query string, fragment, or credentials in `endpoint`.
- Preserve the same-model boundary: only map a HydraFusion ID to a deployment
  whose Azure model name is the same ID.
- The two MAI IDs (`mai-code-1.1-flash` and `mai-code-1-flash-picker`) have no
  Azure equivalent and must not be mapped.

## Select the Azure subscription

The user may have several subscriptions. Always enumerate them before discovery:

```bash
az account list --all \
  --query "[].{name:name,id:id,tenantId:tenantId,state:state,isDefault:isDefault}" \
  --output table
```

For Hayden's environment, prefer the subscription named `Visual Studio Enterprise
Subscription` when it exists. Resolve its ID from the live list rather than
hard-coding the ID, then make it the Azure CLI default:

```bash
subscription_id="$(
  az account list --all \
    --query "[?name=='Visual Studio Enterprise Subscription'].id | [0]" \
    --output tsv
)"
test -n "$subscription_id"
az account set --subscription "$subscription_id"
az account show --query "{name:name,id:id,tenantId:tenantId}" --output json
```

If that subscription is unavailable, stop and ask which subscription owns the
Foundry resource. Do not silently use the previous default. For other users,
select the explicitly requested subscription and keep the subscription ID in
local settings only.

## Discover the Foundry resource and deployments

Discover resources in the selected subscription:

```bash
az resource list \
  --subscription "$subscription_id" \
  --resource-type Microsoft.CognitiveServices/accounts \
  --query "[].{name:name,resourceGroup:resourceGroup,location:location,kind:kind,id:id}" \
  --output table
```

Confirm the account endpoint and deployment inventory:

```bash
az cognitiveservices account show \
  --subscription "$subscription_id" \
  --resource-group "$resource_group" \
  --name "$account_name" \
  --query "{id:id,name:name,endpoint:properties.endpoints.\"AI Foundry API\",location:location}" \
  --output json

az cognitiveservices account deployment list \
  --subscription "$subscription_id" \
  --resource-group "$resource_group" \
  --name "$account_name" \
  --query "[].{deployment:name,model:properties.model.name,version:properties.model.version,format:properties.model.format,state:properties.provisioningState}" \
  --output table
```

Only use deployments whose state is `Succeeded`. Use `responses` for OpenAI
deployments and `anthropic` for Anthropic deployments. Do not infer the wire
from the deployment name; use `properties.model.format`.

## Find the configured public client

Lerna uses an Entra public-client app for device-code sign-in. Find the app
registration and verify that it has the Microsoft Cognitive Services delegated
`user_impersonation` permission:

```bash
az ad app list --all \
  --query "[?displayName=='Lerna'].{displayName:displayName,appId:appId,signInAudience:signInAudience}" \
  --output table

az ad app permission list --id "$client_id" --output json
```

Do not put a client secret in Lerna settings. If no suitable public client
exists, report that an Entra app must be created or corrected rather than
creating credentials in the repository.

## Write local Lerna settings

Write only `~/.copilot/settings.json`, preserving unrelated settings. The
canonical shape is:

```json
{
  "lerna": {
    "enabled": true,
    "verbose": true,
    "auth": {
      "type": "azure",
      "tenantId": "<tenant-id>",
      "clientId": "<public-client-id>",
      "subscriptionId": "<selected-subscription-id>"
    },
    "models": {
      "<hydra-model-id>": {
        "resourceId": "<Foundry-resource-id>",
        "resourceName": "<Foundry-account-name>",
        "deployment": "<Azure-deployment-name>",
        "endpoint": "https://<account>.services.ai.azure.com",
        "wire": "responses"
      }
    }
  }
}
```

Use an atomic write and preserve existing keys. Do not map Sol solely because a
deployment exists; follow the user's routing policy. The settings file is local
state and must not be added to a pull request.

## Validate

Re-query Azure and validate the local shape:

```bash
az account show --query "{name:name,id:id,isDefault:isDefault}" --output json
az cognitiveservices account deployment list \
  --resource-group "$resource_group" \
  --name "$account_name" \
  --query "[].{deployment:name,model:properties.model.name,state:properties.provisioningState}" \
  --output table
jq '{experimental,lerna}' "$HOME/.copilot/settings.json"
```

Run `/lerna login` in an interactive Copilot CLI session after configuration,
then `/lerna status`. Authentication tokens belong in Lerna's OS-backed cache,
not in the repository.
