using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Lerna;

/// <summary>
/// Builds the outbound Microsoft Foundry BYOK request for one accepted-model inference call, in
/// whichever wire format that model's <see cref="ModelMapping"/> declares. Both wires stream
/// their response back through the existing head-then-chunks bridge framing with via="byok";
/// neither implementation ever logs or forwards a raw body, token, or key -- callers pass in an
/// already-minted bearer token and this class never inspects, retains, or echoes it beyond the
/// one outbound Authorization header.
///
/// This class deliberately never parses an upstream *response* body (success or error): the
/// response is streamed through byte-for-byte exactly as received, which is also what makes it
/// naturally tolerant of both Anthropic's native error envelope ({"type":"error","error":{...}})
/// and ARM/CAPI-style errors ({"error":{"code","message"}}) -- neither is ever deserialized here.
/// </summary>
public static class ModelWire
{
    public const string Responses = "responses";
    public const string Anthropic = "anthropic";

    /// <summary>Mandatory on every Anthropic Messages request; omitting it is rejected by Azure
    /// Foundry with HTTP 400 before anything else is even considered.</summary>
    public const string AnthropicVersion = "2023-06-01";

    /// <summary>Structural check that a body already looks like a native Anthropic Messages
    /// request (has "messages" + "max_tokens", lacks Responses-only fields). Used only to
    /// refuse routing a shape we can't safely vouch for -- never to attempt a lossy
    /// translation. Hydra is expected to have already built this shape correctly for a model
    /// mapped to the Anthropic wire; if it hasn't, the caller must leave the request on
    /// Copilot rather than guess at a conversion.</summary>
    public static bool LooksLikeAnthropicMessagesBody(JsonObject body) =>
        body["messages"] is JsonArray
        && body["max_tokens"] is not null
        && body["input"] is null
        && body["previous_response_id"] is null
        && body["instructions"] is null;

    /// <summary>Rewrites body.model to the mapped Azure deployment name. The deployment name is
    /// never assumed to equal the Hydra model ID, even when (as in the user's current mapping)
    /// it happens to match -- the mapping is always the source of truth. Applies identically to
    /// both wires.</summary>
    public static byte[] RewriteModelToDeployment(JsonObject body, ModelMapping mapping)
    {
        body["model"] = mapping.Deployment;
        RemoveForeignEncryptedReasoning(body, mapping);
        NormalizeResponsesInputItemIds(body, mapping);
        ApplyPromptCacheOptimization(body, mapping);
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream)) body.WriteTo(writer);
        return stream.ToArray();
    }

    private static void RemoveForeignEncryptedReasoning(JsonObject body, ModelMapping mapping)
    {
        if (mapping.Wire != Responses || body["input"] is not JsonArray input) return;

        // Encrypted reasoning is provider-bound continuation state. Copilot-hosted Responses calls
        // use opaque base64 IDs, while public Responses reasoning items returned by Azure use rs_
        // IDs. Replaying a Copilot blob to Azure fails with "encrypted content could not be
        // verified". Drop only those foreign reasoning items; keep Azure's own rs_ items so a
        // conversation that remains on the same deployment retains its reasoning continuity.
        for (var index = input.Count - 1; index >= 0; index--)
        {
            if (input[index] is not JsonObject item
                || item["type"]?.GetValue<string>() != "reasoning"
                || item["encrypted_content"]?.GetValueKind() != JsonValueKind.String)
                continue;

            var itemId = item["id"]?.GetValueKind() == JsonValueKind.String
                ? item["id"]!.GetValue<string>() : null;
            if (itemId is null || !itemId.StartsWith("rs_", StringComparison.Ordinal))
                input.RemoveAt(index);
        }
    }

    private static void NormalizeResponsesInputItemIds(JsonObject body, ModelMapping mapping)
    {
        if (mapping.Wire != Responses || body["input"] is not JsonArray input) return;

        // Copilot can attach host-private IDs longer than the public Responses API's 64-character
        // limit when it replays prior message and tool items. They are optional metadata on full
        // input items; call_id remains untouched because it carries the actual tool relationship.
        // item_reference is different: its id is the reference itself, so do not silently alter it.
        foreach (var item in input.OfType<JsonObject>())
        {
            if (item["type"]?.GetValue<string>() == "item_reference") continue;
            if (item["id"]?.GetValueKind() == JsonValueKind.String
                && item["id"]!.GetValue<string>().Length > 64)
                item.Remove("id");
        }
    }

    private static void ApplyPromptCacheOptimization(JsonObject body, ModelMapping mapping)
    {
        if (mapping.Wire != Responses || body["prompt_cache_key"] is not null) return;

        // Azure/OpenAI cap prompt_cache_key at 64 characters. Keep the routing key stable across
        // sessions in the same local workspace, but separate OS users, workspaces, Azure resources,
        // deployments, and caller-supplied safety identities. Azure still requires an identical
        // token prefix for a hit, so this key cannot make unrelated prompts share cached content.
        var seed = string.Join("\n", Environment.UserName, Environment.CurrentDirectory,
            mapping.ResourceId, mapping.Deployment, body["safety_identifier"]?.ToJsonString() ?? "");
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(seed))).ToLowerInvariant();
        body["prompt_cache_key"] = "lerna:" + hash[..58];

        // Do not set prompt_cache_options here. Azure's default implicit mode writes a breakpoint
        // at the latest message. Explicit mode without an explicit content breakpoint disables
        // caching entirely. Caller-provided options and breakpoints are preserved by serialization.
    }

    private const string ResponsesPath = "/openai/v1/responses";
    private const string AnthropicPath = "/anthropic/v1/messages";

    /// <summary>Both wires hang off the same per-resource base endpoint (its ARM "AI Foundry
    /// API" endpoint, e.g. https://&lt;account&gt;.services.ai.azure.com) -- mapping.Endpoint
    /// stores exactly that base, never a fully-built request URL, so one resource can serve both
    /// wires without a stored-URL/wire-format mismatch. The request path is derived here, at
    /// request time, from the wire alone.</summary>
    public static Uri BuildUri(ModelMapping mapping)
    {
        var path = mapping.Wire == Anthropic ? AnthropicPath : ResponsesPath;
        return new Uri(mapping.Endpoint.TrimEnd('/') + path);
    }

    /// <summary>The Azure AD token scope to request. A single Cognitive Services audience token
    /// is verified working against BOTH the OpenAI Responses route and the Anthropic Messages
    /// route on a Foundry resource, so both wires use it and the user signs in once. Requesting
    /// the Foundry v1 audience for the Responses wire was tried and rejected: refreshing into
    /// https://ai.azure.com/.default fails with AADSTS65001 unless that resource is separately
    /// consented, and it buys nothing. No api-key header is ever sent for either wire.</summary>
    public const string CognitiveServicesScope = "https://cognitiveservices.azure.com/.default";
    public const string FoundryV1Scope = "https://ai.azure.com/.default";

    public static string ScopeFor(ModelMapping mapping) => CognitiveServicesScope;

    /// <summary>Builds the outbound HttpRequestMessage for the given mapping's wire. Bearer-only
    /// (never api-key); adds the mandatory anthropic-version header for the Anthropic wire.
    /// No api-version query parameter is ever added -- Microsoft Foundry's Anthropic route neither
    /// needs nor wants one.</summary>
    public static HttpRequestMessage BuildRequest(ModelMapping mapping, byte[] rewrittenBody, string bearerToken)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, BuildUri(mapping))
        {
            Content = new ByteArrayContent(rewrittenBody),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearerToken);
        if (mapping.Wire == Anthropic)
            request.Headers.TryAddWithoutValidation("anthropic-version", AnthropicVersion);
        return request;
    }
}

/// <summary>Mints a fresh Azure AD bearer token scoped to one model mapping's own endpoint
/// audience. Implementations must never cache a token beyond MSAL's own silent cache, never log
/// it, and never mix it with any other audience (ARM, GitHub, etc).</summary>
public interface IAzureTokenProvider
{
    Task<string> GetTokenAsync(ModelMapping mapping, CancellationToken ct);
}

// The real implementation, <see cref="DeviceCodeTokenProvider"/> (Auth.cs), mints tokens via a
// hand-rolled Entra device-code flow on HttpClient -- no Azure.Identity, no MSAL, no NuGet
// package -- since Azure.Identity is backed by MSAL, which is not trim- or AOT-safe. It reads a
// cached-or-refreshed access token per model mapping's own audience and never starts an
// interactive sign-in from inside an inference request; see Auth.cs for the sign-in, cache, and
// refresh logic, and Bridge.cs / Program.cs for how `azure.login`/`lerna login` drive it.
