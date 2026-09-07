using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Lerna;

/// <summary>
/// Builds the outbound Azure Foundry BYOK request for one accepted-model inference call, in
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
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream)) body.WriteTo(writer);
        return stream.ToArray();
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
    /// No api-version query parameter is ever added -- Azure Foundry's Anthropic route neither
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
