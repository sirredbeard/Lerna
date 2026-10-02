# HydraFusion field reference

HydraFusion is a GitHub Copilot research preview, not a public API. There is no public source repo or versioned HydraFusion contract that Lerna can treat as ground truth.

This is the next best thing: a dated record of the public claims, the Copilot CLI behavior we can observe, the Microsoft Foundry deployments we actually run, and the cost decisions behind the route.

Last verified: October 2, 2026 UTC

Copilot CLI: `1.0.91`

Azure resource: private Microsoft Foundry account

## Evidence labels

Every important claim in this file should fit one of these:

| Label | Meaning |
| --- | --- |
| Official | Published by GitHub or Microsoft. |
| Live configuration | Read from the authenticated Azure resource or local Lerna settings. |
| Observed | Reproduced by Lerna against a specific Copilot CLI and saved in this repo. |
| Inference | A working conclusion from the evidence, not a published contract. |

HydraFusion can change underneath us. The label and verification date matter.

## What GitHub says HydraFusion does

GitHub describes HydraFusion as a runtime orchestrator that chooses one of three patterns for each request:

| Pattern | Public behavior |
| --- | --- |
| Single | One model solves the task directly. |
| Cascade | An efficient model drafts, then a quality gate accepts the result or escalates to a stronger model. |
| Critique | One model drafts, a read-only model from another family reviews, then the drafting model revises once. |

GitHub also says HydraFusion uses complete accounting across drafting, critique, revision, escalation, retry, and fallback. It does not say the quality-gate threshold, routing weights, model-selection rules, or fallback policy are a stable public contract.

GitHub's benchmark result is useful context, not a promise for Lerna workloads. The September 2026 announcement reported 67% lower estimated cost and 4.9 percentage points better verified quality than Claude Opus 5 on TerminalBench 2.1. It also reported 36% lower cost with 1.5 points lower quality on DeepSWE, and 65% lower cost with 0.1 points lower quality on CheckpointBench.

Source: [Project HydraFusion: Frontier quality via multi-model orchestration](https://github.blog/ai-and-ml/github-copilot/project-hydrafusion-frontier-quality-via-multi-model-orchestration/), accessed October 1, 2026.

## The contract Lerna has observed

The current working request path is:

```text
Copilot CLI
  -> GitHub's /model/fusion planner
  -> a HydraFusion plan naming a model and pattern
  -> Lerna's request interceptor
  -> the matching Microsoft Foundry deployment, when mapped
  -> Copilot CLI's normal session and tool loop
```

Observed on Copilot CLI `1.0.91`:

- HydraFusion picks the workflow and model ID. Lerna does not.
- Lerna receives the plan before the mapped model inference call.
- Lerna can route only a model ID HydraFusion already accepted.
- Lerna must preserve model identity. A deployment alias is fine, a different underlying model is not.
- OpenAI models arrive on the Responses wire.
- Claude arrives on the Anthropic Messages wire.
- Planner work, unmapped models, MAI models, explicit subagents, compaction, retries, and other Copilot-owned work can still consume GitHub AI credits.
- The internal quality gate and routing policy remain opaque.

The strongest saved reproduction is [`verified-run.json`](verified-run.json). The deeper request and event notes are in [`RESEARCH.md`](../RESEARCH.md).

## Known HydraFusion model boundary

Lerna currently accepts the six model IDs verified against the Copilot CLI planner:

| HydraFusion model ID | Foundry equivalent | Wire | Lerna behavior |
| --- | --- | --- | --- |
| `gpt-5.6-sol` | Same model | OpenAI Responses | Routable when mapped |
| `gpt-5.6-luna` | Same model | OpenAI Responses | Routable when mapped |
| `gpt-5.6-terra` | Same model | OpenAI Responses | Routable when mapped |
| `claude-opus-5` | Same model | Anthropic Messages | Routable when mapped |
| `mai-code-1.1-flash` | None | Copilot | Never routed |
| `mai-code-1-flash-picker` | None | Copilot | Never routed |

This is an observed allowlist, not a GitHub API promise. `.github/workflows/copilot-cli-sync.yml` checks new Copilot CLI releases every day, compares model mentions against `.github/copilot-cli-state.json`, and opens review work when the known model set moves.

Release notes are not enough by themselves. After a Copilot CLI update, the planner probe still needs to confirm that HydraFusion accepts the model and emits the expected plan and phase events.

## GitHub AI credits

Copilot Max costs $100 per month and currently includes 20,000 GitHub AI credits: 10,000 base credits and a 10,000-credit flex allotment. One AI credit equals $0.01. Included credits reset at 00:00 UTC on the first day of each month and do not carry over.

Copilot CLI usage is billed from the model and token mix. Agentic work can make several model calls in one task. GitHub gives paid plans a 10% model-cost discount when using Auto model selection, however HydraFusion should not be assumed to receive that discount unless GitHub says so.

Source: [Usage-based billing for individuals](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing), accessed October 1, 2026.

Lerna does not make the entire turn free. The saved September 7 audit found that mapped model rows recorded zero GitHub AI credits, while surrounding unmapped Copilot activity remained billable. That is observed behavior on Copilot CLI `1.0.83`, not a billing guarantee.

## Current Foundry inventory

The authenticated resource is in a private Azure subscription.

| Deployment | Model version | Format | SKU | Capacity | Upgrade policy | RAI policy | Active Lerna route |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| `gpt-5.6-sol` | `2026-07-09` | OpenAI | `GlobalStandard` | 1000 | New default | `Microsoft.DefaultV2` | No |
| `gpt-5.6-luna` | `2026-07-09` | OpenAI | `GlobalStandard` | 1000 | New default | `Microsoft.DefaultV2` | Yes |
| `gpt-5.6-terra` | `2026-07-09` | OpenAI | `GlobalStandard` | 1000 | New default | `Microsoft.DefaultV2` | Yes |
| `claude-opus-5` | `2` | Anthropic | `GlobalStandard` | 40 | New default | `Microsoft.DefaultV2` | Yes |
| `claude-sonnet-4-6` | `1` | Anthropic | `GlobalStandard` | 80 | New default | `Microsoft.DefaultV2` | No |

Provisioning state was `Succeeded` for all five deployments on October 2, 2026 UTC.

The number in the capacity column is throughput quota, not prepaid model usage. Lowering `GlobalStandard` capacity can release quota or force earlier throttling, however it does not lower token prices or create an idle-charge saving.

The three GPT-5.6 deployments currently consume all 1,000K TPM of the subscription's Global Standard quota for each model. Opus exposes 40 RPM and 40,000 TPM. No recent evidence says Lerna needs more.

## September 2026 spend review

The original September 7 audit got the routing and cache behavior right, however the provisional cost math did not hold up against the settled bills.

The 12-hour observation still records 729 mapped calls, 62.75M input tokens, 58.29M cache-read tokens, 4.45M cache-write tokens, and 213,928 output tokens. The 92.89% weighted cache-read rate is still useful.

The original $72.33 Azure estimate is superseded. It charged GPT cache-write tokens as both ordinary input and cache writes, then omitted Microsoft Marketplace charges for Claude.

Settled September cost:

| Ledger | Gross usage | Included discount | Net usage | Fixed fee | September total |
| --- | ---: | ---: | ---: | ---: | ---: |
| GitHub Copilot | 43,665.46 AIC / $436.65 | 19,998.84 AIC / $199.99 | 23,666.62 AIC / $236.67 | $100.00 | $336.67 |
| Microsoft Foundry | $89.12 | N/A | $89.12 | $0.00 | $89.12 of Azure consumption |

The Azure total was $63.12 on Foundry model meters and $26.00 on Microsoft Marketplace Claude meters. Whether that became cash spend depends on the private subscription's remaining credits.

Azure model detail:

| Model group | Settled September cost |
| --- | ---: |
| `gpt-5.6-sol` | $62.35 |
| `gpt-5.6-luna` | $0.64 |
| `gpt-5.6-terra` | $0.12 |
| Claude deployments | $26.00 |

September 7 alone carried $88.92 of the Azure total and 15,391.13 gross GitHub AI credits, or $153.91. Those are UTC-day totals, not the same request set as the original 12-hour audit.

GitHub's billing API does not return zero-priced BYOK calls. The local Copilot ledger remains the evidence that specific mapped rows recorded zero AI credits, while the server-side API now confirms the larger monthly result: all 20,000 included credits were consumed and another 23,666.62 credits were billable.

The full settled review is in [`spend-review-2026-09.json`](spend-review-2026-09.json). The original observation is preserved in [`observed-usage-2026-09-07.json`](observed-usage-2026-09-07.json), with the provisional estimates marked as superseded.

## The cost policy

There are two budgets here, and optimizing one can make the other worse:

1. GitHub cash and AI credits.
2. Azure consumption against subscription credits.

The active Lerna settings still route Luna, Terra, and Opus. Sol is deployed but unmapped. That matches the older policy and the Copilot review on #6 was correct to flag any document claiming otherwise.

The settled month changes the recommendation. September used 218% of the Copilot Max allowance and produced $236.67 in additional GitHub usage. When Azure credits are available, I would route Sol too:

- Route Sol, Luna, Terra, and Opus to Foundry while the Azure credit balance can absorb the usage.
- Leave the two MAI models on Copilot because no same-model Foundry deployment exists.
- Revert Sol to Copilot when Azure credits are exhausted and minimizing total economic consumption matters more than preserving GitHub AI credits.
- Keep the same-model boundary. Do not substitute a cheaper model behind a HydraFusion ID.

This is a recommendation, not the current local setting.

Lerna does not automate the decision today. A budget-aware route policy can use GitHub's supported `ai_credit/usage` endpoint, a user-selected GitHub reserve, an Azure monthly ceiling, and an explicit fallback when either ledger is unavailable. It should not depend on Copilot's undocumented local database.

## Foundry tuning assessment

### Keep `GlobalStandard`

`GlobalStandard` is the right deployment type for this bursty interactive workload. Microsoft routes it through global infrastructure for availability, and it remains pay-as-you-go.

`DataZoneStandard` is a residency choice, not a coding-quality optimization.

Provisioned throughput is a poor fit for this account. The workload is intermittent, there is no sustained utilization case, and the subscription currently uses zero provisioned capacity. Paying for reserved throughput would probably increase spend.

Source: [Microsoft Foundry Models quotas and limits](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/quotas-limits), accessed October 1, 2026.

### Keep the cache key and implicit cache mode

Prompt caching is the largest verified Azure optimization in Lerna.

Microsoft documents that GPT-5.6 caching:

- needs at least 1,024 tokens and an identical first 1,024-token prefix
- can charge for cache writes
- discounts cache reads
- benefits from a stable `prompt_cache_key`
- defaults to implicit mode
- disables caching in explicit mode when no explicit breakpoint is supplied

Lerna adds a stable, scoped `prompt_cache_key` only when the caller did not supply one. It does not guess an explicit breakpoint. September's settled GPT meters cost $63.12. Repricing the same 77.88M prompt tokens as ordinary uncached input would have cost about $345.24 with the billed output unchanged, a $282.12 difference.

Source: [Prompt caching with Azure OpenAI in Microsoft Foundry Models](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching), updated August 11, 2026.

The practical behavior is simple: resume a useful session when the context is still relevant. A fresh one-turn session pays to rebuild a large prefix and may not live long enough to recover the write.

### Slow down automatic model upgrades

All five deployments currently use `OnceNewDefaultVersionAvailable`.

That is convenient, however it can change coding behavior before Lerna has verified the new model version against tool use, long contexts, Responses item normalization, caching, and HydraFusion's planner.

I would change routed deployments to `OnceCurrentVersionExpired`, after confirming Azure exposes that option for each provider. This keeps security and retirement handling automatic while giving us a test window before the default moves.

I would not use `NoAutoUpgrade`. Microsoft documents that an opted-out deployment stops accepting requests when the selected model version retires.

Source: [Model versioning in Microsoft Foundry Models](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/model-versions), accessed October 1, 2026.

### Do not tune content filters for cost

The deployments use `Microsoft.DefaultV2`. There is no evidence that replacing the default RAI policy would materially reduce token spend or improve coding quality, and a custom policy creates another contract Lerna would need to test.

Keep the default unless a real coding request is blocked incorrectly and the exact request can be reproduced.

### Add guardrails around spend, not more request logging

Azure Monitor already keeps platform metrics without a diagnostic setting. This account exposes requests, input and output tokens, cache reads, cache-match rate, time to first token, tokens per second, status code, spillover, and service-tier dimensions.

The resource currently has:

- no diagnostic setting
- no metric alerts
- no resource-group budget

I would add a monthly resource-group budget and a small set of metric alerts for repeated HTTP 429/5xx responses and a material cache-hit collapse.

I would not enable Log Analytics just to keep counting tokens. Microsoft notes that diagnostic routing and Log Analytics add cost. The platform metrics plus dated snapshots are enough until we need longer retention or KQL correlation.

Source: [Monitor Azure OpenAI in Microsoft Foundry Models](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/monitor-openai), accessed October 1, 2026.

Azure Cost Management returned HTTP 429 during the original same-day audit. The October review retrieved settled September `ActualCost`, including the separate Microsoft Marketplace Claude meters.

## Setup assessment

The `/lerna` setup is smaller than the README can make it look. It:

1. Checks the Microsoft device-code URL and user code.
2. Signs into the configured Entra application.
3. Reports whether routes already exist.
4. Enables configured routes.
5. Selects HydraFusion when the host allows it.

It does not create Foundry resources, discover deployments, assign RBAC, or write model mappings.

`tests/setup.test.mjs` covers experimental-feature enablement, legacy setting overrides, refusal paths, HydraFusion switching, Microsoft URL validation, login without configured routes, enable/disable, verbose settings, status formatting, and logout order.

The missing test is a live read-only doctor pass against ARM and the configured deployment endpoints. I think that should be a separate command, not more cloud mutation inside `/lerna`: confirm the resource exists, deployment model equals the HydraFusion key, wire and endpoint match, inference RBAC works, and the model returns a bounded test response.

## Tracking procedure

Run this after a Copilot CLI update, a Foundry deployment change, a pricing change, or an unexplained routing difference.

### 1. Record the Copilot side

- Record the Copilot CLI version.
- Review the public release notes and HydraFusion announcement.
- Compare the bundled model list with `.github/copilot-cli-state.json`.
- Run the planner probe for every Lerna allowlisted model.
- Record the plan version, pattern, phase events, chosen model, and fallback behavior.
- Save only nonsecret summaries. Do not commit prompts, access tokens, session tokens, or provider response bodies.

### 2. Record the Azure inventory

```powershell
$resourceGroup = "YOUR-RESOURCE-GROUP"
$accountName = "YOUR-FOUNDRY-RESOURCE"

az cognitiveservices account deployment list `
  --resource-group $resourceGroup `
  --name $accountName `
  --query "[].{deployment:name,model:properties.model.name,version:properties.model.version,format:properties.model.format,sku:sku.name,capacity:sku.capacity,upgrade:properties.versionUpgradeOption,rai:properties.raiPolicyName,state:properties.provisioningState}" `
  --output table
```

Also record the account's `AI Foundry API` endpoint, region, deployment type, quota assignment, and whether the deployment is present in local Lerna settings.

### 3. Record runtime metrics

Use one fixed UTC window and collect:

- model requests by deployment and status
- input, output, cache-read, and cache-write tokens
- cache-match rate
- time to first token and tokens per second
- HTTP 429, 5xx, spillover, and service-tier dimensions
- GitHub AI credits from Copilot's supported usage view
- Azure actual cost after billing data settles

Do not compare a rolling Azure window with a calendar GitHub window and call the difference savings. The dates have to match.

### 4. Update this file

Update:

- `Last verified`
- known model boundary
- live deployment table
- active route table
- observed cost table
- decisions and caveats
- the change log below

Commit the dated raw snapshot separately when it adds evidence. This file should remain the readable current state.

## Change log

| Date | Change | Evidence | Decision |
| --- | --- | --- | --- |
| 2026-09-07 | Measured 729 mapped calls and a 92.89% weighted cache-read rate. | Observed usage snapshot | Keep the stable cache key and implicit mode. |
| 2026-10-01 | GitHub published HydraFusion's Single, Cascade, and Critique patterns and complete-accounting principle. | Official GitHub announcement | Track every workflow leg, not only the final model. |
| 2026-10-02 | Verified five Foundry deployments and three active Lerna routes. | Live Azure and local configuration | Route Luna, Terra, and Opus; keep Sol ready but unmapped. |
| 2026-10-02 | Settled September Azure cost was $89.12; GitHub reported 43,665.46 gross credits and 23,666.62 net credits after the included allowance. | Azure Cost Management and GitHub billing API | Recommend adding Sol to Foundry while Azure credits remain. |
| 2026-10-02 | Repriced settled GPT meters at ordinary uncached input rates. | Azure Cost Management billed quantities | Keep prompt caching; September GPT savings were about $282.12. |
| 2026-10-02 | Found no diagnostic setting, metric alert, or resource-group budget. | Live Azure configuration | Add a budget and narrow metric alerts before adding paid log retention. |

## Primary sources and repo evidence

- [GitHub HydraFusion announcement](https://github.blog/ai-and-ml/github-copilot/project-hydrafusion-frontier-quality-via-multi-model-orchestration/)
- [GitHub AI-credit billing for individuals](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing)
- [GitHub billing usage REST API](https://docs.github.com/en/rest/billing/usage)
- [Microsoft Foundry prompt caching](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching)
- [Microsoft Foundry quotas and limits](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/quotas-limits)
- [Microsoft Foundry model versioning](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/model-versions)
- [Azure OpenAI monitoring](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/monitor-openai)
- [`RESEARCH.md`](../RESEARCH.md)
- [`observed-usage-2026-09-07.json`](observed-usage-2026-09-07.json)
- [`spend-review-2026-09.json`](spend-review-2026-09.json)
- [`verified-run.json`](verified-run.json)

This is not the service contract. It is the field notebook.
