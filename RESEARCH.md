# Lerna research: Copilot vs Azure Foundry cost, prompt caching, and the plugin design

The short version: Lerna is not a magic price arbitrage engine and it is not a promise that Azure is always cheaper than GitHub Copilot. It is a routing shim for HydraFusion. The planner stays on Copilot, the model leg gets moved to your Azure AI Foundry deployment, and the auth is Microsoft Entra rather than a static API key. The real value is control: keep the Copilot planner and model selection logic in place, but decide where inference runs, and do it without handing raw secrets to the plugin.

This matters because the observed cost drift was not random. On the prompt-heavy verification runs we looked at, Azure GPT-5.6 Sol was a little more expensive than Copilot's equivalent Sol rate, and the gap was almost entirely the cache-write line item. The big problem was not "Azure is expensive". The big problem was "we were writing a fresh prompt cache on every run because there was no stable prompt cache key and the prompt prefix changed enough to look new each time."

## What Lerna is doing, technically

Lerna is a native helper and a Copilot extension bridge. The planner call remains on GitHub Copilot. Hydra picks a model from the accepted six-model set. Lerna intercepts the inbound model call and only forwards a mapped model to Azure when that model is configured in `lerna.models` and the Azure deployment is valid.

The architecture is intentionally narrow:

- HydraFusion still decides the model.
- Lerna does not invent a model or relabel one model as another.
- The model ID must match an allowed Hydra model.
- The Azure deployment is paired one-to-one with that model.
- The Entra bearer token is minted for `https://cognitiveservices.azure.com/.default`.
- The outbound request body is rewritten only to swap `model` to the Azure deployment name and, when we add it, to carry a stable prompt-cache key.

That means the request shape stays as close to Copilot's as possible. Lerna does not do a lot of semantic translation. It does not try to rewrite the planner. It does not convert tool calls or reasoning payloads into a different provider's format unless the wire is already known and validated. That is the correct design for a plugin that sits on the hot path of `Copilot CLI`.

## Why this is a plugin, not a rewrite

The design is a plugin because the planner is the part that is expensive to get wrong, and GitHub Copilot already owns that surface area. Putting the model call on Azure is a useful decoupling point, but the planner still needs to be the planner. It is the path that knows which model was chosen, what tools are present, and which session state is valid.

That is not just a UX detail. It is a correctness detail.

If Lerna tried to become a full model-router or a policy engine in the middle of the Copilot request stack, it would start inventing semantics. It would likely break tool-call ordering, session continuity, and response framing. The safer path is to bind to a known set of model IDs, honor the planner's choice, and route only what is already valid.

This is the same reason the plugin uses Microsoft Entra auth instead of a raw Azure API key. An API key is simpler, but it is a static secret in the wrong place. Entra gives us a bearer token scoped to the Azure resource, and that token is cached, refreshed, and owned by the user identity rather than by the repo or the CLI configuration. It matches the actual security posture of a user-managed Azure subscription.

## The cost comparison, in plain English

We compared the pricing on the Azure AI Foundry side against GitHub Copilot credit pricing for the same models.

The relevant Azure rates for the `GlobalStandard` deployments were:

- `gpt-5.6-sol`: $5 input, $0.50 cached input, $6.25 cache write, $30 output per 1M tokens
- `gpt-5.6-terra`: $2 input, $0.20 cached input, $2.50 cache write, $12 output per 1M tokens
- `gpt-5.6-luna`: $0.20 input, $0.02 cached input, $0.25 cache write, $1.20 output per 1M tokens
- `claude-opus-5`: $5 input, $0.50 cache hit, $6.25 five-minute cache write, $25 output per 1M tokens

GitHub's Copilot pricing for the matching models is effectively the same list price for the model leg, with the exception that GitHub converts usage into AI credits at roughly $0.01 per AI credit. The monthly plan carrying different numbers is not the real story. The story is that the model-rate equivalence is close enough that the presence or absence of cache reuse is the real lever.

For the observed verification runs, the real numbers were:

- about 14,671 input tokens
- about 14,668 cache-write tokens
- zero cache-read tokens
- 8 to 10 output tokens

That shape is exactly what you see when the request prefix is treated as a brand-new cache entry every time. On the Azure Sol line, that produced roughly $0.1653 per run.

The rough breakdown is:

- input: about $0.0734
- cache write: about $0.0917
- output: tiny, effectively negligible
- total: about $0.1653

If those same 14,668 tokens had been a cache read instead of a write, the cost would have landed closer to $0.0073 at the cached-input rate rather than $0.0917 at the cache-write rate. That is roughly an $0.0844 swing per request, which is about half of that request's total cost.

That is not a small difference. It is the difference between "cheap enough to be a useful local deployment" and "a prompt-heavy session becomes a tax on every run."

## Why the tokens were rewritten in practice

The prompt-cache behavior on Azure is a little unintuitive, but the fundamental rule is very clear: a cache hit requires the same prefix. A single character change in the first 1,024 tokens can produce a miss. Cache writes are charged separately, and Azure does not keep a free-running "always shared" cache keyed by model or user. The request needs a stable cache key or a stable and repeated prefix.

The observed runs were all fresh Copilot sessions. That matters because the first 1,024 tokens are often session- or context-specific. There are a handful of obvious reasons it looked new every time:

- a new session ID or different tool state
- different ordering of instructions/tool blocks
- different runtime metadata near the front of the request
- no explicit `prompt_cache_key`
- no stable cache prefix for repeated Lerna requests
- no explicit breakpoint to separate stable system context from the variable session payload

That means Azure was doing what it is designed to do: it saw a different prefix, wrote a new cache entry, and charged for it. It was not rewriting the model. It was writing the prompt into the service-side cache as a new entry.

## This is why a Lerna optimization is valid

The safest optimization is not to mutate the whole request. We should not start changing the prompt body in ways that are broader than necessary. The safe optimization is to do two things carefully:

1. Keep the `model` rewrite exactly as it already is.
2. Add a stable, nonsecret `prompt_cache_key` when the request is using the responses wire and the caller did not already provide one.

The key should not contain raw prompts, tokens, or secrets. It should be derived from a stable scope: the resource name or resource ID scope, the Azure deployment name, the model ID, and a hash of the cacheable prefix. That is enough to reuse cache entries across equivalent requests without leaking prompt content.

In other words, the key should look like a namespace and a hash, not like the prompt itself.

That also creates a natural boundary: different repos, different users, and different deployments do not share a key. It is fully local to the resource and the prompt prefix.

## The design constraints in the real code

There are a few lines we should keep straight.

- Lerna is a plugin that runs in the same user context as Copilot CLI.
- The Azure token is requested using the Entra device-code flow and cached beside the local config.
- The native helper is installed from a release artifact and verified with SHA256 before use.
- The plugin bridge should never print secrets or tokens to logs.
- The request body should be preserved as closely as possible.
- We should never invent a cache key that can cross user, repo, or tenant boundaries.

That is why the optimization should be conservative. A prefix hash is okay. A raw prompt key is not. A prompt-cache key with a stable namespace is okay. A policy that blindly reuses cache entries across unrelated requests is not.

## What to do in the code

The right fix is a small change in the model rewrite path. We should add a helper in the Azure wire builder that:

- preserves an existing `prompt_cache_key` if the caller already set one
- otherwise creates a stable key from safe metadata and the cacheable prefix hash
- preserves any user-provided `prompt_cache_options` rather than overwriting them
- only does this for the Azure Responses wire where the prompt-cache fields are actually valid

We do not need to invent a brand-new optimizer. We just need to remove the reason the cache was being recreated on every run: no stable key.

The concrete logic should be roughly:

- `resource name` or `resource scope` from the mapping
- `deployment` and `model`
- a hash of the structured prompt prefix (`instructions`, `tools`, `system`, and similar metadata, but not raw prompt contents)
- a generated key in the form `lerna:<scope>:<deployment>:<sha256(prefix)>`
- `prompt_cache_options` only when not already present, and only with a conservative `mode` + `ttl` shape

That is a targeted optimization, not a broad rewrite. It is safer than trying to reorder the full body or inject a prompt. It keeps the behavior local to the Azure request path and matches the actual issue we observed.

## The practical conclusion

If the goal is to use Azure Foundry as a model backend without throwing money away on cache writes, the optimum is very specific:

- keep the Copilot planner on Copilot
- keep the model selection on Hydra
- route only mapped Azure deployments
- request a stable `prompt_cache_key`
- avoid a fresh disaster on every run
- keep the prompt prefix stable and structured, not random and session-specific

That is the design Lerna should keep. It is cheap, narrow, and it matches both the protocol shape and the security model.

The main thing I would not do is try to make Azure look like a fully separate completion provider. The value is in preserving the planner, the identity, and the user tenant boundary while moving only the model execution leg. That is a good plugin. It is not a universal replacement for Copilot or Azure.

## Final take

The money story is not “Azure is always cheaper.” The money story is “Copilot's planner is still on Copilot, and prompt caching on the Azure side only pays back if the request prefix is stable and the cache key survives across requests.” In our observed runs, it did not, so Azure was writing a fresh prompt cache on nearly every call. The fix is not a broad rewrite of the request. It is the simplest, most boring one: add a stable, scoped, nonsecret prompt-cache key and stop forcing a new cache entry every time.
