using System.Globalization;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Lerna;

/// <summary>
/// Hand-rolled Microsoft Entra ID (Azure AD) device-code authentication: no Azure.Identity, no
/// MSAL, no NuGet package of any kind -- everything here is System.Net.Http.HttpClient and
/// System.Text.Json.Nodes, matching the rest of this project's Native-AOT-safe style.
///
/// Three pieces:
///  - <see cref="EntraClient"/>: the raw OAuth 2.0 device authorization grant calls against
///    login.microsoftonline.com (v2.0 endpoints), plus the refresh-token grant.
///  - <see cref="TokenCache"/>: an on-disk, owner-only (0600) cache of one signed-in identity's
///    refresh token and its per-scope access tokens, written atomically.
///  - <see cref="DeviceCodeAuth"/> / <see cref="DeviceCodeTokenProvider"/>: the orchestration
///    used by both the CLI (`lerna login`/`logout`) and the bridge (`azure.login` etc). Inference
///    (<see cref="DeviceCodeTokenProvider.GetTokenAsync"/>) only ever reads the cache or performs
///    a silent refresh; it never starts an interactive device-code flow.
///
/// Nothing in this file ever logs, or includes in an exception message, a token, a device_code,
/// or a refresh_token -- only non-secret identifiers (tenant, scope, expiry, sanitized error
/// codes) ever leave these methods.
/// </summary>
public sealed record DeviceCodeStart(
    string DeviceCode, string UserCode, string VerificationUri, int ExpiresIn, int Interval, string Message);

public sealed record TokenResponse(string AccessToken, string? RefreshToken, int ExpiresIn);

/// <summary>Raised only for a failed token-endpoint grant (device-code poll or refresh); carries
/// the sanitized Entra "error" code only (never a body, header, or token) so callers can special
/// -case invalid_grant (cached refresh token is dead: clear it) versus everything else.</summary>
internal sealed class EntraGrantException(string errorCode) : Exception(errorCode)
{
    public string ErrorCode { get; } = errorCode;
}

/// <summary>Raw calls to the Entra v2.0 device-code and token endpoints. Every request is HTTPS,
/// goes to a fixed login.microsoftonline.com host built from a validated tenant segment, never
/// follows a redirect, and is bounded by both a per-call timeout and a response-size cap.</summary>
internal static class EntraClient
{
    private const string Host = "login.microsoftonline.com";
    private const long MaxResponseBytes = 64 * 1024;

    private static readonly Regex TenantPattern = new("^[A-Za-z0-9.-]{1,100}$", RegexOptions.Compiled);

    private static readonly HttpClient Http = CreateHttpClient();

    private static HttpClient CreateHttpClient()
    {
        var handler = new HttpClientHandler { AllowAutoRedirect = false };
        return new HttpClient(handler)
        {
            Timeout = TimeSpan.FromSeconds(30),
            MaxResponseContentBufferSize = MaxResponseBytes,
        };
    }

    /// <summary>Test-only escape hatch: if set to an http(s) URL on 127.0.0.1/localhost, device
    /// -code/token requests go there instead of login.microsoftonline.com, so tests can run a
    /// local stub server instead of hitting real Entra. Deliberately restricted to loopback
    /// hosts only -- any other value (including a non-loopback https URL) is ignored -- so this
    /// can never be used to redirect a real deployment's token traffic anywhere else. Nothing
    /// about the login.microsoftonline.com host-pinning check below is bypassed for a normal run.
    /// </summary>
    private static readonly Uri? TestBaseUriOverride = ResolveTestBaseUriOverride();

    private static Uri? ResolveTestBaseUriOverride()
    {
        var raw = Environment.GetEnvironmentVariable("LERNA_TEST_ENTRA_BASE_URL");
        if (string.IsNullOrEmpty(raw)) return null;
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri)) return null;
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return null;
        if (uri.Host != "127.0.0.1" && uri.Host != "localhost") return null;
        return uri;
    }

    private static Uri BuildUri(string tenant, string path)
    {
        if (!TenantPattern.IsMatch(tenant)) throw new LernaCliException("Invalid Azure tenant identifier");
        if (TestBaseUriOverride is { } testBase)
            return new Uri(testBase.ToString().TrimEnd('/') + "/" + tenant + path);
        var uri = new Uri($"https://{Host}/{tenant}{path}");
        if (uri.Scheme != Uri.UriSchemeHttps || !string.Equals(uri.Host, Host, StringComparison.OrdinalIgnoreCase))
            throw new LernaCliException("Refusing a non-Entra token endpoint");
        return uri;
    }

    private static async Task<JsonObject> PostFormAsync(Uri uri, Dictionary<string, string> form, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, uri) { Content = new FormUrlEncodedContent(form) };
        HttpResponseMessage response;
        try
        {
            response = await Http.SendAsync(request, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException)
        {
            throw new LernaCliException("Could not reach Azure sign-in (network error)");
        }
        using (response)
        {
            string text;
            try { text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false); }
            catch (HttpRequestException) { throw new LernaCliException("Azure sign-in response was too large"); }

            JsonNode? node;
            try { node = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text); }
            catch (JsonException) { throw new LernaCliException("Azure sign-in returned an unparsable response"); }
            var body = node as JsonObject ?? new JsonObject();

            if (response.IsSuccessStatusCode) return body;

            var errorCode = OptionalString(body, "error");
            if (errorCode is not null) throw new EntraGrantException(errorCode);
            throw new LernaCliException($"Azure sign-in failed (HTTP {(int)response.StatusCode})");
        }
    }

    private static string RequireString(JsonObject obj, string key) =>
        obj[key]?.GetValueKind() == JsonValueKind.String
            ? obj[key]!.GetValue<string>()
            : throw new LernaCliException($"Azure sign-in response missing '{key}'");

    private static string? OptionalString(JsonObject obj, string key) =>
        obj[key]?.GetValueKind() == JsonValueKind.String ? obj[key]!.GetValue<string>() : null;

    private static int OptionalInt(JsonObject obj, string key, int fallback)
    {
        var node = obj[key];
        if (node is null) return fallback;
        if (node.GetValueKind() == JsonValueKind.Number) return node.GetValue<int>();
        if (node.GetValueKind() == JsonValueKind.String && int.TryParse(node.GetValue<string>(), out var parsed)) return parsed;
        return fallback;
    }

    /// <summary>Verification URIs are attacker-influenceable (they come back from an HTTP
    /// response); before ever showing one to the user, require https and a microsoft.com or
    /// microsoftonline.com host.</summary>
    private static void ValidateVerificationUri(string text)
    {
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            throw new LernaCliException("Azure returned an unsafe verification URL");
        var host = uri.Host;
        var ok = host.Equals("microsoft.com", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".microsoft.com", StringComparison.OrdinalIgnoreCase)
            || host.Equals("microsoftonline.com", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".microsoftonline.com", StringComparison.OrdinalIgnoreCase);
        if (!ok) throw new LernaCliException("Azure returned an unrecognized verification URL host");
    }

    public static async Task<DeviceCodeStart> StartDeviceCodeAsync(string tenant, string clientId, string scope, CancellationToken ct)
    {
        var uri = BuildUri(tenant, "/oauth2/v2.0/devicecode");
        var body = await PostFormAsync(uri, new Dictionary<string, string> { ["client_id"] = clientId, ["scope"] = scope }, ct)
            .ConfigureAwait(false);

        var verificationUri = RequireString(body, "verification_uri");
        ValidateVerificationUri(verificationUri);
        var userCode = RequireString(body, "user_code");
        return new DeviceCodeStart(
            RequireString(body, "device_code"),
            userCode,
            verificationUri,
            OptionalInt(body, "expires_in", 900),
            OptionalInt(body, "interval", 5),
            OptionalString(body, "message") ?? $"To sign in, open {verificationUri} and enter the code {userCode}");
    }

    /// <summary>Polls the token endpoint until the user completes (or abandons) sign-in, honoring
    /// authorization_pending/slow_down as continuation signals and treating every other error as
    /// terminal. Never returns without either a token or a thrown, sanitized exception.</summary>
    public static async Task<TokenResponse> PollDeviceCodeAsync(string tenant, string clientId, DeviceCodeStart start, CancellationToken ct)
    {
        var interval = Math.Max(1, start.Interval);
        var deadline = DateTimeOffset.UtcNow.AddSeconds(Math.Max(1, start.ExpiresIn));
        var uri = BuildUri(tenant, "/oauth2/v2.0/token");

        while (true)
        {
            if (DateTimeOffset.UtcNow >= deadline) throw new LernaCliException("Azure device code expired before sign-in completed");
            await Task.Delay(TimeSpan.FromSeconds(interval), ct).ConfigureAwait(false);

            JsonObject body;
            try
            {
                body = await PostFormAsync(uri, new Dictionary<string, string>
                {
                    ["grant_type"] = "urn:ietf:params:oauth:grant-type:device_code",
                    ["client_id"] = clientId,
                    ["device_code"] = start.DeviceCode,
                }, ct).ConfigureAwait(false);
            }
            catch (EntraGrantException ex)
            {
                switch (ex.ErrorCode)
                {
                    case "authorization_pending": continue;
                    case "slow_down": interval += 5; continue;
                    case "authorization_declined": throw new LernaCliException("Azure sign-in was declined");
                    case "expired_token": throw new LernaCliException("Azure device code expired before sign-in completed");
                    case "bad_verification_code": throw new LernaCliException("Azure sign-in failed: invalid device code");
                    default: throw new LernaCliException($"Azure sign-in failed ({ex.ErrorCode})");
                }
            }

            return new TokenResponse(RequireString(body, "access_token"), OptionalString(body, "refresh_token"),
                OptionalInt(body, "expires_in", 3600));
        }
    }

    /// <summary>Redeems a refresh token for a fresh access token in the same scope (used once the
    /// cached access token has expired). Lerna only ever requests one resource scope --
    /// cognitiveservices.azure.com -- so this is always a same-resource refresh in practice;
    /// cross-resource refresh (redeeming into a different resource's scope) was tried against the
    /// live tenant and rejected: it fails with AADSTS65001 unless that other resource is
    /// separately consented, and it is not needed since one Cognitive Services token already
    /// works for both wires.</summary>
    public static async Task<TokenResponse> RefreshAsync(string tenant, string clientId, string refreshToken, string scope, CancellationToken ct)
    {
        var uri = BuildUri(tenant, "/oauth2/v2.0/token");
        // Deliberately no local catch: a failed grant surfaces as EntraGrantException so the
        // caller can special-case invalid_grant (dead refresh token -> clear the cache) versus
        // any other error.
        var body = await PostFormAsync(uri, new Dictionary<string, string>
        {
            ["grant_type"] = "refresh_token",
            ["client_id"] = clientId,
            ["refresh_token"] = refreshToken,
            ["scope"] = scope,
        }, ct).ConfigureAwait(false);
        return new TokenResponse(RequireString(body, "access_token"), OptionalString(body, "refresh_token"),
            OptionalInt(body, "expires_in", 3600));
    }
}

/// <summary>On-disk cache of exactly one signed-in (tenant, clientId) identity: its refresh token
/// plus a per-scope map of access tokens with their absolute UTC expiry. Lives next to the
/// resolved settings.json (same directory, same COPILOT_HOME/--config resolution convention as
/// <see cref="SettingsFile.Resolve"/>), as its own file so it is never round-tripped through the
/// settings.json read/write path. The containing directory is created 0700 and the file itself is
/// always (re)written 0600, atomically via a temp file + rename.</summary>
internal static class TokenCache
{
    private const string FileName = "lerna-auth.json";

    public static string Resolve(string configPath)
    {
        var full = Path.GetFullPath(configPath);
        var directory = Path.GetDirectoryName(full);
        return string.IsNullOrEmpty(directory) ? FileName : Path.Combine(directory, FileName);
    }

    /// <summary>A missing, corrupt, or unreadable cache is never fatal -- it is simply treated as
    /// "not signed in" so a damaged cache file can't crash inference or `lerna status`.</summary>
    public static JsonObject Load(string path)
    {
        try
        {
            if (!File.Exists(path)) return new JsonObject();
            var text = File.ReadAllText(path);
            if (string.IsNullOrWhiteSpace(text)) return new JsonObject();
            return JsonNode.Parse(text) as JsonObject ?? new JsonObject();
        }
        catch (IOException) { return new JsonObject(); }
        catch (UnauthorizedAccessException) { return new JsonObject(); }
        catch (JsonException) { return new JsonObject(); }
    }

    public static void SaveAtomic(string path, JsonObject root)
    {
        var full = Path.GetFullPath(path);
        var directory = Path.GetDirectoryName(full);
        if (!string.IsNullOrEmpty(directory))
        {
            if (!OperatingSystem.IsWindows()) Directory.CreateDirectory(directory,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            else Directory.CreateDirectory(directory);
        }

        var text = root.ToJsonString();
        var tempPath = full + ".tmp-" + Guid.NewGuid().ToString("N");
        if (OperatingSystem.IsWindows())
        {
            File.WriteAllText(tempPath, text);
        }
        else
        {
            var options = new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.None,
                UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite,
            };
            using var stream = new FileStream(tempPath, options);
            var bytes = System.Text.Encoding.UTF8.GetBytes(text);
            stream.Write(bytes, 0, bytes.Length);
        }
        File.Move(tempPath, full, overwrite: true);
    }

    public static void Delete(string path)
    {
        try { File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}

/// <summary>Orchestrates device-code sign-in, cache reads/refreshes, status, and logout. This is
/// the only place that decides whether an interactive flow is allowed to start -- both the CLI
/// login command and the bridge's azure.login op call <see cref="LoginAsync"/> explicitly;
/// nothing else in this class (and nothing in <see cref="DeviceCodeTokenProvider"/>) ever starts
/// one implicitly.</summary>
public static class DeviceCodeAuth
{
    private static readonly SemaphoreSlim RefreshLock = new(1, 1);

    private static string ScopeWithOfflineAccess(string scope) => scope + " offline_access";

    private static (string Tenant, string ClientId) ResolveIdentity(string configPath)
    {
        var root = SettingsFile.LoadRoot(configPath);
        var config = SettingsFile.ReadLerna(root);
        var tenant = string.IsNullOrWhiteSpace(config.Auth?.TenantId) ? "organizations" : config.Auth!.TenantId!;
        var configured = string.IsNullOrWhiteSpace(config.Auth?.ClientId) ? null : config.Auth!.ClientId;
        var clientId = configured ?? Environment.GetEnvironmentVariable("LERNA_CLIENT_ID");
        if (string.IsNullOrWhiteSpace(clientId))
            throw new LernaCliException(
                "No Azure client ID configured; set lerna.auth.clientId in settings.json or the LERNA_CLIENT_ID environment variable");
        return (tenant, clientId);
    }

    private static bool IdentityMatches(JsonObject cache, string tenant, string clientId) =>
        cache["tenantId"]?.GetValueKind() == JsonValueKind.String && cache["tenantId"]!.GetValue<string>() == tenant
        && cache["clientId"]?.GetValueKind() == JsonValueKind.String && cache["clientId"]!.GetValue<string>() == clientId;

    private static bool TryGetFreshAccessToken(JsonObject cache, string tenant, string clientId, string scope, out string accessToken)
    {
        accessToken = "";
        if (!IdentityMatches(cache, tenant, clientId)) return false;
        if (cache["accessTokens"] is not JsonObject tokens || tokens[scope] is not JsonObject entry) return false;
        if (entry["accessToken"]?.GetValueKind() != JsonValueKind.String) return false;
        if (entry["expiresAtUtc"]?.GetValueKind() != JsonValueKind.String) return false;
        if (!DateTimeOffset.TryParse(entry["expiresAtUtc"]!.GetValue<string>(), CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind, out var expiresAt)) return false;
        // Treated as expired 5 minutes early to avoid a request racing a token's real expiry.
        if (expiresAt <= DateTimeOffset.UtcNow.AddMinutes(5)) return false;
        accessToken = entry["accessToken"]!.GetValue<string>();
        return true;
    }

    private static void StoreToken(JsonObject cache, string tenant, string clientId, string scope, TokenResponse token)
    {
        cache["tenantId"] = tenant;
        cache["clientId"] = clientId;
        if (!string.IsNullOrEmpty(token.RefreshToken)) cache["refreshToken"] = token.RefreshToken;

        if (cache["accessTokens"] is not JsonObject tokens)
        {
            tokens = new JsonObject();
            cache["accessTokens"] = tokens;
        }
        tokens[scope] = new JsonObject
        {
            ["accessToken"] = token.AccessToken,
            ["expiresAtUtc"] = DateTimeOffset.UtcNow.AddSeconds(token.ExpiresIn).ToString("O"),
        };
    }

    /// <summary>Returns a usable access token for the given scope, refreshing silently if the
    /// cached one is expired (or absent) but a refresh token is cached. Never starts an
    /// interactive sign-in; throws a clear, actionable <see cref="LernaCliException"/> instead.
    /// </summary>
    public static async Task<string> GetAccessTokenAsync(string configPath, string scope, CancellationToken ct)
    {
        var (tenant, clientId) = ResolveIdentity(configPath);
        var cachePath = TokenCache.Resolve(configPath);

        var cache = TokenCache.Load(cachePath);
        if (TryGetFreshAccessToken(cache, tenant, clientId, scope, out var fresh)) return fresh;

        await RefreshLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // Re-check after acquiring the lock: a concurrent caller may have just refreshed.
            cache = TokenCache.Load(cachePath);
            if (TryGetFreshAccessToken(cache, tenant, clientId, scope, out fresh)) return fresh;

            if (!IdentityMatches(cache, tenant, clientId) || cache["refreshToken"]?.GetValueKind() != JsonValueKind.String)
                throw new LernaCliException("Not signed in to Azure; run `lerna login` first");
            var refreshToken = cache["refreshToken"]!.GetValue<string>();

            TokenResponse refreshed;
            try
            {
                refreshed = await EntraClient.RefreshAsync(tenant, clientId, refreshToken, ScopeWithOfflineAccess(scope), ct)
                    .ConfigureAwait(false);
            }
            catch (EntraGrantException ex) when (ex.ErrorCode == "invalid_grant")
            {
                TokenCache.Delete(cachePath);
                throw new LernaCliException("Azure sign-in has expired; run `lerna login` again");
            }
            catch (EntraGrantException ex)
            {
                throw new LernaCliException($"Could not refresh the Azure access token ({ex.ErrorCode}); try `lerna login` again");
            }

            StoreToken(cache, tenant, clientId, scope, refreshed);
            TokenCache.SaveAtomic(cachePath, cache);
            return refreshed.AccessToken;
        }
        finally
        {
            RefreshLock.Release();
        }
    }

    /// <summary>Runs the full interactive device-code flow: starts it, reports the verification
    /// URL/user code via <paramref name="onProgress"/> (called at least once), polls to
    /// completion, and persists the resulting refresh token + an initial access token for the
    /// Cognitive Services audience, which is the one audience both wires use.
    /// Returns a nonsecret summary only (tenant, expiry) -- never a token.</summary>
    public static async Task<JsonObject> LoginAsync(string configPath, Func<string, string, string, Task> onProgress, CancellationToken ct)
    {
        var (tenant, clientId) = ResolveIdentity(configPath);
        var scope = ModelWire.CognitiveServicesScope;

        var start = await EntraClient.StartDeviceCodeAsync(tenant, clientId, ScopeWithOfflineAccess(scope), ct).ConfigureAwait(false);
        await onProgress(start.Message, start.VerificationUri, start.UserCode).ConfigureAwait(false);

        var token = await EntraClient.PollDeviceCodeAsync(tenant, clientId, start, ct).ConfigureAwait(false);
        if (string.IsNullOrEmpty(token.RefreshToken))
            throw new LernaCliException(
                "Azure sign-in did not return a refresh token (offline_access may be blocked by tenant policy); cannot cache this sign-in");

        var cache = new JsonObject();
        StoreToken(cache, tenant, clientId, scope, token);
        TokenCache.SaveAtomic(TokenCache.Resolve(configPath), cache);

        return new JsonObject { ["tenantId"] = tenant, ["expiresInSeconds"] = token.ExpiresIn };
    }

    /// <summary>Nonsecret sign-in status: whether a usable credential is cached for the currently
    /// configured (tenant, clientId), and the nearest access-token expiry if any. Never includes a
    /// token, refresh token, or device code.</summary>
    public static JsonObject Status(string configPath)
    {
        string tenant, clientId;
        try { (tenant, clientId) = ResolveIdentity(configPath); }
        catch (LernaCliException) { return new JsonObject { ["loggedIn"] = false }; }

        var cache = TokenCache.Load(TokenCache.Resolve(configPath));
        if (!IdentityMatches(cache, tenant, clientId) || cache["refreshToken"]?.GetValueKind() != JsonValueKind.String)
            return new JsonObject { ["loggedIn"] = false };

        string? nearestExpiry = null;
        if (cache["accessTokens"] is JsonObject tokens)
        {
            foreach (var (_, node) in tokens)
            {
                if (node is not JsonObject entry || entry["expiresAtUtc"]?.GetValueKind() != JsonValueKind.String) continue;
                var value = entry["expiresAtUtc"]!.GetValue<string>();
                if (nearestExpiry is null || string.CompareOrdinal(value, nearestExpiry) < 0) nearestExpiry = value;
            }
        }

        return new JsonObject { ["loggedIn"] = true, ["tenantId"] = tenant, ["expiresAtUtc"] = nearestExpiry };
    }

    /// <summary>Deletes the cached credential file outright (there is only ever one cached
    /// identity), regardless of which (tenant, clientId) it belonged to.</summary>
    public static void Logout(string configPath) => TokenCache.Delete(TokenCache.Resolve(configPath));
}

/// <summary>The real <see cref="IAzureTokenProvider"/>: resolves the mapping's scope, returns a
/// cached-or-silently-refreshed access token, and never triggers an interactive sign-in from an
/// inference request -- <see cref="DeviceCodeAuth.GetAccessTokenAsync"/> throws a clear
/// LernaCliException telling the caller to run `lerna login` instead of blocking on a browser.
/// </summary>
public sealed class DeviceCodeTokenProvider(string configPath) : IAzureTokenProvider
{
    public Task<string> GetTokenAsync(ModelMapping mapping, CancellationToken ct) =>
        DeviceCodeAuth.GetAccessTokenAsync(configPath, ModelWire.ScopeFor(mapping), ct);
}
