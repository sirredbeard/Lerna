using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Lerna;

/// <summary>The exact six model IDs HydraFusion accepts in a fusion plan (Copilot CLI,
/// verified by replaying synthetic solo plans for the full CAPI catalog). Lerna treats this as
/// a hard allowlist: nothing else may ever be used as a "models" mapping key, in a fusion plan
/// rewrite, or routed anywhere.</summary>
public static class HydraModels
{
    public static readonly IReadOnlyList<string> AllowedIds =
    [
        "claude-opus-5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
        "mai-code-1.1-flash", "mai-code-1-flash-picker",
    ];

    /// <summary>These two have no Microsoft Foundry equivalent and the user explicitly refused a
    /// substitute. They must always stay on Copilot and must never be mapped to BYOK.</summary>
    public static readonly IReadOnlySet<string> NoAzureEquivalent =
        new HashSet<string>(["mai-code-1.1-flash", "mai-code-1-flash-picker"], StringComparer.Ordinal);

    public static bool IsAllowed(string id) => AllowedIds.Contains(id, StringComparer.Ordinal);
}

/// <summary>One entry of the "lerna.models" map: which Azure deployment backs a single
/// HydraFusion model ID, and which wire format to speak to it. Never carries a token or key --
/// Azure auth is minted per-request as a fresh bearer token scoped to this endpoint's own
/// audience, never persisted here.</summary>
public sealed record ModelMapping
{
    public required string ResourceId { get; init; }
    public required string ResourceName { get; init; }
    public required string Deployment { get; init; }

    /// <summary>The resource's own base endpoint only (its ARM "AI Foundry API" endpoint, e.g.
    /// https://&lt;account&gt;.services.ai.azure.com) -- never a fully-built request URL. Both
    /// wires hang off this same base; the request path (/openai/v1/responses or
    /// /anthropic/v1/messages) is derived from <see cref="Wire"/> at request time by
    /// <see cref="ModelWire.BuildUri"/>, so a stored URL can never end up mismatched with its
    /// wire format.</summary>
    public required string Endpoint { get; init; }

    /// <summary>"responses" (Azure OpenAI Responses wire) or "anthropic" (Microsoft Foundry's
    /// Anthropic Messages wire). Both are implemented; see <see cref="ModelWire"/>.</summary>
    public required string Wire { get; init; }

    public JsonObject ToJson() => new()
    {
        ["resourceId"] = ResourceId,
        ["resourceName"] = ResourceName,
        ["deployment"] = Deployment,
        ["endpoint"] = Endpoint,
        ["wire"] = Wire,
    };
}

/// <summary>Format-only validation of a "lerna.models" entry: allowlist membership, refusal of
/// the two MAI IDs (no Azure equivalent), and wire/endpoint shape. This deliberately does NOT
/// verify that the mapped Azure deployment's real model name equals the Hydra model ID -- that
/// requires a live ARM discovery pass and belongs to whatever validates against Azure directly
/// (azure.map), never to this offline config-format check.</summary>
public static class ModelMappingValidation
{
    public static List<string> FormatErrors(string modelId, ModelMapping mapping)
    {
        var errors = new List<string>();
        if (!HydraModels.IsAllowed(modelId))
        {
            errors.Add($"models key '{modelId}' is not one of the six HydraFusion-allowlisted model IDs");
            return errors;
        }
        if (HydraModels.NoAzureEquivalent.Contains(modelId))
        {
            errors.Add($"'{modelId}' has no Azure equivalent and must never be mapped to BYOK");
            return errors;
        }

        if (string.IsNullOrEmpty(mapping.ResourceId)) errors.Add($"models.{modelId}.resourceId is required");
        if (string.IsNullOrEmpty(mapping.ResourceName)) errors.Add($"models.{modelId}.resourceName is required");
        if (string.IsNullOrEmpty(mapping.Deployment) || !ConfigValidation.IsValidNativeId(mapping.Deployment))
            errors.Add($"models.{modelId}.deployment must match ^[a-zA-Z0-9._-]+$");

        switch (mapping.Wire)
        {
            case ModelWire.Responses:
            case ModelWire.Anthropic:
                break;
            default:
                errors.Add($"models.{modelId}.wire must be 'responses' or 'anthropic'");
                break;
        }

        if (string.IsNullOrEmpty(mapping.Endpoint)) errors.Add($"models.{modelId}.endpoint is required");
        else if (!Uri.TryCreate(mapping.Endpoint, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            errors.Add($"models.{modelId}.endpoint must be an absolute https URL");
        else if (!string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            errors.Add($"models.{modelId}.endpoint must not contain credentials, a query string, or a fragment");
        else if (!string.IsNullOrEmpty(uri.AbsolutePath) && uri.AbsolutePath != "/")
            errors.Add($"models.{modelId}.endpoint must be the resource's base endpoint only (no path) -- the request path is derived from wire, never stored");

        return errors;
    }
}

/// <summary>The "lerna.auth" section: which Azure identity context a per-model mapping was
/// discovered/selected under. Contains only nonsecret IDs -- never a token.</summary>
public sealed record LernaAuth
{
    public string Type { get; init; } = "azure";
    public string? TenantId { get; init; }

    /// <summary>The Entra app registration used for device-code sign-in. Nonsecret (a public
    /// client ID), and it must survive a write-back or `enable` would silently delete the
    /// user's sign-in configuration.</summary>
    public string? ClientId { get; init; }
    public string? SubscriptionId { get; init; }

    public JsonObject ToJson()
    {
        var json = new JsonObject { ["type"] = Type, ["tenantId"] = TenantId };
        // Only emitted when actually configured, so a key-file-only config keeps a clean
        // settings.json and `status` output rather than gaining a null field.
        if (ClientId is not null) json["clientId"] = ClientId;
        json["subscriptionId"] = SubscriptionId;
        return json;
    }
}

/// <summary>The "lerna" section of Copilot's settings.json, plus enough context to
/// report status without ever exposing secret values.</summary>
public sealed record LernaConfig
{
    public bool Enabled { get; init; }
    public bool Verbose { get; init; }
    public string? Model { get; init; }
    public string? Deployment { get; init; }
    public string? Endpoint { get; init; }
    public string? KeyEnv { get; init; }
    public string? KeyFile { get; init; }

    /// <summary>Azure identity context for the per-model mapping below (item 3/6). Additive to
    /// the legacy single-model keyEnv/keyFile BYOK fields above, which remain fully supported.</summary>
    public LernaAuth? Auth { get; init; }

    /// <summary>Per-HydraFusion-model-ID Azure deployment mapping (item 3). Keys must be one of
    /// the six <see cref="HydraModels.AllowedIds"/>; see <see cref="ModelMappingValidation"/>.</summary>
    public IReadOnlyDictionary<string, ModelMapping> Models { get; init; } = new Dictionary<string, ModelMapping>();

    public List<string> ModelsFormatErrors()
    {
        var errors = new List<string>();
        foreach (var (modelId, mapping) in Models) errors.AddRange(ModelMappingValidation.FormatErrors(modelId, mapping));
        return errors;
    }

    /// <summary>Informational provenance for a config populated via `lerna import`. Purely
    /// advisory metadata (never validated, never a trust boundary by itself).</summary>
    public string? SourceRepository { get; init; }
    public string? SourceRef { get; init; }
    public string? SourcePath { get; init; }

    /// <summary>True when this config was read from the legacy experiment's
    /// "lerna.probe" shape. Always treated as disabled until re-saved via configure.</summary>
    public bool CompatibilityProbe { get; init; }

    public static LernaConfig Empty { get; } = new() { Enabled = false, Verbose = true };

    public string? EffectiveDeployment => string.IsNullOrEmpty(Deployment) ? Model : Deployment;

    /// <summary>Format-only validation errors (does not touch the filesystem or environment).</summary>
    public List<string> FormatErrors()
    {
        var errors = new List<string>();
        if (string.IsNullOrEmpty(Model)) errors.Add("model is required");
        else if (!ConfigValidation.IsValidNativeId(Model)) errors.Add("model must match ^[a-zA-Z0-9._-]+$");

        if (!string.IsNullOrEmpty(Deployment) && !ConfigValidation.IsValidNativeId(Deployment))
            errors.Add("deployment must match ^[a-zA-Z0-9._-]+$");

        if (string.IsNullOrEmpty(Endpoint)) errors.Add("endpoint is required");
        else if (ConfigValidation.ValidateEndpoint(Endpoint) is { } endpointError) errors.Add(endpointError);

        var hasKeyEnv = !string.IsNullOrEmpty(KeyEnv);
        var hasKeyFile = !string.IsNullOrEmpty(KeyFile);
        if (hasKeyEnv == hasKeyFile) errors.Add("exactly one of keyEnv or keyFile is required");

        return errors;
    }

    /// <summary>Whether the legacy single-model configuration is format-valid. Does not check
    /// credential readability -- see ConfigValidation.CheckKeyFileAccess for that.</summary>
    public bool LegacyConfigured => FormatErrors().Count == 0;

    /// <summary>Whether every configured route is format-valid and at least one route exists.</summary>
    public bool Configured
    {
        get
        {
            var hasLegacy = !string.IsNullOrEmpty(Model) || !string.IsNullOrEmpty(Endpoint)
                || !string.IsNullOrEmpty(KeyEnv) || !string.IsNullOrEmpty(KeyFile);
            if (!hasLegacy && Models.Count == 0) return false;
            return (!hasLegacy || LegacyConfigured) && ModelsFormatErrors().Count == 0;
        }
    }

    public string KeySourceName => !string.IsNullOrEmpty(KeyEnv) ? "env" : !string.IsNullOrEmpty(KeyFile) ? "file" : "none";
}

public static class ConfigValidation
{
    private static readonly Regex NativeId = new("^[a-zA-Z0-9._-]+$", RegexOptions.Compiled);

    public static bool IsValidNativeId(string value) => NativeId.IsMatch(value);

    /// <summary>Returns an error message, or null if the endpoint is an acceptable BYOK target.</summary>
    public static string? ValidateEndpoint(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)) return "endpoint must be an absolute URL";
        if (!string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase)) return "endpoint must use https";
        if (!string.IsNullOrEmpty(uri.UserInfo)) return "endpoint must not contain credentials";
        if (!string.IsNullOrEmpty(uri.Query)) return "endpoint must not contain a query string";
        if (!string.IsNullOrEmpty(uri.Fragment)) return "endpoint must not contain a fragment";
        if (!uri.AbsolutePath.EndsWith("/responses", StringComparison.Ordinal)) return "endpoint path must end with /responses";
        if (uri.Host.EndsWith("githubcopilot.com", StringComparison.OrdinalIgnoreCase))
            return "endpoint must not be a githubcopilot.com host";
        return null;
    }

    /// <summary>Expands a leading "~/" using $HOME. Does not touch the filesystem.</summary>
    public static string ExpandHome(string path)
    {
        if (path == "~") return HomeDirectory();
        if (path.StartsWith("~/", StringComparison.Ordinal))
            return Path.Combine(HomeDirectory(), path[2..]);
        return path;
    }

    private static string HomeDirectory() =>
        Environment.GetEnvironmentVariable("HOME") ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    /// <summary>Verifies a key file is regular and not broadly accessible. On Unix this checks
    /// the permission bits via <see cref="File.GetUnixFileMode"/>, which is portable across
    /// architectures. On Windows this inspects the ACL for broad-group read access via the
    /// managed System.Security.AccessControl APIs.</summary>
    public static string? CheckKeyFileAccess(string path)
    {
        if (!File.Exists(path)) return "keyFile does not exist or is not a regular file";
        if (OperatingSystem.IsWindows()) return WindowsAcl.CheckReadRestricted(path);

        // A symlink can be repointed after this check, and stat() would report the target's
        // mode rather than the link's, so refuse them outright instead of racing.
        if (new FileInfo(path).LinkTarget is not null) return "keyFile must not be a symbolic link";

        UnixFileMode mode;
        try { mode = File.GetUnixFileMode(path); }
        catch (IOException) { return "keyFile could not be inspected"; }
        catch (UnauthorizedAccessException) { return "keyFile could not be inspected"; }

        const UnixFileMode GroupOrOther =
            UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute |
            UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute;

        if ((mode & GroupOrOther) != 0)
            return "keyFile must not be readable or writable by group or others (chmod 600)";
        return null;
    }
}

/// <summary>Windows ACL helpers for key file protection. Uses the managed
/// System.Security.AccessControl APIs; falls back to icacls.exe (argument-list invocation,
/// no shell) if the managed path fails. Guarded by OperatingSystem.IsWindows() everywhere so
/// the linux-x64 AOT publish trims this out entirely.</summary>
[SupportedOSPlatform("windows")]
internal static class WindowsAcl
{
    /// <summary>Best-effort check that a pre-existing key file isn't broadly readable
    /// (Everyone / Authenticated Users / BUILTIN\Users). Used by configure/enable for a
    /// user-supplied --key-file.</summary>
    public static string? CheckReadRestricted(string path)
    {
        try
        {
            var info = new FileInfo(path);
            var security = info.GetAccessControl(System.Security.AccessControl.AccessControlSections.Access);
            foreach (System.Security.AccessControl.FileSystemAccessRule rule in
                     security.GetAccessRules(true, true, typeof(System.Security.Principal.SecurityIdentifier)))
            {
                if (rule.AccessControlType != System.Security.AccessControl.AccessControlType.Allow) continue;
                if ((rule.FileSystemRights & (System.Security.AccessControl.FileSystemRights.Read
                        | System.Security.AccessControl.FileSystemRights.ReadData)) == 0) continue;
                if (rule.IdentityReference is not System.Security.Principal.SecurityIdentifier sid) continue;
                if (sid.IsWellKnown(System.Security.Principal.WellKnownSidType.WorldSid)
                    || sid.IsWellKnown(System.Security.Principal.WellKnownSidType.AuthenticatedUserSid)
                    || sid.IsWellKnown(System.Security.Principal.WellKnownSidType.BuiltinUsersSid))
                {
                    return "keyFile must not grant read access to Everyone/Authenticated Users/Users; restrict it to the current user";
                }
            }
            return null;
        }
        catch (PlatformNotSupportedException) { return null; } // nothing we can safely check further
        catch (Exception) { return "keyFile permissions could not be verified"; }
    }

    /// <summary>Locks a freshly written file down to the current user only. Tries the managed
    /// ACL API first; falls back to icacls.exe. Throws (never silently skips) if neither works,
    /// matching the "do not omit safety silently" requirement.</summary>
    public static void ProtectToCurrentUser(string path)
    {
        if (TryProtectWithManagedAcl(path)) return;
        if (TryProtectWithIcacls(path)) return;
        throw new LernaCliException("Could not restrict the imported key file to the current user on Windows");
    }

    private static bool TryProtectWithManagedAcl(string path)
    {
        try
        {
            var info = new FileInfo(path);
            var security = info.GetAccessControl();
            security.SetAccessRuleProtection(true, false); // disable inheritance, drop inherited rules
            foreach (System.Security.AccessControl.FileSystemAccessRule rule in
                     security.GetAccessRules(true, false, typeof(System.Security.Principal.NTAccount)))
            {
                security.RemoveAccessRule(rule);
            }
            var currentUser = System.Security.Principal.WindowsIdentity.GetCurrent().User;
            if (currentUser is null) return false;
            security.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                currentUser, System.Security.AccessControl.FileSystemRights.FullControl,
                System.Security.AccessControl.AccessControlType.Allow));
            info.SetAccessControl(security);
            return CheckReadRestricted(path) is null;
        }
        catch { return false; }
    }

    private static bool TryProtectWithIcacls(string path)
    {
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo("icacls")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            psi.ArgumentList.Add(path);
            psi.ArgumentList.Add("/inheritance:r");
            psi.ArgumentList.Add("/grant:r");
            psi.ArgumentList.Add($"{Environment.UserName}:(R,W)");
            using var process = System.Diagnostics.Process.Start(psi);
            if (process is null) return false;
            if (!process.WaitForExit(10000)) { try { process.Kill(); } catch { /* ignore */ } return false; }
            return process.ExitCode == 0;
        }
        catch { return false; }
    }
}

/// <summary>Loads/saves Copilot's settings.json, touching only the "lerna" key so unrelated
/// settings (and their formatting/values) are preserved.</summary>
public static class SettingsFile
{
    public const long MaxBytes = 1 * 1024 * 1024;

    public static string Resolve(string? explicitPath)
    {
        if (!string.IsNullOrEmpty(explicitPath)) return ConfigValidation.ExpandHome(explicitPath);
        var copilotHome = Environment.GetEnvironmentVariable("COPILOT_HOME");
        if (!string.IsNullOrEmpty(copilotHome)) return Path.Combine(copilotHome, "settings.json");
        var home = Environment.GetEnvironmentVariable("HOME") ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(home, ".copilot", "settings.json");
    }

    public static JsonObject LoadRoot(string path)
    {
        if (!File.Exists(path)) return new JsonObject();
        var info = new FileInfo(path);
        if (info.Length > MaxBytes) throw new LernaCliException($"Config at {path} exceeds the 1 MiB limit");
        var text = File.ReadAllText(path);
        if (string.IsNullOrWhiteSpace(text)) return new JsonObject();
        JsonNode? node;
        try { node = JsonNode.Parse(text); }
        catch (JsonException) { throw new LernaCliException($"Config at {path} is not valid JSON"); }
        return node as JsonObject ?? throw new LernaCliException($"Config at {path} must be a JSON object");
    }

    public static void SaveRootAtomic(string path, JsonObject root)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(path));
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        var options = new JsonSerializerOptions { WriteIndented = true };
        var text = root.ToJsonString(options);
        var bytes = System.Text.Encoding.UTF8.GetByteCount(text);
        if (bytes > MaxBytes) throw new LernaCliException("Resulting config would exceed the 1 MiB limit");
        var tempPath = path + ".tmp-" + Guid.NewGuid().ToString("N");
        File.WriteAllText(tempPath, text);
        File.Move(tempPath, path, overwrite: true);
    }

    /// <summary>Reads the "lerna" section, transparently accepting the legacy
    /// experiment's "lerna.probe" shape as a disabled, read-only compatibility source.</summary>
    public static LernaConfig ReadLerna(JsonObject root)
    {
        if (root["lerna"] is not JsonObject lerna) return LernaConfig.Empty;

        if (lerna["model"] is null && lerna["probe"] is JsonObject probe)
        {
            return new LernaConfig
            {
                Enabled = false,
                Verbose = true,
                CompatibilityProbe = true,
                Model = probe["model"]?.GetValueKind() == JsonValueKind.String ? probe["model"]!.GetValue<string>() : null,
                Deployment = probe["deployment"]?.GetValueKind() == JsonValueKind.String ? probe["deployment"]!.GetValue<string>() : null,
                Endpoint = probe["endpoint"]?.GetValueKind() == JsonValueKind.String ? probe["endpoint"]!.GetValue<string>() : null,
                KeyEnv = probe["keyEnv"]?.GetValueKind() == JsonValueKind.String ? probe["keyEnv"]!.GetValue<string>() : null,
                KeyFile = probe["keyFile"]?.GetValueKind() == JsonValueKind.String ? probe["keyFile"]!.GetValue<string>() : null,
            };
        }

        return new LernaConfig
        {
            Enabled = lerna["enabled"]?.GetValueKind() == JsonValueKind.True,
            // Verbose defaults on: routing visibility is the point of installing Lerna, so it is
            // only off when the setting is explicitly false.
            Verbose = lerna["verbose"]?.GetValueKind() != JsonValueKind.False,
            Model = lerna["model"]?.GetValueKind() == JsonValueKind.String ? lerna["model"]!.GetValue<string>() : null,
            Deployment = lerna["deployment"]?.GetValueKind() == JsonValueKind.String ? lerna["deployment"]!.GetValue<string>() : null,
            Endpoint = lerna["endpoint"]?.GetValueKind() == JsonValueKind.String ? lerna["endpoint"]!.GetValue<string>() : null,
            KeyEnv = lerna["keyEnv"]?.GetValueKind() == JsonValueKind.String ? lerna["keyEnv"]!.GetValue<string>() : null,
            KeyFile = lerna["keyFile"]?.GetValueKind() == JsonValueKind.String ? lerna["keyFile"]!.GetValue<string>() : null,
            SourceRepository = lerna["source"] is JsonObject src1 && src1["repository"]?.GetValueKind() == JsonValueKind.String
                ? src1["repository"]!.GetValue<string>() : null,
            SourceRef = lerna["source"] is JsonObject src2 && src2["ref"]?.GetValueKind() == JsonValueKind.String
                ? src2["ref"]!.GetValue<string>() : null,
            SourcePath = lerna["source"] is JsonObject src3 && src3["path"]?.GetValueKind() == JsonValueKind.String
                ? src3["path"]!.GetValue<string>() : null,
            Auth = ReadAuth(lerna),
            Models = ReadModels(lerna),
        };
    }

    private static LernaAuth? ReadAuth(JsonObject lerna)
    {
        if (lerna["auth"] is not JsonObject auth) return null;
        return new LernaAuth
        {
            Type = auth["type"]?.GetValueKind() == JsonValueKind.String ? auth["type"]!.GetValue<string>() : "azure",
            TenantId = auth["tenantId"]?.GetValueKind() == JsonValueKind.String ? auth["tenantId"]!.GetValue<string>() : null,
            ClientId = auth["clientId"]?.GetValueKind() == JsonValueKind.String ? auth["clientId"]!.GetValue<string>() : null,
            SubscriptionId = auth["subscriptionId"]?.GetValueKind() == JsonValueKind.String ? auth["subscriptionId"]!.GetValue<string>() : null,
        };
    }

    private static IReadOnlyDictionary<string, ModelMapping> ReadModels(JsonObject lerna)
    {
        var models = new Dictionary<string, ModelMapping>();
        if (lerna["models"] is not JsonObject modelsObj) return models;
        foreach (var (modelId, node) in modelsObj)
        {
            if (node is not JsonObject m) continue;
            models[modelId] = new ModelMapping
            {
                ResourceId = m["resourceId"]?.GetValueKind() == JsonValueKind.String ? m["resourceId"]!.GetValue<string>() : "",
                ResourceName = m["resourceName"]?.GetValueKind() == JsonValueKind.String ? m["resourceName"]!.GetValue<string>() : "",
                Deployment = m["deployment"]?.GetValueKind() == JsonValueKind.String ? m["deployment"]!.GetValue<string>() : "",
                Endpoint = m["endpoint"]?.GetValueKind() == JsonValueKind.String ? m["endpoint"]!.GetValue<string>() : "",
                Wire = m["wire"]?.GetValueKind() == JsonValueKind.String ? m["wire"]!.GetValue<string>() : "",
            };
        }
        return models;
    }

    /// <summary>Atomically replaces only the "lerna" key of the given root with the canonical
    /// (non-legacy) shape. Callers must have already validated `config` as needed.</summary>
    public static void WriteLerna(JsonObject root, LernaConfig config)
    {
        var lerna = new JsonObject { ["enabled"] = config.Enabled };
        lerna["verbose"] = config.Verbose;
        if (config.Model is not null) lerna["model"] = config.Model;
        if (config.Deployment is not null) lerna["deployment"] = config.Deployment;
        if (config.Endpoint is not null) lerna["endpoint"] = config.Endpoint;
        if (config.KeyEnv is not null) lerna["keyEnv"] = config.KeyEnv;
        if (config.KeyFile is not null) lerna["keyFile"] = config.KeyFile;
        if (config.SourceRepository is not null)
        {
            var source = new JsonObject { ["repository"] = config.SourceRepository };
            if (config.SourceRef is not null) source["ref"] = config.SourceRef;
            if (config.SourcePath is not null) source["path"] = config.SourcePath;
            lerna["source"] = source;
        }
        if (config.Auth is not null) lerna["auth"] = config.Auth.ToJson();
        if (config.Models.Count > 0)
        {
            var modelsObj = new JsonObject();
            foreach (var (modelId, mapping) in config.Models) modelsObj[modelId] = mapping.ToJson();
            lerna["models"] = modelsObj;
        }
        root["lerna"] = lerna;
    }

    /// <summary>Ensures a disabled "lerna" section exists without disturbing anything else,
    /// including an already-present lerna section (idempotent).</summary>
    public static bool EnsureInitialized(JsonObject root)
    {
        if (root["lerna"] is JsonObject) return false;
        root["lerna"] = new JsonObject { ["enabled"] = false };
        return true;
    }
}

/// <summary>A user-facing CLI error: printed to stderr, no stack trace, exit code 1.</summary>
public sealed class LernaCliException(string message) : Exception(message);
