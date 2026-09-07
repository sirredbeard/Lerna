# Lerna research

Lerna keeps HydraFusion's planner on GitHub Copilot and moves only a mapped model inference call to the same model deployed in Azure AI Foundry. It is not a universal model proxy, and it is not necessarily cheaper. The point is control: preserve Copilot's orchestration, spend the model leg against an Azure subscription when that is useful, and authenticate with Microsoft Entra rather than a static API key.

This file records what was verified against GitHub Copilot CLI 1.0.83 on September 7, 2026. Prices change. Check the linked pricing pages and the actual Azure invoice before treating these figures as accounting advice.

## Contents

- [The result](#the-result)
- [Request path](#request-path)
- [Why Lerna is a Copilot plugin](#why-lerna-is-a-copilot-plugin)
- [Model and wire boundaries](#model-and-wire-boundaries)
- [Microsoft Entra authentication](#microsoft-entra-authentication)
- [Cost comparison](#cost-comparison)
- [Observed Lerna usage](#observed-lerna-usage)
- [How Azure prompt caching works](#how-azure-prompt-caching-works)
- [Why nearly every token was written again](#why-nearly-every-token-was-written-again)
- [The cache optimization](#the-cache-optimization)
- [Limits and follow-up measurements](#limits-and-follow-up-measurements)
- [Sources](#sources)

## The result

Three successful release-verification sessions each routed `gpt-5.6-sol` through Azure AI Foundry. Each request carried about 14,671 input tokens, wrote about 14,668 prompt-cache tokens, read zero cached tokens, and returned 8 to 10 output tokens.

At the September 7, 2026 Azure `GlobalStandard` rate, one of those Sol calls cost about $0.1653:

| Charge | Tokens | Rate per 1M | Approximate cost |
| --- | ---: | ---: | ---: |
| Input | 14,671 | $5.00 | $0.0734 |
| Cache write | 14,668 | $6.25 | $0.0917 |
| Output | 8 to 10 | $30.00 | $0.0002 to $0.0003 |
| Total | | | $0.1653 |

The cache write was the largest line item. If the 14,668 reusable tokens had been a cache read, that portion would have cost about $0.0073 at $0.50 per 1M tokens, an $0.0844 swing on one request.

No model output was 'rewritten'. Azure computed the prompt prefix and wrote those model-side key/value tensors into a temporary cache. The client still sent the request normally.

## Request path

The working request path is:

```text
Copilot CLI 1.0.83
  -> HydraFusion planner on GitHub Copilot
  -> solo plan naming one of six accepted Hydra model IDs
  -> Lerna extension interceptor
  -> native Lerna helper over a JSON-lines process bridge
  -> mapped Azure AI Foundry deployment
  -> streamed response back through Copilot CLI
```

The planner call remains on GitHub Copilot. Lerna does not replace the planner, modify it's selection criteria, or claim that an Azure model is a different model.

The extension intercepts Copilot's `/model/fusion` and `/responses` calls. The native helper validates the session, plan shape, selected model, mapping, endpoint, wire format, and credential state before forwarding anything.

A mapped Responses request goes to:

```text
https://<resource>.services.ai.azure.com/openai/v1/responses
```

A mapped Anthropic Messages request goes to:

```text
https://<resource>.services.ai.azure.com/anthropic/v1/messages
```

Responses are streamed through the bridge without parsing or rewriting the provider response body. Lerna reports whether the request went `via: copilot` or `via: byok`, but it does not put access tokens, refresh tokens, request bodies, or provider error bodies in it's normal status output.

## Why Lerna is a Copilot plugin

HydraFusion already has the hard part: planner state, tool availability, session continuity, response framing, and a known model policy. Replacing that stack would turn Lerna into a second agent runtime. That would be a lot of code to reproduce behavior GitHub already owns, and a lot of nifty ways to get tool calls wrong.

The plugin boundary is smaller:

1. Let HydraFusion choose the model.
2. Confirm the chosen ID is in the Copilot CLI 1.0.83 Hydra allowlist.
3. Confirm that exact model has a valid Azure mapping.
4. Replace the request's `model` value with the configured Azure deployment name.
5. Add only provider-specific fields that are documented and safe.
6. Send the request using the wire declared by the mapping.
7. Stream the result back using Copilot's existing extension protocol.

This preserves the useful parts of Copilot while moving one billable inference leg. It also means Lerna cannot add arbitrary models to HydraFusion. Hydra's policy accepts six IDs and rejects everything else before Lerna gets a vote.

## Model and wire boundaries

The Copilot CLI 1.0.83 model set verified for HydraFusion is:

| Hydra model | Azure equivalent | Lerna wire |
| --- | --- | --- |
| `gpt-5.6-sol` | Same model | OpenAI Responses |
| `gpt-5.6-terra` | Same model | OpenAI Responses |
| `gpt-5.6-luna` | Same model | OpenAI Responses |
| `claude-opus-5` | Same model | Anthropic Messages |
| `mai-code-1.1-flash` | None | Copilot only |
| `mai-code-1-flash-picker` | None | Copilot only |

The two MAI models cannot be mapped. Lerna refuses the configuration rather than quietly substituting another model.

Each mapping stores a bare Azure resource endpoint and a wire name. The request path is derived at runtime. This prevents a saved Anthropic URL from being paired with a Responses request, or the reverse.

Lerna also refuses Azure routing when:

- the model is outside the six-model allowlist
- a mapping is incomplete or malformed
- a Responses request contains `previous_response_id` from another provider
- an Anthropic mapping receives a body that is not already shaped like Anthropic Messages
- the request contains Hydra's fusion session token
- the bound extension session does not match the forwarding session

The refusal path leaves an unsupported request on Copilot when that is safe. It returns a local error when forwarding would mix provider state or disclose a session token.

## Microsoft Entra authentication

Lerna uses the OAuth 2.0 device authorization grant against Microsoft Entra ID. It does not require an Azure API key in `settings.json`, a repository secret, or an environment variable containing a long-lived provider key.

The configured `clientId` is a public-client application registration. The sign-in flow requests:

```text
https://cognitiveservices.azure.com/.default offline_access
```

The Cognitive Services audience worked for both Azure wire paths. A separate `https://ai.azure.com/.default` token was tested and was not needed. In the tested tenant it also required separate consent and returned `AADSTS65001` without it.

The local authentication flow is:

1. `lerna login` requests a device code from `login.microsoftonline.com`.
2. The user completes sign-in at Microsoft's verification URL.
3. Lerna polls the token endpoint, including the required `authorization_pending` and `slow_down` handling.
4. Lerna stores the refresh token and per-scope access token in `lerna-auth.json` beside the resolved Copilot settings file.
5. On Unix, the directory is created with mode `0700` and the cache file with mode `0600`.
6. Inference uses a fresh cached access token or silently refreshes it. It never starts an interactive login in the middle of a model request.
7. Access tokens are treated as expired five minutes early so a request does not race the real expiry.

The code uses `HttpClient` and `System.Text.Json` directly. It does not use `Azure.Identity` or MSAL because the native helper is published with .NET Native AOT and those dependencies were not a good fit for the trimmed binary.

Only the native helper sees the bearer token. The JavaScript extension bridge sends request metadata and bodies to the local helper, but it does not receive the Azure access token back.

## Cost comparison

All rates below are USD per 1M tokens for the short/default context tier. Azure figures are the published `GlobalStandard` rates collected during this work. GitHub figures are from GitHub's model pricing table on September 7, 2026.

| Model | Provider | Input | Cached input | Cache write | Output |
| --- | --- | ---: | ---: | ---: | ---: |
| GPT-5.6 Sol | Azure Foundry | $5.00 | $0.50 | $6.25 | $30.00 |
| GPT-5.6 Sol | GitHub Copilot | $4.00 | $0.40 | $5.00 | $20.00 |
| GPT-5.6 Terra | Azure Foundry | $2.00 | $0.20 | $2.50 | $12.00 |
| GPT-5.6 Terra | GitHub Copilot | $2.00 | $0.20 | $2.50 | $12.00 |
| GPT-5.6 Luna | Azure Foundry | $0.20 | $0.02 | $0.25 | $1.20 |
| GPT-5.6 Luna | GitHub Copilot | $0.20 | $0.02 | $0.25 | $1.20 |
| Claude Opus 5 | Foundry marketplace | $5.00 | $0.50 | $6.25 for 5m | $25.00 |
| Claude Opus 5 | GitHub Copilot | $5.00 | $0.50 | $6.25 | $25.00 |

Sol is the exception in this group. For the observed prompt shape, the equivalent Copilot charge was about $0.1322, or 13.22 AI credits. The Azure charge was about $0.1653, roughly 25% higher.

Terra, Luna, and Opus 5 matched at list price. Contract discounts, Azure credits, taxes, data-zone premiums, and actual invoice meters can change the result.

GitHub converts model cost into AI credits at `1 AI credit = $0.01`. The monthly individual allowances were:

| Plan | Monthly price | Included AI credits |
| --- | ---: | ---: |
| Copilot Pro | $10 | 1,500 |
| Copilot Pro+ | $39 | 7,000 |
| Copilot Max | $100 | 20,000 |

Copilot Business included 1,900 credits per user and Copilot Enterprise included 3,900 per user, pooled at the billing entity. Paid plans receive a 10% model-cost discount when Copilot's Auto model selection is used. Explicit HydraFusion model selection should not be assumed to receive that discount.

Included credits matter. While a Copilot account has unused included credits, sending the model leg to Azure does not reduce that month's marginal cash cost. It preserves GitHub credits and moves the spend to Azure. That can still be useful when Azure credits, negotiated pricing, internal cost allocation, governance, or deployment control are the objective.

## Observed Lerna usage

The three successful BYOK release-verification sessions selected `gpt-5.6-sol`. The model leg was served by Azure and the Hydra planner stayed on Copilot.

Local Copilot telemetry recorded `total_nano_aiu = NULL` for the BYOK inference legs, while ordinary non-BYOK model calls recorded AI usage. I think that is strong evidence that GitHub did not charge the forwarded model leg. It is not invoice-level proof, and the planner call can still consume Copilot resources.

The two MAI models remain on Copilot because no same-model Azure deployment exists. Any unmapped or rejected request also remains on Copilot.

## How Azure prompt caching works

Prompt caching stores processed input computations, not generated answers. It does not change model output beyond lowering latency and cost when a prefix hits.

For GPT-5.6 and later on Standard pay-as-you-go deployments:

- a cacheable prompt must contain at least 1,024 tokens
- the first 1,024 tokens must be identical
- a single-character difference in that prefix can miss
- `prompt_cache_key` improves routing for requests that share a long prefix
- `prompt_cache_options.ttl` supports `30m`, which is also the default minimum lifetime
- `implicit` mode is the default and writes a breakpoint at the latest message
- `explicit` mode uses only supplied `prompt_cache_breakpoint` markers
- `explicit` mode with no breakpoints disables caching and avoids cache-write charges
- the Responses API permits breakpoints on `input_text`, `input_image`, and `input_file` content blocks
- Standard GPT-5.6 responses report reads as `cached_tokens` and writes as `cache_write_tokens`

A cache key is a routing hint, not a substitute for prefix equality. Two requests with the same key and different first 1,024 tokens do not become equivalent.

The economics are a little odd. Sol's first cached prefix pays $5.00 per 1M input tokens plus $6.25 per 1M cache-write tokens. A later hit costs $0.50 per 1M cached tokens. Compared with sending every request uncached, the first write premium is recovered after roughly two later hits:

```text
first cached use:  $5.00 + $6.25 = $11.25 per 1M prefix tokens
second cached use: $0.50
third cached use:  $0.50
three uncached:    $5.00 * 3 = $15.00
```

One use loses money. Two uses still lose money. Three uses win, assuming the prefix actually hits.

## Why nearly every token was written again

The three verification runs were fresh Copilot sessions. Each run had about 14,668 cache-write tokens and zero cache-read tokens. Azure therefore found no eligible matching prefix for those requests.

We did not log raw model request bodies, cache keys, or prompt text, so the exact mismatch is intentionally unavailable. The likely causes are:

- Copilot omitted `prompt_cache_key`, or generated a different key for each session
- session, tool, repository, or runtime metadata changed early in the prompt
- the stable instructions and tool definitions were not grouped under one reusable key
- implicit mode wrote through the latest message, including context that was not reused

Lerna 1.0.83 originally preserved the incoming body except for the model deployment rewrite. That was the safest first release, however it left all cache behavior to Copilot's request shape.

## The cache optimization

Lerna now adds a cache key only for mapped Azure Responses requests and only when the caller did not already supply one.

The generated key has these properties:

- exactly 64 characters, matching the Responses API limit
- a `lerna:` prefix followed by 58 lowercase SHA-256 hexadecimal characters
- no raw resource name, resource ID, deployment, user identifier, repository text, tool definition, instruction, or prompt text
- scoped by Azure resource ID and deployment
- additionally scoped by `safety_identifier` when the caller supplies one
- changes when stable instructions, system content, tools, tool policy, output schema, or reasoning configuration changes
- stays the same when only user, assistant, or tool-result conversation content changes

Lerna includes leading `system` and `developer` input messages in the stable context, then stops at the first variable conversation item. This lets append-only turns share a cache namespace without baking the latest user request into the key.

Lerna does not add `prompt_cache_options`. This is deliberate. Azure's default `implicit` mode continues to operate, including it's latest-message breakpoint. The earlier incomplete attempt set `mode` to `explicit` without adding an explicit content breakpoint, which disables caching entirely according to Microsoft's August 11, 2026 documentation. That would have removed cache-write charges, but it would not have optimized cache reuse.

Caller policy wins:

- an existing `prompt_cache_key` is preserved byte-for-byte
- existing `prompt_cache_options` are preserved
- existing nested `prompt_cache_breakpoint` fields are preserved
- Anthropic Messages requests are not given OpenAI Responses cache fields
- a one-off Responses request with no stable instructions or tools is left alone

The key does not make unlike prompts match. Azure still checks the token prefix. It gives equivalent requests a stable routing hint while keeping request content out of logs and visible identifiers.

No explicit breakpoint is injected yet. Lerna cannot safely guess that arbitrary Copilot `input` content is stable, and the Responses API only permits breakpoints on specific content blocks. A later change can add one after we capture nonsecret structural telemetry showing exactly where Copilot 1.0.83 places stable system and tool context.

## Limits and follow-up measurements

The code change is covered by local wire tests for key length, stable reuse across different user turns, resource and identity separation, prompt-text secrecy, caller-field preservation, one-off behavior, and the Anthropic boundary.

A release build proves that the request is accepted and routed. It does not prove a cache hit by itself. The next live measurement should make two or more Azure Responses calls within 30 minutes using the same stable prefix and record only:

```text
model
input_tokens
cached_tokens
cache_write_tokens
output_tokens
```

Do not log prompts or cache-key values. A hash comparison is enough to confirm key stability.

The useful success condition is not merely fewer cache writes. It is cache writes turning into cache reads on the second and third request while output and tool behavior remain unchanged.

## Sources

- [GitHub Copilot models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)
- [GitHub Copilot plans](https://docs.github.com/en/copilot/get-started/plans)
- [GitHub Copilot Auto model selection](https://docs.github.com/en/copilot/concepts/models/auto-model-selection)
- [Azure OpenAI pricing](https://azure.microsoft.com/en-us/pricing/details/azure-openai/)
- [Microsoft Foundry prompt caching](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching)
- [Anthropic model and prompt-cache pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- Repository code: `integration/extensions/lerna/extension.mjs`, `integration/extensions/lerna/bridge.mjs`, `src/Lerna/Bridge.cs`, `src/Lerna/Wire.cs`, and `src/Lerna/Auth.cs`

GitHub Copilot CLI 1.0.83 was used while collecting, checking, and writing this research.
