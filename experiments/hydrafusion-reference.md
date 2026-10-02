# HydraFusion reference log

This is not official HydraFusion documentation. There is no public source repo for it, at least not one that is stable or usable as the ground truth for production work. This file is the local reference for what we know, what we have observed, what we route, what we pay, and what we should keep watching.

The goal is simple: keep one place in the repo where we track the actual contract, the Azure side, the Copilot side, and the cost math without pretending that this is a formal API spec.

## The short version

HydraFusion is a Copilot-side planner. It chooses a model from a fixed allowlist, then the Lerna extension can answer a mapped model call against Microsoft Foundry while leaving the planner and session flow on GitHub Copilot.

The practical contract we have observed is:

- HydraFusion picks the model ID, not us.
- Lerna only sees the selected model after the planner has already chosen it.
- Lerna may rewrite only the request for a mapped deployment.
- The Azure side must match the exact model behind the selected HydraFusion ID.
- Prompt caching is the real cost lever on the Azure leg.
- Copilot AI credits are still real, and unmapped work still burns them.

## What is discoverable

This is the useful data path we have found:

1. Copilot CLI exposes HydraFusion events and model IDs.
2. Lerna can observe when HydraFusion starts, resolves, phases, and completes.
3. Copilot local usage rows show mapped model calls and the AI credits that were not spent on the BYOK leg.
4. Azure Monitor shows actual model requests, token counts, cache reads, cache writes, latency, and errors.
5. The Azure account itself shows which deployments exist, which model versions are live, and what capacity is set.

That is enough to track the feature over time without reading hidden provider code.

## Known model IDs and routing boundaries

The current HydraFusion allowlist in this repo is the six-model set Lerna is built around:

| HydraFusion model ID | Azure equivalent | Lerna wire | Status |
| --- | --- | --- | --- |
| `gpt-5.6-sol` | same model | OpenAI Responses | routed via Azure when mapped |
| `gpt-5.6-luna` | same model | OpenAI Responses | routed via Azure when mapped |
| `gpt-5.6-terra` | same model | OpenAI Responses | routed via Azure when mapped |
| `claude-opus-5` | same model | Anthropic Messages | routed via Azure when mapped |
| `mai-code-1.1-flash` | none | Copilot only | not routed in Lerna |
| `mai-code-1-flash-picker` | none | Copilot only | not routed in Lerna |

The important part is that Lerna does not add models to HydraFusion. It only forwards a selected HydraFusion model to a matching Foundry deployment.

## Current Azure deployment state

This account is live and authenticated under the Visual Studio Enterprise subscription.

Resource name: `YOUR-FOUNDRY-RESOURCE`
Resource group: `YOUR-RESOURCE-GROUP`
Region: `YOUR-REGION`
Account kind: `YOUR-ACCOUNT-KIND`

Current deployments recorded by Azure:

| Deployment | Model | Format | Version | Capacity | Provisioning |
| --- | --- | --- | --- | ---: | --- |
| `gpt-5.6-terra` | `gpt-5.6-terra` | OpenAI | `2026-07-09` | 1000 | Succeeded |
| `claude-sonnet-4-6` | `claude-sonnet-4-6` | Anthropic | `1` | 80 | Succeeded |
| `gpt-5.6-sol` | `gpt-5.6-sol` | OpenAI | `2026-07-09` | 1000 | Succeeded |
| `gpt-5.6-luna` | `gpt-5.6-luna` | OpenAI | `2026-07-09` | 1000 | Succeeded |
| `claude-opus-5` | `claude-opus-5` | Anthropic | `2` | 40 | Succeeded |

This is the real deployment inventory we should compare against the Copilot model IDs. The `claude-sonnet-4-6` deployment is present, but it is not a HydraFusion model ID in the current allowlist. It is still worth tracking because it is a real Azure deployment and a possible test lane for Anthropic routing or future route experiments.

## Observed cost and burn data

The strongest evidence in this repo is the 12-hour audit saved at `experiments/observed-usage-2026-09-07.json`.

The aggregate result was:

- 729 mapped BYOK calls
- 62.75M input tokens
- 58.29M cache-read tokens
- 4.45M cache-write tokens
- 213,928 output tokens
- 92.89% weighted cache-read rate
- Azure estimated spend: about $72.33
- same work without cache: about $283.27
- prompt caching avoided roughly $210.94
- equivalent Copilot list cost: about $57.31

So the observed pattern is not 'Azure is always cheaper.' It is 'Azure can be a good home for the Hydra model leg when we want to preserve Copilot credits and use Azure credits or internal chargeback.'

The model-level result is the part that matters most:

| Model | Azure est. cost | Copilot list cost | Notes |
| --- | ---: | ---: | --- |
| `gpt-5.6-sol` | $71.36 | $56.33 | Sol stayed ~26.7% more expensive on Azure after cache effects |
| `gpt-5.6-luna` | $0.55 | $0.55 | basically matching |
| `gpt-5.6-terra` | $0.017 | $0.017 | very little traffic |
| `claude-opus-5` | $0.40 | $0.40 | matching at list rate |

The cost story is more nuanced than a blanket 'BYOK always wins.' The real win is preserving GitHub AI credits on the Hydra leg while spending Azure credits for the mapped model work, especially when the route is cache-heavy and you want to keep Copilot credit burn down.

## Routing details we should keep stable

The safe working setup is:

- keep HydraFusion enabled inside Copilot CLI
- keep Lerna's Azure route mapping to exact Hydra model IDs only
- keep the deployment name and endpoint aligned to the mapped model
- keep the Azure endpoint as the bare resource base and let Lerna append the correct path
- keep a single stable `prompt_cache_key` on mapped Responses requests
- keep implicit cache behavior unless we have a good reason to move to something more explicit
- let Copilot keep doing planner work and tool orchestration

What we should avoid:

- remapping Hydra IDs to a different underlying model
- changing the route in a way that breaks the wire contract
- adding extra provider-specific rewrite logic without live verification
- routing extra non-Hydra work through Azure just because it is convenient
- assuming one model's cache profile is the same as another model's

## How to track changes over time

This repo is already the right place to keep the audit trail. The pattern should be:

- keep a dated JSON snapshot in `experiments/`
- keep one markdown record with the current state and decisions in `experiments/hydrafusion-reference.md`
- keep notes in `RESEARCH.md` for the deeper reasoning and the why behind the route choice
- keep one 'current Azure inventory' snapshot after any deployment change or regional move

A good file naming pattern is:

- `experiments/observed-usage-YYYY-MM-DD.json`
- `experiments/hydrafusion-reference.md`
- plus a short note or checklist when a deployment, quota, or model version changes

The main things to compare over time:

- Copilot CLI version
- HydraFusion allowlist and experimental flags
- selected model and route pattern
- Azure resource name, region, deployment versions, and SKU
- token mix: input, output, cache read, cache write
- hit rate and write rate
- Azure cost, copilot cost, and the delta
- whether the route is still preserving GitHub AI credits

## What improves efficiency for coding

These are the optimizations that matter the most to us right now:

1. Keep mapped Hydra calls on Azure and off Copilot when we want to spend Azure credits instead of GitHub credits.
2. Keep route selection limited to the exact six Hydra IDs. Do not chase provider-quirky new model IDs unless Copilot itself states they are valid.
3. Keep cache behavior stable. The measured work showed a strong cache hit rate, and the real savings came from that reuse.
4. Do not push every subagent, extra reasoning pass, or explicit Sonnet/Opus agent through the Azure route. Those still burn GitHub credits if they are not mapped.
5. Keep the same-model mapping. The good path is exact model identity, not a 'close enough' alias.
6. Monitor the actual Azure spending and the actual Copilot usage ledger together. One side alone lies.

There is one thing I would not do: turn off caching globally just because a small Opus sample was a write-heavy miss. The evidence here says the stable key and implicit cache mode were the win. We should optimize around that, not around a model-specific panic.

## The optimization playbook

For this repo and this Azure account, the sensible baseline is:

- remain on the exact Hydra model IDs already accepted by Copilot
- keep `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`, and `claude-opus-5` mapped to the matching Azure deployments
- keep `claude-sonnet-4-6` in the account for future experiments, but do not treat it as a Hydra model unless the planner accepts it
- use Azure spending for the mapped route, not for every model call in the session
- keep the cache key stable and avoid session-scoped junk in the key material
- watch the prompt-cache hit rate before changing cache policy

If the goal is 'reduce GitHub AIC burn while not spending crazy money', then the best tradeoff is not 'route everything to Azure'. It is 'route the mapped Hydra leg to Azure while keeping the nonmapped tool and subagent overhead on Copilot, and keep caching healthy.'

## What to watch next

The next changes to track are:

- new Copilot CLI builds that add or change HydraFusion model IDs
- model availability and quota shifts in Azure regions
- pricing changes in GitHub Copilot and Microsoft Foundry
- any change in the route that materially affects cache hit rate
- any new deployment names or model versions we should track as candidates

If HydraFusion changes, this file moves with it. If Azure changes, the deployment table moves too. If the cost profile changes, the numbers move. That is the whole point.

### Repo references

- `README.md`
- `RESEARCH.md`
- `experiments/observed-usage-2026-09-07.json`
- `experiments/verified-run.json`

Nothing here is a substitute for the real service contract, but it is the best living reference we have without a public HydraFusion repo.
