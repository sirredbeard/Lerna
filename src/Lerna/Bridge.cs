using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Lerna;

/// <summary>
/// The stdio JSON-lines RPC server used by the JS extension. One line in, one (or a stream
/// of) line(s) out. Owns the in-memory Hydra fusion state machine and the BYOK forwarding path.
/// Never writes to the user's settings file; never logs secrets, headers, or bodies.
/// </summary>
public sealed class Bridge
{
    private const int MaxLineBytes = 24 * 1024 * 1024; // room for a base64'd 16 MiB body
    private const long MaxRequestBodyBytes = 16 * 1024 * 1024;
    private const long MaxPlanResponseBytes = 1 * 1024 * 1024;
    private const int ChunkSize = 32 * 1024;
    private const int MaxConcurrentForwards = 8;
    private static readonly TimeSpan ForwardTimeout = TimeSpan.FromSeconds(120);

    private static readonly HashSet<string> CapiHosts =
    [
        with(StringComparer.OrdinalIgnoreCase),
        "api.individual.githubcopilot.com",
        "api.business.githubcopilot.com",
        "api.enterprise.githubcopilot.com",
        "api.githubcopilot.com",
    ];

    private readonly string _configPath;
    private readonly HttpClient _http;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    // Non-blocking admission control: an Interlocked counter, never a semaphore the reader loop
    // (or a background forward's own completion) would have to block on. Forwards are dispatched
    // as tracked fire-and-forget background work so the reader loop always keeps consuming
    // credit/cancel frames, even while many forwards are streaming.
    private int _inFlightForwards;
    private readonly ConcurrentDictionary<string, ForwardState> _active = new();
    private readonly ConcurrentDictionary<string, string> _environmentOverrides = new();

    private volatile string? _boundSessionId;
    // Per session: has a solo v1 plan just been adapted, awaiting fusion_resolved confirmation.
    // ConcurrentDictionary<string, byte> used as a thread-safe set (value is unused).
    private readonly ConcurrentDictionary<string, byte> _pendingPlan = new();
    // Per session: fusion_resolved confirmed our adapted primary model; one-shot, consumed by
    // the next matching /responses forward so unrelated subagent phases never see it.
    private readonly ConcurrentDictionary<string, byte> _acceptedPrimary = new();
    private readonly ConcurrentDictionary<string, string> _sessionTokens = new();

    private readonly IAzureTokenProvider _azureTokens;

    public Bridge(string configPath) : this(configPath, new DeviceCodeTokenProvider(configPath)) { }

    /// <param name="azureTokens">Injectable (e.g. for tests) independently of the default
    /// <see cref="DeviceCodeTokenProvider"/> wired above, without touching any of the wire/routing
    /// logic elsewhere in this class.</param>
    public Bridge(string configPath, IAzureTokenProvider azureTokens)
    {
        _configPath = configPath;
        _azureTokens = azureTokens;
        var handler = new HttpClientHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.All,
        };
        _http = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
    }

    private LernaConfig LoadConfig()
    {
        try
        {
            var root = SettingsFile.LoadRoot(_configPath);
            return SettingsFile.ReadLerna(root);
        }
        catch (LernaCliException)
        {
            // An unreadable/oversized/corrupt config must never crash serve or be treated as
            // enabled; it is simply unconfigured.
            return LernaConfig.Empty;
        }
    }

    public async Task RunAsync(Stream stdin, Stream stdout)
    {
        var reader = new LineReader(stdin, MaxLineBytes);
        var writer = new OutputWriter(stdout, _writeLock);
        try
        {
            while (true)
            {
                var line = await reader.ReadLineAsync().ConfigureAwait(false);
                if (line is null) break; // stdin EOF
                if (line.Length == 0) continue;

                JsonObject message;
                try
                {
                    message = JsonNode.Parse(line) as JsonObject ?? throw new JsonException("not an object");
                }
                catch (JsonException)
                {
                    continue; // malformed frame; nothing to correlate a reply to, ignore
                }

                await Dispatch(message, writer).ConfigureAwait(false);
            }
        }
        finally
        {
            // Stop cleanly: cancel every active forward and await their completion.
            foreach (var state in _active.Values) state.Cts.Cancel();
            await Task.WhenAll(_active.Values.Select(s => s.Completion.Task)).ConfigureAwait(false);
        }
    }

    private Task Dispatch(JsonObject message, OutputWriter writer)
    {
        var op = message["op"]?.GetValue<string>();
        var id = message["id"]?.GetValue<string>();

        switch (op)
        {
            case "status": return string.IsNullOrEmpty(id) ? Task.CompletedTask : HandleStatus(id, writer);
            case "environment": return string.IsNullOrEmpty(id) ? Task.CompletedTask : HandleEnvironment(id, message, writer);
            case "attach": return string.IsNullOrEmpty(id) ? Task.CompletedTask : HandleAttach(id, message, writer);
            case "event": return string.IsNullOrEmpty(id) ? Task.CompletedTask : HandleEvent(id, message, writer);
            case "forward": return string.IsNullOrEmpty(id) ? Task.CompletedTask : HandleForward(id, message, writer);
            case "import": return string.IsNullOrEmpty(id) ? Task.CompletedTask : HandleImport(id, message, writer);
            case "azure.login": return string.IsNullOrEmpty(id) ? Task.CompletedTask : HandleAzureLogin(id, writer);
            case "azure.status": return string.IsNullOrEmpty(id) ? Task.CompletedTask : HandleAzureStatus(id, writer);
            case "azure.logout": return string.IsNullOrEmpty(id) ? Task.CompletedTask : HandleAzureLogout(id, writer);
            case "credit": HandleCredit(message); return Task.CompletedTask;
            case "cancel": return HandleCancel(message, writer);
            default: return Task.CompletedTask; // unknown op: silently ignored, nothing to reply to safely
        }
    }

    // ---- simple request/result ops ----------------------------------------------------

    private Task HandleStatus(string id, OutputWriter writer)
    {
        var config = LoadConfig();
        var required = new JsonArray();
        if (!string.IsNullOrEmpty(config.KeyEnv)) required.Add((JsonNode?)config.KeyEnv);
        var value = new JsonObject
        {
            ["enabled"] = config.Enabled,
            ["configured"] = config.Configured,
            ["model"] = config.Model,
            ["deployment"] = config.EffectiveDeployment,
            ["endpoint"] = config.Endpoint,
            ["requiredEnvironmentVariables"] = required,
        };
        if (config.Models.Count > 0)
        {
            var models = new JsonArray();
            foreach (var modelId in config.Models.Keys) models.Add((JsonNode?)modelId);
            value["models"] = models;
        }
        return writer.WriteResult(id, value);
    }

    private Task HandleEnvironment(string id, JsonObject message, OutputWriter writer)
    {
        var config = LoadConfig();
        if (message["values"] is JsonObject values && !string.IsNullOrEmpty(config.KeyEnv)
            && values[config.KeyEnv]?.GetValueKind() == JsonValueKind.String)
        {
            // Only ever accept the single configured required variable; never adopt arbitrary
            // names the parent might (accidentally or otherwise) send, and never touch the
            // real process environment.
            _environmentOverrides[config.KeyEnv] = values[config.KeyEnv]!.GetValue<string>();
        }
        return writer.WriteResult(id, true);
    }

    private Task HandleAttach(string id, JsonObject message, OutputWriter writer)
    {
        var sessionId = message["sessionId"]?.GetValue<string>();
        if (!string.IsNullOrEmpty(sessionId))
        {
            _boundSessionId = sessionId;
            _pendingPlan.Clear();
            _acceptedPrimary.Clear();
            _sessionTokens.Clear();
        }
        return writer.WriteResult(id, true);
    }

    private Task HandleEvent(string id, JsonObject message, OutputWriter writer)
    {
        var sessionId = message["sessionId"]?.GetValue<string>();
        var eventName = message["event"]?.GetValue<string>();
        var data = message["data"] as JsonObject;

        if (!string.IsNullOrEmpty(sessionId) && sessionId == _boundSessionId && !string.IsNullOrEmpty(eventName))
        {
            var config = LoadConfig();
            switch (eventName)
            {
                case "session.fusion_resolved":
                    var primaryModel = data?["primaryModel"]?.GetValueKind() == JsonValueKind.String
                        ? data["primaryModel"]!.GetValue<string>() : null;
                    var hadPendingPlan = _pendingPlan.TryRemove(sessionId, out _);
                    if (hadPendingPlan && config.LegacyConfigured && primaryModel == config.Model)
                        _acceptedPrimary.TryAdd(sessionId, 0);
                    else
                        _acceptedPrimary.TryRemove(sessionId, out _);
                    break;
                case "assistant.fusion_phase_failed":
                case "session.fusion_route_failed":
                case "session.fusion_completed":
                case "session.model_change":
                    ClearSessionState(sessionId);
                    break;
                // assistant.fusion_phase_started / fusion_phase_completed: no state transition.
            }
        }
        return writer.WriteResult(id, true);
    }

    private void ClearSessionState(string sessionId)
    {
        _pendingPlan.TryRemove(sessionId, out _);
        _acceptedPrimary.TryRemove(sessionId, out _);
        _sessionTokens.TryRemove(sessionId, out _);
    }

    // ---- import -------------------------------------------------------------------------

    private async Task HandleImport(string id, JsonObject message, OutputWriter writer)
    {
        var repository = message["repository"]?.GetValueKind() == JsonValueKind.String
            ? message["repository"]!.GetValue<string>() : null;
        if (string.IsNullOrEmpty(repository))
        {
            await writer.WriteError(id, "import requires a repository").ConfigureAwait(false);
            return;
        }
        var gitRef = message["ref"]?.GetValueKind() == JsonValueKind.String ? message["ref"]!.GetValue<string>() : null;
        var filePath = message["path"]?.GetValueKind() == JsonValueKind.String ? message["path"]!.GetValue<string>() : null;

        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            var result = await GitHubImport.RunAsync(repository, gitRef, filePath, cts.Token).ConfigureAwait(false);

            var root = SettingsFile.LoadRoot(_configPath);
            SettingsFile.WriteLerna(root, result.Config);
            SettingsFile.SaveRootAtomic(_configPath, root);

            var value = new JsonObject
            {
                ["enabled"] = result.Config.Enabled,
                ["configured"] = result.Config.Configured,
                ["model"] = result.Config.Model,
                ["deployment"] = result.Config.EffectiveDeployment,
                ["endpoint"] = result.Config.Endpoint,
                ["source"] = new JsonObject
                {
                    ["repository"] = result.Config.SourceRepository,
                    ["ref"] = result.Config.SourceRef,
                    ["path"] = result.Config.SourcePath,
                },
            };
            await writer.WriteResult(id, value).ConfigureAwait(false);
        }
        catch (LernaCliException ex)
        {
            await writer.WriteError(id, ex.Message).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            await writer.WriteError(id, "Import timed out contacting GitHub").ConfigureAwait(false);
        }
        catch (Exception)
        {
            // Never surface a raw exception message here: it could contain paths/details we
            // haven't sanitized as carefully as the LernaCliException path above.
            await writer.WriteError(id, "Import failed").ConfigureAwait(false);
        }
    }

    // ---- azure sign-in (device code) ---------------------------------------------------

    private Task HandleAzureStatus(string id, OutputWriter writer) => writer.WriteResult(id, DeviceCodeAuth.Status(_configPath));

    private Task HandleAzureLogout(string id, OutputWriter writer)
    {
        DeviceCodeAuth.Logout(_configPath);
        return writer.WriteResult(id, true);
    }

    /// <summary>Long-running, like a forward: admission (the id -> ForwardState registration) is
    /// synchronous so a racing stdin-EOF/cancel can never miss it, and the actual device-code
    /// flow runs as tracked fire-and-forget background work so the reader loop keeps consuming
    /// cancel/credit frames the whole time it's polling Entra.</summary>
    private Task HandleAzureLogin(string id, OutputWriter writer)
    {
        if (_active.ContainsKey(id)) return writer.WriteError(id, "Duplicate request id");

        var state = new ForwardState();
        if (!_active.TryAdd(id, state))
        {
            state.Dispose();
            return writer.WriteError(id, "Duplicate request id");
        }
        state.Cts.CancelAfter(TimeSpan.FromMinutes(16));

        _ = RunAzureLogin(id, writer, state);
        return Task.CompletedTask;
    }

    private async Task RunAzureLogin(string id, OutputWriter writer, ForwardState state)
    {
        try
        {
            var result = await DeviceCodeAuth.LoginAsync(
                _configPath,
                (message, verificationUri, userCode) => writer.WriteLogin(id, message, verificationUri, userCode),
                state.Cts.Token).ConfigureAwait(false);
            await writer.WriteResult(id, result).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            await writer.WriteError(id, "Azure sign-in cancelled or timed out").ConfigureAwait(false);
        }
        catch (LernaCliException ex)
        {
            await writer.WriteError(id, ex.Message).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // Never surface a raw exception message here: it could contain response details we
            // haven't sanitized as carefully as the LernaCliException path above.
            await writer.WriteError(id, "Azure sign-in failed").ConfigureAwait(false);
        }
        finally
        {
            _active.TryRemove(id, out _);
            state.Completion.TrySetResult();
            state.Dispose();
        }
    }

    // ---- forward / credit / cancel ----------------------------------------------------

    private void HandleCredit(JsonObject message)
    {
        var requestId = message["requestId"]?.GetValue<string>();
        if (requestId is null || !_active.TryGetValue(requestId, out var state)) return;
        // Bounded: never let credit accumulate past 2 in-flight permits.
        if (state.Credit.CurrentCount < 2) state.Credit.Release();
    }

    /// <summary>Only flips the cancellation token here -- the terminal error frame for
    /// <paramref name="message"/>'s requestId is written exactly once, by the background task's
    /// own OperationCanceledException handler (RunForward/RunAzureLogin), not here. Writing it in
    /// both places would emit two frames for the same id.</summary>
    private Task HandleCancel(JsonObject message, OutputWriter writer)
    {
        var requestId = message["requestId"]?.GetValue<string>();
        if (requestId is not null && _active.TryGetValue(requestId, out var state)) state.Cts.Cancel();
        return Task.CompletedTask;
    }

    /// <summary>Admits (or rejects) a forward synchronously -- non-blocking, so the reader loop
    /// never waits on anything here -- then dispatches the actual request/stream as tracked
    /// fire-and-forget background work. This is the fix for the deadlock where awaiting a whole
    /// forward inline in the reader loop meant the very credit/cancel frames that release its
    /// internal per-request semaphore could never be read. Admission (the in-flight counter and
    /// _active.TryAdd) happens here, synchronously, before this method returns, so a
    /// stdin-EOF shutdown racing a just-dispatched forward can never miss it.</summary>
    private Task HandleForward(string id, JsonObject message, OutputWriter writer)
    {
        if (_active.ContainsKey(id)) return writer.WriteError(id, "Duplicate request id");

        if (Interlocked.Increment(ref _inFlightForwards) > MaxConcurrentForwards)
        {
            Interlocked.Decrement(ref _inFlightForwards);
            return writer.WriteError(id, "Too many concurrent Lerna requests; try again shortly");
        }

        var state = new ForwardState();
        if (!_active.TryAdd(id, state))
        {
            Interlocked.Decrement(ref _inFlightForwards);
            state.Dispose();
            return writer.WriteError(id, "Duplicate request id");
        }
        state.Cts.CancelAfter(ForwardTimeout);

        _ = RunForward(id, message, writer, state);
        return Task.CompletedTask;
    }

    private async Task RunForward(string id, JsonObject message, OutputWriter writer, ForwardState state)
    {
        try
        {
            await ExecuteForward(id, message, writer, state.Cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            await writer.WriteError(id, "Lerna request cancelled or timed out").ConfigureAwait(false);
        }
        catch (Exception)
        {
            // Never surface raw exception text: it may contain upstream headers/bodies.
            await writer.WriteError(id, "Lerna forwarding failed").ConfigureAwait(false);
        }
        finally
        {
            _active.TryRemove(id, out _);
            Interlocked.Decrement(ref _inFlightForwards);
            state.Completion.TrySetResult();
            state.Dispose();
        }
    }

    private async Task ExecuteForward(string id, JsonObject message, OutputWriter writer, CancellationToken token)
    {
        var sessionId = message["sessionId"]?.GetValue<string>() ?? "";
        var urlText = message["url"]?.GetValue<string>() ?? throw new LernaCliException("forward requires url");
        var method = message["method"]?.GetValue<string>() ?? "GET";
        var headers = message["headers"] as JsonObject ?? new JsonObject();
        var bodyBase64 = message["body"]?.GetValue<string>() ?? "";

        byte[] body;
        try { body = Convert.FromBase64String(bodyBase64); }
        catch (FormatException) { await writer.WriteError(id, "Invalid request body encoding").ConfigureAwait(false); return; }
        if (body.LongLength > MaxRequestBodyBytes)
        {
            await writer.WriteError(id, "Request body exceeds 16 MiB").ConfigureAwait(false);
            return;
        }

        if (!Uri.TryCreate(urlText, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
        {
            await writer.WriteError(id, "Only HTTPS forwarding is supported").ConfigureAwait(false);
            return;
        }

        var config = LoadConfig();
        var eligible = config.Enabled && config.Configured
            && !string.IsNullOrEmpty(sessionId) && sessionId == _boundSessionId
            && CapiHosts.Contains(uri.Host);

        if (eligible && uri.AbsolutePath == "/model/fusion" && string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase))
        {
            await ForwardFusionPlan(id, uri, headers, body, sessionId, config, writer, token).ConfigureAwait(false);
            return;
        }

        if (eligible && uri.AbsolutePath == "/responses" && string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase))
        {
            if (_acceptedPrimary.ContainsKey(sessionId)
                && await TryForwardByok(id, sessionId, body, config, writer, token).ConfigureAwait(false)) return;
            // Independent of the legacy pendingPlan/fusion_resolved gate: a request whose own
            // declared model is already one of config.Models was never rewritten by us (see
            // TryAdaptPlan's "Unchanged" outcome below), so nothing here needs confirming --
            // we just route that model's inference to its own mapped Azure deployment.
            if (config.Models.Count > 0
                && await TryForwardMapped(id, sessionId, body, config, writer, token).ConfigureAwait(false)) return;
        }

        await ForwardPassthrough(id, uri, method, headers, body, "copilot", null, writer, token).ConfigureAwait(false);
    }

    private async Task ForwardFusionPlan(string id, Uri uri, JsonObject headers, byte[] body, string sessionId,
        LernaConfig config, OutputWriter writer, CancellationToken token)
    {
        using var request = BuildRequest(uri, "POST", headers, body);
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token).ConfigureAwait(false);

        string? adaptedModel = null;
        byte[]? rewritten = null;
        var contentLength = response.Content.Headers.ContentLength;
        if (contentLength is null or <= MaxPlanResponseBytes)
        {
            var raw = await response.Content.ReadAsByteArrayAsync(token).ConfigureAwait(false);
            if (raw.LongLength <= MaxPlanResponseBytes)
            {
                var outcome = TryAdaptPlan(raw, config, out var adapted, out var planToken, out var routedModel);
                switch (outcome)
                {
                    case PlanAdaptOutcome.Unchanged:
                        // Hydra's own chosen model was already mapped: the plan is forwarded
                        // byte-for-byte, nothing was falsified, so no fusion_resolved
                        // confirmation gate is needed -- only the session token is tracked, as
                        // defense-in-depth against ever forwarding it in a later request body.
                        rewritten = raw;
                        _sessionTokens[sessionId] = planToken!;
                        break;
                    case PlanAdaptOutcome.Rewritten:
                        rewritten = adapted;
                        adaptedModel = routedModel;
                        _sessionTokens[sessionId] = planToken!;
                        _pendingPlan.TryAdd(sessionId, 0);
                        break;
                    default:
                        rewritten = raw;
                        break;
                }
            }
        }

        await StreamResponse(id, response, rewritten, "copilot", adaptedModel, writer, token).ConfigureAwait(false);
    }

    /// <summary>Serializes a JsonNode via Utf8JsonWriter directly, avoiding the reflection-based
    /// generic JsonSerializer.Serialize&lt;T&gt; overloads that trigger trimming/AOT warnings.</summary>
    private static byte[] SerializeNode(JsonNode node)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            node.WriteTo(writer);
        }
        return stream.ToArray();
    }

    private enum PlanAdaptOutcome { NotApplicable, Unchanged, Rewritten }

    /// <summary>Decides what (if anything) to do with a solo v1 fusion plan:
    /// - <see cref="PlanAdaptOutcome.Unchanged"/>: the planner's own chosen model is already in
    ///   config.Models -- the plan is left completely alone; that model's later /responses call
    ///   is routed to its own mapped Azure deployment purely by matching its declared model id
    ///   (see TryForwardMapped), with no rewrite and so no confirmation gate required.
    /// - <see cref="PlanAdaptOutcome.Rewritten"/>: the planner's chosen model is unmapped, but
    ///   the legacy single-model BYOK config is set -- preserves the original one-shot
    ///   pendingPlan/fusion_resolved confirmation gate before that rewrite is ever trusted.
    /// - <see cref="PlanAdaptOutcome.NotApplicable"/>: not a recognized solo v1 plan shape, or no
    ///   route (mapped or legacy) exists for it -- forwarded to Copilot untouched.</summary>
    private static PlanAdaptOutcome TryAdaptPlan(
        byte[] raw, LernaConfig config, out byte[] adapted, out string? sessionToken, out string? routedModel)
    {
        adapted = raw;
        sessionToken = null;
        routedModel = null;
        JsonNode? node;
        try { node = JsonNode.Parse(raw); }
        catch (JsonException) { return PlanAdaptOutcome.NotApplicable; }
        if (node is not JsonObject plan) return PlanAdaptOutcome.NotApplicable;

        if (plan["plan_version"]?.GetValueKind() != JsonValueKind.String || plan["plan_version"]!.GetValue<string>() != "1") return PlanAdaptOutcome.NotApplicable;
        if (plan["fusion_mode"]?.GetValueKind() != JsonValueKind.String || plan["fusion_mode"]!.GetValue<string>() != "hydrafusion-max") return PlanAdaptOutcome.NotApplicable;
        if (plan["fusion_pattern"]?.GetValueKind() != JsonValueKind.String || plan["fusion_pattern"]!.GetValue<string>() != "solo") return PlanAdaptOutcome.NotApplicable;
        if (plan["steps"] is not JsonArray { Count: 1 } steps) return PlanAdaptOutcome.NotApplicable;
        if (steps[0] is not JsonObject step) return PlanAdaptOutcome.NotApplicable;
        if (step["role"]?.GetValueKind() != JsonValueKind.String || step["role"]!.GetValue<string>() != "generation") return PlanAdaptOutcome.NotApplicable;
        var session = plan["session"] as JsonObject;
        var tokenValue = session?["token"]?.GetValueKind() == JsonValueKind.String ? session["token"]!.GetValue<string>() : null;
        if (string.IsNullOrEmpty(tokenValue)) return PlanAdaptOutcome.NotApplicable;
        sessionToken = tokenValue;

        var plannedModel = step["model_id"]?.GetValueKind() == JsonValueKind.String ? step["model_id"]!.GetValue<string>() : null;
        if (plannedModel is not null && config.Models.TryGetValue(plannedModel, out var mapping)
            && ModelMappingValidation.FormatErrors(plannedModel, mapping).Count == 0)
        {
            routedModel = plannedModel;
            return PlanAdaptOutcome.Unchanged;
        }

        if (!config.LegacyConfigured) return PlanAdaptOutcome.NotApplicable;

        step["model_id"] = config.Model;
        routedModel = config.Model;
        adapted = SerializeNode(plan);
        return PlanAdaptOutcome.Rewritten;
    }

    /// <summary>Routes an accepted request to whichever model config.Models says it belongs to,
    /// via that model's own wire (Responses or Anthropic) and its own mapped Azure deployment.
    /// Never reached for a model not present (and format-valid) in config.Models; never sends a
    /// request for model A to model B's deployment.</summary>
    private async Task<bool> TryForwardMapped(string id, string sessionId, byte[] body, LernaConfig config,
        OutputWriter writer, CancellationToken token)
    {
        JsonNode? node;
        try { node = JsonNode.Parse(body); }
        catch (JsonException) { return false; }
        if (node is not JsonObject requestBody) return false;

        var modelId = requestBody["model"]?.GetValueKind() == JsonValueKind.String ? requestBody["model"]!.GetValue<string>() : null;
        if (modelId is null || !config.Models.TryGetValue(modelId, out var mapping)) return false;
        if (ModelMappingValidation.FormatErrors(modelId, mapping).Count > 0) return false; // never route on an invalid mapping

        if (mapping.Wire == ModelWire.Anthropic)
        {
            // Hydra is expected to already build an Anthropic Messages-shaped body for a model
            // mapped to this wire. If it hasn't, this is not a translation Lerna will attempt --
            // fall through and leave the request on Copilot rather than guess.
            if (!ModelWire.LooksLikeAnthropicMessagesBody(requestBody)) return false;
        }
        else if (mapping.Wire != ModelWire.Responses)
        {
            return false; // unrecognized/unverified wire: never route
        }
        else if (requestBody["previous_response_id"] is not null)
        {
            // Responses-only continuation concept; a different provider can't honor it.
            await writer.WriteError(id, "Cannot continue a prior response on a different provider").ConfigureAwait(false);
            return true;
        }

        string bearerToken;
        try { bearerToken = await _azureTokens.GetTokenAsync(mapping, token).ConfigureAwait(false); }
        catch (LernaCliException ex) { await writer.WriteError(id, ex.Message).ConfigureAwait(false); return true; }

        var rewrittenBody = ModelWire.RewriteModelToDeployment(requestBody, mapping);

        if (_sessionTokens.TryGetValue(sessionId, out var sessionToken) && !string.IsNullOrEmpty(sessionToken)
            && Encoding.UTF8.GetString(rewrittenBody).Contains(sessionToken, StringComparison.Ordinal))
        {
            await writer.WriteError(id, "Refusing to forward a request containing the fusion session token").ConfigureAwait(false);
            return true;
        }

        using var request = ModelWire.BuildRequest(mapping, rewrittenBody, bearerToken);
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token).ConfigureAwait(false);
        await StreamResponse(id, response, null, "byok", modelId, writer, token).ConfigureAwait(false);
        return true;
    }

    /// <summary>Only reached when a solo v1 plan was previously adapted and confirmed for this
    /// exact session by a matching session.fusion_resolved event (one-shot, consumed here).</summary>
    private async Task<bool> TryForwardByok(string id, string sessionId, byte[] body, LernaConfig config,
        OutputWriter writer, CancellationToken token)
    {
        JsonNode? node;
        try { node = JsonNode.Parse(body); }
        catch (JsonException) { return false; }
        if (node is not JsonObject requestBody) return false;
        if (requestBody["model"]?.GetValueKind() != JsonValueKind.String || requestBody["model"]!.GetValue<string>() != config.Model)
            return false;

        // This is the one committed use of the adapted plan; consume it now regardless of outcome
        // so no other request (subagent or otherwise) can ever reuse this acceptance.
        _acceptedPrimary.TryRemove(sessionId, out _);

        if (requestBody["previous_response_id"] is not null)
        {
            await writer.WriteError(id, "Cannot continue a prior response on a different provider").ConfigureAwait(false);
            return true;
        }

        var apiKey = ResolveApiKey(config);
        if (apiKey is null)
        {
            await writer.WriteError(id, "The configured BYOK credential is unavailable").ConfigureAwait(false);
            return true;
        }

        requestBody["model"] = config.EffectiveDeployment;
        var rewrittenBody = SerializeNode(requestBody);

        if (_sessionTokens.TryGetValue(sessionId, out var sessionToken) && !string.IsNullOrEmpty(sessionToken)
            && Encoding.UTF8.GetString(rewrittenBody).Contains(sessionToken, StringComparison.Ordinal))
        {
            await writer.WriteError(id, "Refusing to forward a request containing the fusion session token").ConfigureAwait(false);
            return true;
        }

        var endpoint = new Uri(config.Endpoint!);
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new ByteArrayContent(rewrittenBody),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Headers.TryAddWithoutValidation("api-key", apiKey);

        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token).ConfigureAwait(false);
        await StreamResponse(id, response, null, "byok", config.Model, writer, token).ConfigureAwait(false);
        return true;
    }

    private string? ResolveApiKey(LernaConfig config)
    {
        if (!string.IsNullOrEmpty(config.KeyEnv))
        {
            if (_environmentOverrides.TryGetValue(config.KeyEnv, out var value) && !string.IsNullOrEmpty(value)) return value;
            var fromProcess = Environment.GetEnvironmentVariable(config.KeyEnv);
            return string.IsNullOrEmpty(fromProcess) ? null : fromProcess;
        }
        if (!string.IsNullOrEmpty(config.KeyFile))
        {
            if (ConfigValidation.CheckKeyFileAccess(config.KeyFile) is not null) return null;
            try
            {
                var text = File.ReadAllText(config.KeyFile).Trim();
                return string.IsNullOrEmpty(text) ? null : text;
            }
            catch (IOException) { return null; }
            catch (UnauthorizedAccessException) { return null; }
        }
        return null;
    }

    private async Task ForwardPassthrough(string id, Uri uri, string method, JsonObject headers, byte[] body,
        string via, string? adaptedModel, OutputWriter writer, CancellationToken token)
    {
        using var request = BuildRequest(uri, method, headers, body);
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token).ConfigureAwait(false);
        await StreamResponse(id, response, null, via, adaptedModel, writer, token).ConfigureAwait(false);
    }

    private static HttpRequestMessage BuildRequest(Uri uri, string method, JsonObject headers, byte[] body)
    {
        var request = new HttpRequestMessage(new HttpMethod(method), uri);
        if (body.Length > 0 || string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase)
            || string.Equals(method, "PUT", StringComparison.OrdinalIgnoreCase))
        {
            request.Content = new ByteArrayContent(body);
        }
        foreach (var (name, value) in headers)
        {
            if (value?.GetValueKind() != JsonValueKind.String) continue;
            var text = value.GetValue<string>();
            if (!request.Headers.TryAddWithoutValidation(name, text))
                request.Content?.Headers.TryAddWithoutValidation(name, text);
        }
        return request;
    }

    private static readonly string[] StaleHeaders = ["content-length", "content-encoding", "transfer-encoding", "etag"];

    /// <summary>Streams a response back credit-by-credit. If `replacementBody` is set, it is sent
    /// as a single buffered chunk (used only for the small, already-buffered plan rewrite);
    /// otherwise the upstream response stream is forwarded unchanged, unbuffered, as it arrives.</summary>
    private async Task StreamResponse(string id, HttpResponseMessage response, byte[]? replacementBody,
        string via, string? adaptedModel, OutputWriter writer, CancellationToken token)
    {
        var headers = new JsonObject();
        foreach (var (name, values) in response.Headers) headers[name] = string.Join(", ", values);
        foreach (var (name, values) in response.Content.Headers) headers[name] = string.Join(", ", values);
        if (replacementBody is not null)
        {
            foreach (var stale in StaleHeaders) headers.Remove(stale);
            headers["content-length"] = replacementBody.LongLength.ToString();
        }

        await writer.WriteHead(id, (int)response.StatusCode, headers, via, adaptedModel).ConfigureAwait(false);

        if (!_active.TryGetValue(id, out var state)) return; // cancelled between accept and here

        if (replacementBody is not null)
        {
            await state.Credit.WaitAsync(token).ConfigureAwait(false);
            await writer.WriteChunk(id, replacementBody).ConfigureAwait(false);
        }
        else
        {
            await using var stream = await response.Content.ReadAsStreamAsync(token).ConfigureAwait(false);
            var buffer = new byte[ChunkSize];
            while (true)
            {
                await state.Credit.WaitAsync(token).ConfigureAwait(false);
                var read = await stream.ReadAsync(buffer.AsMemory(0, ChunkSize), token).ConfigureAwait(false);
                if (read == 0) break;
                await writer.WriteChunk(id, buffer.AsSpan(0, read).ToArray()).ConfigureAwait(false);
            }
        }

        await writer.WriteEnd(id).ConfigureAwait(false);
    }

    private sealed class ForwardState : IDisposable
    {
        public readonly CancellationTokenSource Cts = new();
        public readonly SemaphoreSlim Credit = new(0, 2);
        public readonly TaskCompletionSource Completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public void Dispose() { Cts.Dispose(); Credit.Dispose(); }
    }

    /// <summary>Serializes concurrent writers so stdout JSON-lines never interleave.</summary>
    private sealed class OutputWriter(Stream stream, SemaphoreSlim writeLock)
    {
        public async Task WriteResult(string id, JsonNode? value) =>
            await Write(new JsonObject { ["id"] = id, ["type"] = "result", ["value"] = value }).ConfigureAwait(false);

        public async Task WriteError(string id, string message) =>
            await Write(new JsonObject { ["id"] = id, ["type"] = "error", ["error"] = message }).ConfigureAwait(false);

        public async Task WriteHead(string id, int status, JsonObject headers, string via, string? adaptedModel)
        {
            var message = new JsonObject { ["id"] = id, ["type"] = "head", ["status"] = status, ["headers"] = headers, ["via"] = via };
            if (adaptedModel is not null) message["adaptedModel"] = adaptedModel;
            await Write(message).ConfigureAwait(false);
        }

        public async Task WriteChunk(string id, byte[] data) =>
            await Write(new JsonObject { ["id"] = id, ["type"] = "chunk", ["data"] = Convert.ToBase64String(data) }).ConfigureAwait(false);

        /// <summary>Progress frame for an in-flight azure.login, matching the shape
        /// integration/extensions/lerna/bridge.mjs expects: {id, type:"login", message,
        /// verificationUri, userCode}. Never carries a token or device_code.</summary>
        public async Task WriteLogin(string id, string message, string verificationUri, string userCode) =>
            await Write(new JsonObject
            {
                ["id"] = id, ["type"] = "login", ["message"] = message,
                ["verificationUri"] = verificationUri, ["userCode"] = userCode,
            }).ConfigureAwait(false);

        public async Task WriteEnd(string id) =>
            await Write(new JsonObject { ["id"] = id, ["type"] = "end" }).ConfigureAwait(false);

        private async Task Write(JsonObject message)
        {
            var bytes = Encoding.UTF8.GetBytes(message.ToJsonString() + "\n");
            await writeLock.WaitAsync().ConfigureAwait(false);
            try
            {
                await stream.WriteAsync(bytes).ConfigureAwait(false);
                await stream.FlushAsync().ConfigureAwait(false);
            }
            finally { writeLock.Release(); }
        }
    }

    /// <summary>Reads '\n'-delimited lines from a raw stream without relying on a text
    /// encoder that might mis-handle very large lines (a forwarded body can legitimately
    /// approach ~22 MB base64-encoded).</summary>
    private sealed class LineReader(Stream stream, int maxLineBytes)
    {
        private readonly byte[] _buffer = new byte[64 * 1024];
        private int _length;
        private int _offset;
        private MemoryStream? _accumulator;

        public async Task<string?> ReadLineAsync()
        {
            while (true)
            {
                if (_offset >= _length)
                {
                    _length = await stream.ReadAsync(_buffer.AsMemory()).ConfigureAwait(false);
                    _offset = 0;
                    if (_length == 0)
                    {
                        if (_accumulator is { Length: > 0 })
                        {
                            var text = Encoding.UTF8.GetString(_accumulator.ToArray());
                            _accumulator = null;
                            return text;
                        }
                        return null;
                    }
                }

                var span = _buffer.AsSpan(_offset, _length - _offset);
                var newline = span.IndexOf((byte)'\n');
                if (newline < 0)
                {
                    (_accumulator ??= new MemoryStream()).Write(span);
                    if (_accumulator.Length > maxLineBytes) throw new LernaCliException("Oversized protocol frame");
                    _offset = _length;
                    continue;
                }

                (_accumulator ??= new MemoryStream()).Write(span[..newline]);
                _offset += newline + 1;
                var result = Encoding.UTF8.GetString(_accumulator.ToArray());
                _accumulator = null;
                return result;
            }
        }
    }
}
