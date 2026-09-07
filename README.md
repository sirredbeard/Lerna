# Lerna

Unofficial BYOK for HydraFusion in GitHub Copilot CLI, named after the Hydra of Lerna.

Copilot CLI can route a turn through HydraFusion, which fuses several models behind a single answer. Lerna leaves that orchestration alone and serves the inference from your own Azure AI Foundry deployments instead of Copilot's.

Lerna cannot add models to Hydra. Hydra accepts exactly six model IDs and rejects everything else, so the most it can do is serve the models Hydra already knows about. Four of the six have same-name equivalents on Azure AI Foundry:

| Hydra model | Azure AI Foundry | Wire format |
| --- | --- | --- |
| `gpt-5.6-sol` | yes | OpenAI Responses |
| `gpt-5.6-luna` | yes | OpenAI Responses |
| `gpt-5.6-terra` | yes | OpenAI Responses |
| `claude-opus-5` | yes | Anthropic Messages |
| `mai-code-1.1-flash` | no equivalent | stays on Copilot |
| `mai-code-1-flash-picker` | no equivalent | stays on Copilot |

Lerna never relabels one model as another. A model is either served by your own deployment of that same model, or it is left on Copilot.

This is a preview, version 1.0.83, pinned to GitHub Copilot CLI 1.0.83. Lerna versions follow the Copilot CLI version they support.

## Requirements

- GitHub Copilot CLI 1.0.83, with experimental features enabled.
- A Azure AI Foundry resource, and permission to read it's deployments and run inference against them.
- Azure deployments named for the Hydra models you want to serve.

## Install

From inside Copilot CLI:

```text
/plugin install sirredbeard/Lerna:integration
```

The plugin grabs the native binary for your platform and checks it against the published `SHA256SUMS` before installing it. Linux x64, Linux arm64, Windows x64, and macOS arm64 are built.

Release builds are tagged with the supported Copilot CLI version, currently `v1.0.83`. A compatibility change gets a new version matching that Copilot CLI release.

The release workflow runs for version tags or by hand. There are no automated branch or scheduled builds right now. Actions artifacts are kept for 5 days, and rebuilding the same release replaces it's existing release assets.

## Configure

Authentication uses Microsoft Entra tokens. Run `lerna login` and sign in with the device code it prints. The token is cached beside your settings file, owner-readable only, and refreshed automatically.

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

The key must be one of the six Hydra model IDs, and the Azure deployment it points at has to be that same model.

- `lerna login` - Sign in to Azure with a device code.
- `lerna logout` - Forget the cached sign-in.
- `lerna status` - Show which models are routed and where.
- `lerna enable` / `lerna disable` - Start or stop routing, keeping the mapping.

Deployments are billable, and Lerna does not create them. Create them yourself in Azure AI Foundry, named for the model they serve. Note that creating a Claude deployment accepts Anthropic's marketplace terms on your behalf.

## Notes

Hydra picks the model, not you. Lerna only gets to answer for a model once Hydra's planner has already chosen it, so a mapped model that the planner never picks will never see traffic.

Billing attribution is unverified. I would assume a routed turn bills to your Azure subscription, however I have not confirmed what, if anything, is still counted on the Copilot side.

The cost comparison, prompt-cache behavior, plugin boundaries, and Entra flow are documented in [RESEARCH.md](RESEARCH.md).

## License

[MIT](LICENSE).

This project is not affiliated with, sponsored, or endorsed by GitHub, Inc., Microsoft Corporation, OpenAI, or Anthropic. GitHub® and GitHub Copilot® are registered trademarks of GitHub, Inc. Azure® is a registered trademark of Microsoft Corporation. Claude® is a registered trademark of Anthropic PBC. All other trademarks mentioned herein are the property of their respective owners.
