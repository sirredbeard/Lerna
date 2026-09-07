# Lerna research

Lerna keeps HydraFusion's planner on GitHub Copilot and moves only a mapped model inference call to the same model deployed in Azure Foundry. It is not a universal model proxy, and it is not necessarily cheaper. The point is control: preserve Copilot's orchestration, spend the model leg against an Azure subscription when that is useful, and authenticate with Microsoft Entra rather than a static API key.

## Contents

- [The result](#the-result)
- [Request path](#request-path)
- [Why Lerna is a Copilot plugin](#why-lerna-is-a-copilot-plugin)
- [HydraFusion progress visibility](#hydrafusion-progress-visibility)
- [Model and wire boundaries](#model-and-wire-boundaries)
- [Direct Anthropic routing](#direct-anthropic-routing)
- [Compatible endpoints and model remapping](#compatible-endpoints-and-model-remapping)
- [Microsoft Entra authentication](#microsoft-entra-authentication)
- [Cost comparison](#cost-comparison)
- [Observed Lerna usage](#observed-lerna-usage)
- [How Azure prompt caching works](#how-azure-prompt-caching-works)
- [Why nearly every token was written again](#why-nearly-every-token-was-written-again)
- [The cache optimization](#the-cache-optimization)
- [Limits and follow-up measurements](#limits-and-follow-up-measurements)
- [Diagnosing a stuck `choosing a workflow` run](#diagnosing-a-stuck-choosing-a-workflow-run)
- [Sources](#sources)

## The result

The 12-hour audit from September 7, 2026 at 02:38:42 UTC through 14:38:42 UTC found 729 mapped BYOK calls in Copilot's local usage ledger. Those calls carried 62.75M input tokens, of which 58.29M were cache reads, plus 4.45M cache-write tokens and 213,928 output tokens. The weighted cache-read rate was 92.89%.

| Model | BYOK calls | Input | Cache read | Cache write | Output | Read rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| GPT-5.6 Sol | 624 | 55.13M | 51.58M | 3.54M | 189,063 | 93.55% |
| GPT-5.6 Luna | 100 | 7.54M | 6.67M | 869,845 | 24,526 | 88.45% |
| GPT-5.6 Terra | 2 | 3,500 | 0 | 2,780 | 257 | 0% |
| Claude Opus 5 | 3 | 75,759 | 41,812 | 33,941 | 82 | 55.19% |

At September 7 list rates, the mapped work cost an estimated $72.33 on Azure. The same work with caching disabled would have cost about $283.27, so prompt caching avoided about $210.94. The equivalent GitHub Copilot list cost was about $57.31, or 5,731 AI credits, because Sol costs more on Azure. The actual mapped rows recorded zero GitHub AI credits.

This is a token-based estimate, not an invoice. Azure Cost Management returned HTTP 429 during the audit and same-day cost records can lag. The complete nonsecret result is saved in [`experiments/observed-usage-2026-09-07.json`](experiments/observed-usage-2026-09-07.json).

No model output was 'rewritten'. Azure computed and reused model-side prompt state. The client still sent each request normally.

## Request path

The working request path is:

```text
Copilot CLI
  -> HydraFusion planner on GitHub Copilot
  -> solo plan naming one of six accepted Hydra model IDs
  -> Lerna extension interceptor
  -> native Lerna helper over a JSON-lines process bridge
  -> mapped Azure AI Foundry deployment
  -> streamed response back through Copilot CLI
```

The planner call remains on GitHub Copilot. Lerna does not replace the planner, modify it's selection criteria, or claim that an Azure model is a different model.

The extension intercepts Copilot's `/model/fusion`, `/responses`, and `/v1/messages` calls. Copilot uses `/v1/messages` for Claude. Missing that path was why the first Opus runs stayed on Copilot even though the Foundry mapping was valid. The native helper validates the session, plan shape, selected model, mapping, endpoint, wire format, and credential state before forwarding anything.

A mapped Responses request goes to:

```text
https://<resource>.services.ai.azure.com/openai/v1/responses
```

A mapped Anthropic Messages request goes to:

```text
https://<resource>.services.ai.azure.com/anthropic/v1/messages
```

Responses are streamed through the bridge without parsing or rewriting the provider response body. Lerna reports whether the request went `via: copilot` or `via: byok`, but it does not put access tokens, refresh tokens, request bodies, or provider error bodies in it's normal status output.

## Why Lerna is a GitHub Copilot CLI plugin

HydraFusion already has the hard part: planner state, tool availability, session continuity, response framing, and a known model policy. Replacing that stack would turn Lerna into a second agent runtime. That would be a lot of code to reproduce behavior GitHub already owns, and a lot of nifty ways to get tool calls wrong.

The plugin boundary is smaller:

1. Let HydraFusion choose the model.
2. Confirm the chosen ID is in the Copilot CLI Hydra allowlist.
3. Confirm that exact model has a valid Azure mapping.
4. Replace the request's `model` value with the configured Azure deployment name.
5. Add only provider-specific fields that are documented and safe.
6. Send the request using the wire declared by the mapping.
7. Stream the result back using Copilot's existing extension protocol.

This preserves the useful parts of Copilot while moving one billable inference leg. It also means Lerna cannot add arbitrary models to HydraFusion.

## HydraFusion progress visibility

Copilot CLI already emits considerably more HydraFusion state than it normally shows. Lerna subscribes to some of it now, but forwards the events only to the native helper's state machine and writes them to the extension log. It does not publish them into the visible session timeline.

The public SDK contract includes:

| Event | Useful visible status |
| --- | --- |
| `session.fusion_route_started` | HydraFusion started selecting a route. |
| `session.fusion_resolved` | Pattern, primary model, optional secondary model, fallback model, rule, and routing latency. |
| `assistant.fusion_phase_started` | Phase kind, semantic role, and concrete model started. |
| `assistant.streaming_delta` | Cumulative response bytes received. |
| `assistant.fusion_phase_completed` | Duration, status, token counts, cache counts, request count, and AI-unit cost. |
| `assistant.fusion_phase_failed` | Failure reason, duration, and degraded phase. |
| `session.fusion_completed` | Final source model, total duration, usage, and degraded reason. |

The phase contract is enough for useful live progress in `solo`, `cascade`, and `critique` plans without changing Hydra's orchestration. It is not a full stream of the hidden phase output. There is no `assistant.fusion_phase_delta` event in the Copilot SDK bundled with CLI. The completed event contains the phase's full textual output, however publishing that would duplicate internal model work, expose critic or judge content, and couple Lerna to an experimental contract.

The general SDK also emits `assistant.reasoning_delta`, `assistant.message_delta`, and `assistant.tool_call_delta` when streaming is enabled. Reasoning deltas do not carry a Hydra `fusionId` or `phaseId`, so Lerna displays them only while a HydraFusion phase is active and attributes them to that active phase. Ordinary assistant message deltas remain owned by the CLI renderer.

There is a useful middle ground between routing labels and a reasoning transcript. The SDK also exposes `assistant.intent`, `tool.execution_start`, `tool.execution_progress`, `tool.execution_partial_result`, `tool.execution_complete`, `subagent.started`, `subagent.completed`, and `skill.invoked`. These can describe what Copilot is doing without copying model output:

```text
HydraFusion: cascade route, solver gpt-5.6-sol, reviewer claude-opus-5.
HydraFusion: solver phase started.
Copilot: Exploring the repository.
Sol requested `grep` in `src/Lerna/`.
Tool: `grep` completed in 0.4s, 12 matches.
Sol requested `view` of `src/Lerna/Wire.cs`.
Subagent: Explore started on gpt-5.4-mini.
Subagent: Explore completed in 3.8s, 8 reads, 4 searches.
HydraFusion: solver phase completed, 2.1K output tokens.
```

`tool.execution_start` and `tool.execution_complete` can carry a `fusion` object with the Hydra `fusionId`, pattern, phase ID, phase kind, semantic role, policy, and concrete source model. Lerna can therefore say that Sol requested `grep` during the solver phase instead of merely saying that an unidentified tool started. The same events carry the normal `agentId`, so root and subagent tool calls can be separated.

`assistant.intent` supplies the short human description of the current activity. Tool-start events supply the tool name, generating model, MCP server and tool names, and optional shell path hints. Tool-progress events can carry a human-readable status from an MCP server. Tool-complete events supply success or failure and tool-specific telemetry, and Lerna can calculate elapsed time by pairing the start and completion timestamps with `toolCallId`. Subagent events identify the helper agent, model, mode, and duration. `skill.invoked` identifies a loaded skill without needing to display the skill's instructions.

Copilot already renders ordinary root tool calls. Lerna's useful addition is attribution: which concrete Hydra model requested the tool, or which subagent owns it. Every attributed tool start remains visible, and a subagent completion adds compact totals by category.

The first implementation was too cautious and too repetitive. A real Search Subagent run produced rows such as `Lerna · Read Search Subagent · read_file`, which managed to say `Search` twice and still omit the file. QA changed the rule: use the subagent name once as the label, then show the useful argument.

The formatter now shows:

- `grep` and `file_search` - the expression and repository-relative target
- `view`, `read_file`, `edit`, and `create` - the repository-relative file name
- `bash`, PowerShell, and terminal tools - the bounded command text
- GitHub and MCP tools - server, tool, and bounded query
- web search - the query; web fetch - the destination hostname
- subagents - display name, configured model, foreground/background mode, duration, and completion totals
- skills - skill name only

`tool.execution_partial_result` still contains raw incremental output, and Lerna still discards that payload. Prompts, file contents, completed tool results, provider bodies, and cache keys are not copied into the timeline. Obvious credential assignments and token formats are redacted, however useful file names, regular expressions, commands, URLs, and MCP queries are not hidden just because they are arguments.

### Scoped Lerna verbose mode

`/lerna verbose on` and `/lerna verbose off` control metadata progress without mirroring raw tool output. Verbose mode defaults to on because it is the main reason to install Lerna.

The extension subscribes to fusion, reasoning, tool, subagent, and skill events with SDK streaming enabled at session attach time. It keeps a bounded in-memory map from `toolCallId` to the start summary and attribution, persists route, phase, and tool starts, discards partial tool output, and clears tracked state immediately when verbose mode is turned off. Streaming byte updates are throttled to one every two seconds. The setting changes display behavior without restarting Copilot.

A Cascade turn can look roughly like this:

```text
⎇ Lerna · Route HydraFusion route: cascade, primary Sol, reviewer Opus 5.
⎇ Lerna · Phase HydraFusion started solver on Sol.
⎇ Lerna · Search Sol · `requestSessionId` in `integration`
⎇ Lerna · Read Sol · `src/Lerna/Bridge.cs`
⎇ Lerna Sol is streaming, 48 KiB received.
⎇ Lerna HydraFusion completed solver on Sol in 18.4s: 14.7K input, 2.1K output, 14.4K cached.
⎇ Lerna · Route Sol → Azure Foundry
```

Lerna should use the SDK events as the source of truth. Lerna also sees every response chunk passing through the bridge, so it can measure time to first byte and cumulative bytes for BYOK and Copilot passthrough calls. That is useful as a fallback when `assistant.streaming_delta` is missing, but Lerna should count bytes only. Parsing and republishing provider SSE text would weaken the current byte-for-byte response boundary and create a second renderer beside Copilot's own.

The code surface is small:

- `integration/extensions/lerna/setup.mjs` - parse the two commands and report status
- `integration/extensions/lerna/extension.mjs` - subscribe, format, and serialize visible progress
- `integration/extensions/lerna/bridge.mjs` - report response-head routing without reading model content
- `src/Lerna/Configuration.cs` - persist `verbose` while preserving unrelated settings
- `src/Lerna/Bridge.cs` and `src/Lerna/Program.cs` - expose and update the setting through the existing JSON-lines operations
- `tests/core.test.mjs` and `tests/bridge.test.mjs` - cover persistence, command parsing, event formatting, ordering, and redaction

### Startup announcement

An announcement beside the normal MCP, skill, and extension startup scroll is also feasible. The public extension API cannot add a custom row to Copilot's built-in `session.extensions_loaded` summary. It can call `session.log()` immediately after Lerna attaches and becomes ready, which adds a ordinary informational item to the same timeline:

```text
⎇ Lerna loaded: 4 HydraFusion models routed (gpt-5.6-sol, gpt-5.6-luna, gpt-5.6-terra, claude-opus-5). Verbose on.
```

The message should appear once per extension process, including after `/clear` starts a new session. Exact placement among Copilot's own startup messages is controlled by the host and should not be promised.

## Model and wire boundaries

The Copilot CLI model set verified for HydraFusion is:

| Hydra model | Azure equivalent | Lerna wire |
| --- | --- | --- |
| `gpt-5.6-sol` | Same model | OpenAI Responses |
| `gpt-5.6-terra` | Same model | OpenAI Responses |
| `gpt-5.6-luna` | Same model | OpenAI Responses |
| `claude-opus-5` | Same model | Anthropic Messages |
| `mai-code-1.1-flash` | None | Copilot only |
| `mai-code-1-flash-picker` | None | Copilot only |

Each mapping stores a bare Azure resource endpoint and a wire name. The request path is derived at runtime. This prevents a saved Anthropic URL from being paired with a Responses request, or the reverse. Copilot sends OpenAI-wire calls to CAPI `/responses`, but sends Claude's already-native Anthropic body to CAPI `/v1/messages`; the extension must intercept both paths before the native bridge can route them to their corresponding Foundry endpoints.

Lerna also refuses Azure routing when:

- the model is outside the six-model allowlist
- a mapping is incomplete or malformed
- a Responses request contains `previous_response_id` from another provider
- an Anthropic mapping receives a body that is not already shaped like Anthropic Messages
- the request contains Hydra's fusion session token
- the bound extension session does not match the forwarding session

The refusal path leaves an unsupported request on Copilot when that is safe. It returns a local error when forwarding would mix provider state or disclose a session token.

## Direct Anthropic routing

Anthropic Messages requests can theoretically be sent directly to Anthropic instead of Foundry. The useful part is that this is not a OpenAI-to-Anthropic translation. Hydra already produces a Messages-shaped body for Claude, and Anthropic's native endpoint accepts that same body at:

```text
https://api.anthropic.com/v1/messages
```

The router would still need a separate provider path. Direct Anthropic uses `x-api-key`, `anthropic-version`, and optionally `anthropic-beta` and `anthropic-workspace-id`. Lerna currently derives an Azure `/anthropic/v1/messages` URL, obtains a Cognitive Services bearer token, and sends `Authorization: Bearer`. Changing only the hostname would fail authentication.

The smallest safe design would add a `provider` to each mapping, then let that provider own:

1. The base URL and request path.
2. The credential source and authentication header.
3. Required version and optional beta headers.
4. Model-name validation and rewrite rules.
5. Any provider-specific request limits.

The existing response path is a good fit for direct Anthropic because Lerna streams the response body without parsing or rewriting it. Native Anthropic uses the same named SSE sequence Hydra expects: `message_start`, content-block events, `message_delta`, and `message_stop`. The catch is that Anthropic can add new event types and enum values under it's versioning policy, so the client must ignore unknown events rather than reject them.

This would move the Claude inference leg to an Anthropic account while leaving the Hydra planner on Copilot, the same split Lerna already makes for Foundry. It would also move billing, rate limits, request IDs, data terms, and credential management from Azure to Anthropic. It is technically straightforward, however it is not a config-only change in the current code.

## Compatible endpoints and model remapping

A endpoint that accepts `/v1/messages` is not necessarily interchangeable with Anthropic. There is no published cross-vendor 'Anthropic-compatible' standard or certification. It is a compatibility claim, and there are at least three different levels:

| Compatibility | What it means | What can still break |
| --- | --- | --- |
| Wire-compatible | The endpoint accepts a Messages-shaped JSON request and returns Messages-shaped JSON or SSE. | Authentication, headers, event ordering, errors, and unsupported fields. |
| Behavior-compatible | Tool calls, stop reasons, message roles, and continuation behavior mean the same thing. | Token counts, context limits, safety behavior, latency, and model quality. |
| Feature-compatible | Prompt caching, thinking blocks, citations, PDF/image input, structured output, and beta features work the same way. | Provider rollout dates, quotas, residency, retention, and billing. |

Even Anthropic's official cloud integrations are not identical transports. Google places the model in the URL and `anthropic_version` in the body. Legacy Bedrock uses AWS request signing, provider-specific model IDs, and a different streaming transport. Microsoft Foundry uses deployment names, an Azure endpoint, and Azure authentication. Anthropic's own OpenAI SDK compatibility layer is explicitly intended for testing and comparison, not as the long-term production interface, and it omits or changes features including prompt caching, strict tool schemas, system-message placement, and thinking output.

Remapping the requested model name is easy mechanically. Lerna already replaces `body.model` with an Azure deployment name. The safe case is an alias for the same underlying model, for example `claude-opus-5` to a deployment named `production-opus`. The dangerous case is mapping `claude-opus-5` to a different model because it accepts the same JSON.

The second case can fail quietly:

- a smaller context window can reject or truncate a request
- `tool_use` and `tool_result` blocks can differ in validation or ordering
- streamed tool input arrives as partial JSON strings and must remain valid across the full SSE sequence
- thinking, citations, PDF input, server tools, or cache controls can be ignored
- `stop_reason`, refusal behavior, and mid-stream errors can differ
- tokenizers and cache accounting can make usage and cost reports wrong
- rate-limit and retry semantics can change, including Anthropic's HTTP 529 overload response
- prompts may cross a different retention, residency, or compliance boundary

Anthropic itself demonstrates the risk in it's OpenAI compatibility documentation: unsupported fields are often silently ignored. A third-party endpoint can therefore look healthy in a one-line text test and still fail once Hydra uses tools, caching, thinking, or a long context.

I think Lerna should treat same-model aliases and cross-model substitution as separate features. Same-model aliases can remain normal mappings. Cross-model remapping should be explicit, noisy, and off by default, with a capability declaration for the exact features Hydra uses and live contract tests covering text, tool calls, multi-turn tool results, streaming, cache usage, errors, and the maximum supported context. A successful `200 OK` is not enough.

## Microsoft Entra authentication

Lerna uses the OAuth 2.0 device authorization grant against Microsoft Entra ID. It does not require an Azure API key in `settings.json`, a repository secret, or an environment variable containing a long-lived provider key.

The configured `clientId` is a public-client application registration. The sign-in flow requests:

```text
https://cognitiveservices.azure.com/.default offline_access
```

The local authentication flow is:

1. `lerna login` requests a device code from `login.microsoftonline.com`.
2. The user completes sign-in at Microsoft's verification URL.
3. Lerna polls the token endpoint, including the required `authorization_pending` and `slow_down` handling.
4. Lerna stores the refresh token and per-scope access token in `lerna-auth.json` beside the resolved Copilot settings file.
5. On Linux, the directory is created with mode `0700` and the cache file with mode `0600`.
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

Sol is the exception in this group. Across the 12-hour sample, Sol cost an estimated $71.36 on Azure versus $56.33 at Copilot list rates, a 26.7% Azure premium after cache effects. Luna, Terra, and Opus 5 matched at list price. The total comparison was $72.33 on Azure versus $57.31, or about 5,731 AI credits, through Copilot billing.

That does not mean Copilot would have added $57.31 to the bill. Included plan credits have zero marginal cash cost until they are exhausted. If cash cost is the only objective and Copilot credits are available, leave Sol on Copilot. Azure routing still makes sense for Azure credits, governance, data controls, internal chargeback, or preserving Copilot credits. Contract discounts, taxes, and actual invoice meters can change the result.

GitHub converts model cost into AI credits at `1 AI credit = $0.01`. The monthly individual allowances were:

| Plan | Monthly price | Included AI credits |
| --- | ---: | ---: |
| Copilot Pro | $10 | 1,500 |
| Copilot Pro+ | $39 | 7,000 |
| Copilot Max | $100 | 20,000 |

Copilot Business included 1,900 credits per user and Copilot Enterprise included 3,900 per user, pooled at the billing entity. Paid plans receive a 10% model-cost discount when Copilot's Auto model selection is used. Explicit HydraFusion model selection should not be assumed to receive that discount.

Included credits matter. While a Copilot account has unused included credits, sending the model leg to Azure does not reduce that month's marginal cash cost. It preserves GitHub credits and moves the spend to Azure. That can still be useful when Azure credits, negotiated pricing, internal cost allocation, governance, or deployment control are the objective.

## Observed Lerna usage

The September 7 audit compared three independent views over the same 12-hour window:

1. Copilot's local `assistant_usage_events` ledger.
2. Lerna's temporary response-head diagnostics.
3. Azure Monitor metrics for the `foundry-hb-byok` account in East US 2.

The local ledger contained 729 mapped calls with `total_nano_aiu = 0`: 624 Sol, 100 Luna, 2 Terra, and 3 Opus. Lerna recorded 740 successful BYOK response heads in a nearly identical rolling window. Azure Monitor recorded 743 model requests, 742 successful and one Claude HTTP 400. The small model-level differences are consistent with Azure metric delay and platform availability probes. Claude's Azure token metrics totaled 75,848 prompt tokens, within 0.12% of the 75,759 tokens in the three zero-credit local Opus rows.

The Opus comparison found a real routing bug. Copilot sends Claude's native Anthropic body to CAPI `/v1/messages`; Lerna only intercepted `/responses`. After adding `/v1/messages`, three direct Opus verification calls returned HTTP 200 with `via: byok`, recorded 41,812 cache-read tokens, and recorded zero GitHub AI credits.

The mapped model legs were not the only Copilot usage in those sessions. Explicit Sonnet, Opus, and Haiku agents, compaction, MAI calls, and other unmapped work remained on Copilot. The local ledger recorded about 712 AI credits for that surrounding activity. That is not Lerna overhead as one number: most of it came from explicitly selected Claude agents used during development.

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

## Why nearly every token was written again before we implemented cache optimization

The three verification runs were fresh Copilot sessions. Each run had about 14,668 cache-write tokens and zero cache-read tokens. Azure therefore found no eligible matching prefix for those requests.

We did not log raw model request bodies, cache keys, or prompt text, so the exact mismatch is intentionally unavailable. The likely causes are:

- Copilot omitted `prompt_cache_key`, or generated a different key for each session
- session, tool, repository, or runtime metadata changed early in the prompt
- the stable instructions and tool definitions were not grouped under one reusable key
- implicit mode wrote through the latest message, including context that was not reused

Lerna originally preserved the incoming body except for the model deployment rewrite. That was the safest first release, however it left all cache behavior to Copilot's request shape.

## The cache optimization we implemented

Lerna now adds a cache key only for mapped Azure Responses requests and only when the caller did not already supply one.

The generated key has these properties:

- exactly 64 characters, matching the Responses API limit
- a `lerna:` prefix followed by 58 lowercase SHA-256 hexadecimal characters
- no raw resource name, resource ID, deployment, user identifier, repository path, instruction, tool definition, or prompt text
- scoped by the local OS user and current Copilot workspace
- scoped again by Azure resource ID and deployment
- additionally scoped by `safety_identifier` when the caller supplies one
- stable when session IDs, timestamps, instructions, tool state, or conversation content change inside the same workspace

The cache key is intentionally independent of prompt content. The first attempt hashed Copilot's instructions and tool context into the key, but those fields can contain a timestamp or other per-session metadata. Two otherwise equivalent sessions then received different keys before Azure could compare their token prefixes. The corrected key names the local trust and routing boundary, then lets Azure's required prefix comparison decide whether a cache entry is actually reusable.

Lerna does not add `prompt_cache_options`. This is deliberate. Azure's default `implicit` mode continues to operate, including it's latest-message breakpoint. The earlier incomplete attempt set `mode` to `explicit` without adding an explicit content breakpoint, which disables caching entirely according to Microsoft's August 11, 2026 documentation. That would have removed cache-write charges, but it would not have optimized cache reuse.

Caller policy wins:

- an existing `prompt_cache_key` is preserved byte-for-byte
- existing `prompt_cache_options` are preserved
- existing nested `prompt_cache_breakpoint` fields are preserved
- Anthropic Messages requests are not given OpenAI Responses cache fields
- every mapped Responses request in the same workspace gets the same scoped routing key unless the caller supplies one

The key does not make unlike prompts match. Azure still checks the token prefix. It gives equivalent requests a stable routing hint while keeping request content out of logs and visible identifiers.

No explicit breakpoint is injected yet. Lerna cannot safely guess that arbitrary Copilot `input` content is stable, and the Responses API only permits breakpoints on specific content blocks. A later change can add one after we capture nonsecret structural telemetry showing exactly where Copilot places stable system and tool context.

## Limits and follow-up measurements

The 12-hour sample is enough to answer the cache question. Sol read 93.55% of it's input from cache and Luna read 88.45%. The busiest Sol minute had 11 requests, below Microsoft's warning that more than about 15 requests per minute on one cache key can reduce hits. Sharding the key now would add complexity and probably make reuse worse.

Fresh sessions still pay the write. Four one-turn Sol checks each wrote about 14.7K tokens and read none. Longer sessions reached 91% to 97.5% cache reads, with individual busy minutes often above 98%. Resuming a useful session is a real cost optimization. Replaying the same sentence in a new session is not.

Terra and Opus did not amortize their writes in this small sample. Terra added about $0.007 of cache-write cost across two calls. Three Opus calls cost about $0.024 more with caching than without it because 33,941 write tokens produced only 41,812 reads. This is not enough evidence to disable caching by model. One more reused Opus prefix would likely reverse the result, and a global opt-out would throw away Sol's $209.99 measured saving.

The practical cost choices are:

- Keep the stable workspace/resource/deployment cache key. It worked.
- Keep implicit cache mode. The observed read rate does not justify guessing at explicit content breakpoints.
- Resume long sessions when the context is still useful. Fresh sessions discard most reuse.
- Leave Sol on Copilot when unused included credits matter more than Azure control. Azure Sol was 26.7% more expensive at list price.
- Route Luna, Terra, and Opus according to governance or credit-pool needs; their list prices matched.
- Avoid unnecessary explicit Sonnet, Opus, and Haiku subagents if Copilot AI credits are the constraint. Those calls are outside Lerna's mapped Hydra model leg and remained billable.
- Do not delete idle `GlobalStandard` deployments to chase an idle-charge saving. These deployments were usage billed, not provisioned-throughput reservations.

The temporary extension diagnostics served their purpose. Lerna no longer writes event names or `via`/model response metadata to the extension log. Real-time user-visible routing status remains, while aggregate verification can use the local usage ledger and Azure Monitor without retaining prompts, provider bodies, cache keys, or extra per-request diagnostics.

## `/lerna verbose`

The setting lives in Copilot's existing `lerna` section as `verbose`, defaulting to true unless the user explicitly saves `false`. It is independent of routing: Azure authentication and route mappings are not required, and `lerna.enabled` may remain false. It is persisted atomically, survives enable/disable, reconfiguration, and imported-config replacement, and appears in both native and bridge status output. The bridge rejects missing or non-boolean verbose values instead of silently switching the feature off. The extension accepts:

```text
/lerna verbose on
/lerna verbose off
```

Matching is case-insensitive and ignores surrounding whitespace. The interactive `/lerna` menu exposes the same two choices. The startup message is a persistent Copilot timeline entry after Lerna has attached:

```text
⎇ Lerna loaded: 4 HydraFusion models routed (gpt-5.6-sol, gpt-5.6-luna, gpt-5.6-terra, claude-opus-5). Verbose on.
```

The extension requests SDK streaming at session attach time. Verbose mode renders:

- HydraFusion route selection and resolution
- phase start, live reasoning deltas, throttled byte-count heartbeats, completion, failure, fallback, and turn completion
- each HydraFusion and subagent tool start immediately
- immediate tool failure notices
- subagent start, completion, cancellation, and failure
- skill names when a skill is invoked during HydraFusion or by a subagent

Reasoning deltas use ephemeral cumulative updates while streaming; a completed SDK reasoning event is retained. Route resolution, phase starts, tool starts, and phase, subagent, route, turn, or failure summaries persist in the timeline. No debounce timer can postpone tool activity until the phase finishes. The public extension API only exposes `session.log(message, { level, ephemeral })`; it cannot create or update the CLI's native Search/Edit/Shell cards or choose their left-hand icons. Lerna therefore uses the native log marker plus a unique `⎇` routing glyph and concise labeled lines.

Tool summaries expose bounded useful metadata: repository-relative paths, search expressions, shell and git commands, web queries or hostnames, and MCP server, tool, and query names. JSON-encoded tool arguments are decoded before summarizing them. A subagent can generate dozens of searches, so Lerna shows at most four unique useful operations, omits calls with no file or expression, strips natural-language text appended after a semicolon, and leaves the full totals to the completion line. Common credential assignments and token formats are redacted. Partial or completed tool output, prompts, intent text, provider bodies, and cache keys are not rendered.

Tool starts are correlated by `toolCallId` in a bounded 256-entry map. Partial-result content is discarded. Turning verbose mode off immediately clears tracked state so an old completion cannot appear after the feature is re-enabled.

The implementation changes are in `integration/extensions/lerna/extension.mjs`, `integration/extensions/lerna/setup.mjs`, `integration/extensions/lerna/verbose.mjs`, `src/Lerna/Configuration.cs`, `src/Lerna/Bridge.cs`, and `src/Lerna/Program.cs`. Dedicated reporter tests cover routing, phases, live reasoning, immediate attributed tools, subagents, skills, persistence flags, redaction, discarded partial output, and disabled-state cleanup. Setup and native bridge tests cover both toggle directions, normalization, on-disk persistence, malformed input, and reconfiguration preservation.

### `/lerna` command fixes

The first extension menu mixed routing controls with three Azure discovery operations the native bridge did not provide: `azure.subscriptions`, `azure.deployments`, and `azure.select`. The bridge ignored unknown operations, so each mismatch sat for 120 seconds and eventually printed `Lerna request timed out`. The same mismatch affected `/lerna enable` and `/lerna disable`, which were offered by the extension but missing from the bridge.

The command now leads with routing status, exposes enable, disable, and verbose controls backed by real bridge operations, and treats Azure login as authentication only. Unknown bridge operations return an immediate bounded error instead of hanging. A signed-in user without mappings gets a direct instruction to configure or import a route.

Multi-model status no longer reads `null through null`. It reports the number and IDs of the configured HydraFusion routes. The searchable command description is `Manage HydraFusion verbosity and routing.`

The other timeout was in the JavaScript bridge. A forwarded response had a fixed 125-second lifetime, even after headers and chunks were arriving. A healthy long-running HydraFusion stream could therefore be cancelled in the middle of output. The 125-second limit is now an inactivity timeout refreshed by each response head and chunk. A stalled request still gets cancelled, an active stream does not.

Validation completed:

```text
dotnet build src/Lerna/Lerna.csproj -c Release --no-restore
Build succeeded. 0 warnings, 0 errors.

node --check integration/extensions/lerna/extension.mjs
node --check integration/extensions/lerna/setup.mjs
node --check integration/extensions/lerna/verbose.mjs
node --test tests/*.test.mjs
102 tests passed, 0 failed.

git diff --check
passed
```

The fixture suite was followed by a live terminal pass on the supported Copilot CLI build under a newly created local user. `/lerna`, status, enable, disable, both verbose settings, login initiation, and logout were exercised. That pass found one real bug: the logout prompt promised to disable routing but only removed authentication. `/lerna logout` now disables routing first, then removes the cached sign-in.

The remaining host-controlled limitation is visual placement: Copilot decides how `session.log()` entries appear in the scroll, and the public extension API cannot change the built-in `session.extensions_loaded` summary or guarantee ordering against the host's MCP and skill-loading announcements. The stream includes SDK-provided reasoning deltas while a HydraFusion phase is active, however it cannot expose hidden phase output when the SDK does not emit it.

## Diagnosing a stuck `choosing a workflow` run

A real hang on 2026-09-07 was worth checking against the actual extension logs instead of guessing. `~/.copilot/logs/extensions/plugin-lerna_lerna-*.log` is one process per attach, named by launch PID, and each starts with a `launch pid=` line and the `SESSION_ID` it attached to, so grepping by session ID lines up every process a single Copilot run went through.

The process live during the stall reported `Lerna ready; interception enabled.` and, while temporary diagnostics were enabled, a run of successful BYOK response heads through several full fusion phases. It ended normally with no request left unanswered. That ruled out Azure, the wire adapter, and the native bridge for that incident. The temporary per-request diagnostics were then removed; the user-facing route and phase entries carry the useful result without filling the extension log.

A separate test on 2026-09-07 launched two supported Copilot CLI processes in headless mode at the same time while an older Copilot process was still present. Both returned the requested response and both extension logs reported `interception enabled`. A forced `SIGKILL` of another active Copilot process also removed its child `lerna serve` process within five seconds. Lerna is process-local: concurrent terminals do not share a service, port, lock file, or bound session.

`Cannot set LLM inference provider while sessions are active` is narrower. The supported Copilot CLI build rejects registration when another session object already exists inside the same host process, commonly after an in-process restart or resume path. It is not evidence of another terminal or an orphaned Lerna service. There is no bridge operation or public SDK call that can evict that in-process provider, so only that Copilot process needs to be restarted.

## Responses input item IDs

A live Luna phase failed on 2026-09-07 with Azure HTTP 400: `Invalid 'input[1].id': string too long`, 428 characters against a 64-character maximum. Lerna did not create that value; Copilot supplied it on a replayed Responses input item. Lerna was still part of the compatibility failure because it forwarded host-private metadata to a public Azure endpoint without normalizing it.

A direct Azure check confirmed the boundary: the same minimal Luna request returned HTTP 200 without the item ID and the matching 400 with a 428-character item ID. Full message and tool-output items do not require their top-level `id`, so Lerna now removes only oversized optional IDs before forwarding. It preserves IDs up to 64 characters, preserves `call_id`, and does not alter `item_reference.id`, where the ID is the reference itself.

The fixed native binary was then used in a new HydraFusion critique run. Luna and Terra both returned HTTP 200, both phases completed, and Luna remained the final source.

## Sources

- [GitHub Copilot models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)
- [GitHub Copilot plans](https://docs.github.com/en/copilot/get-started/plans)
- [GitHub Copilot Auto model selection](https://docs.github.com/en/copilot/concepts/models/auto-model-selection)
- [GitHub Copilot CLI command reference](https://docs.github.com/en/copilot/reference/cli-command-reference)
- [GitHub Copilot SDK streaming events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
- [GitHub Copilot SDK extensions](https://github.com/github/copilot-sdk/blob/main/nodejs/docs/extensions.md)
- Copilot CLI bundled SDK contracts: `copilot-sdk/session.d.ts`, `copilot-sdk/types.d.ts`, and `copilot-sdk/generated/session-events.d.ts`
- [Azure OpenAI pricing](https://azure.microsoft.com/en-us/pricing/details/azure-openai/)
- [Microsoft Foundry prompt caching](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching)
- [Anthropic model and prompt-cache pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages)
- [Anthropic API versioning](https://platform.claude.com/docs/en/api/versioning)
- [Anthropic streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
- [Anthropic API errors](https://platform.claude.com/docs/en/api/errors)
- [Anthropic OpenAI SDK compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)
- [Claude in Microsoft Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry)
- [Claude on Google Cloud](https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai)
- [Claude on Amazon Bedrock](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock)
- Repository code: `integration/extensions/lerna/extension.mjs`, `integration/extensions/lerna/bridge.mjs`, `src/Lerna/Bridge.cs`, `src/Lerna/Wire.cs`, and `src/Lerna/Auth.cs`
