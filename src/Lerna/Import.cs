using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Lerna;

/// <summary>
/// First-run "lerna import OWNER/REPO" support: reads a config (and optionally a same-repo
/// secrets file) out of a private GitHub repository via the `gh` CLI, validates it strictly,
/// materializes any referenced secret to a local owner-only file, and produces a fully
/// validated, auto-enabled LernaConfig. Never touches the network directly and never handles
/// a raw GitHub token -- `gh` owns auth end to end.
/// </summary>
public static class GitHubImport
{
    public sealed record Result(LernaConfig Config, string? MaterializedKeyPath);

    private const long MaxFileBytes = 1 * 1024 * 1024;
    private const string GithubPrefixPattern = @"^https://github\.com/";

    private static readonly Regex SegmentPattern = new("^[A-Za-z0-9._-]+$", RegexOptions.Compiled);
    private static readonly Regex EnvNamePattern = new("^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);
    private static readonly Regex FieldPathPattern = new(@"^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$", RegexOptions.Compiled);
    private static readonly Regex TokenPattern =
        new(@"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}", RegexOptions.Compiled);

    /// <summary>Strict OWNER/REPO parsing. Accepts "owner/repo" or "https://github.com/owner/repo"
    /// only; rejects any other host, scheme, ssh form, or path-traversal-looking segment.</summary>
    public static (string Owner, string Repo) ParseRepository(string input)
    {
        if (string.IsNullOrWhiteSpace(input)) throw new LernaCliException("repository is required");
        var value = input.Trim();

        if (value.Contains("://", StringComparison.Ordinal))
        {
            var match = Regex.Match(value, GithubPrefixPattern, RegexOptions.IgnoreCase);
            if (!match.Success) throw new LernaCliException("repository URL must start with https://github.com/");
            value = value[match.Length..];
        }
        else if (value.StartsWith("git@", StringComparison.OrdinalIgnoreCase) || value.Contains('@') || value.Contains(':'))
        {
            throw new LernaCliException("repository must be OWNER/REPO or https://github.com/OWNER/REPO");
        }

        value = value.Trim('/');
        if (value.EndsWith(".git", StringComparison.OrdinalIgnoreCase)) value = value[..^".git".Length];

        var parts = value.Split('/');
        if (parts.Length != 2) throw new LernaCliException("repository must be in OWNER/REPO form");
        var (owner, repo) = (parts[0], parts[1]);
        if (!IsValidSegment(owner) || !IsValidSegment(repo))
            throw new LernaCliException("repository owner/name contains invalid characters");
        return (owner, repo);
    }

    private static bool IsValidSegment(string s) =>
        s.Length is > 0 and <= 100 && !s.Contains("..", StringComparison.Ordinal) && SegmentPattern.IsMatch(s);

    private static bool IsSafeRepoPath(string path) =>
        !string.IsNullOrWhiteSpace(path) && path.Length <= 400
        && !path.StartsWith('/') && !path.Contains('\\') && !path.Contains("..", StringComparison.Ordinal);

    private static bool IsSafeRef(string r) =>
        !string.IsNullOrWhiteSpace(r) && r.Length <= 250 && !r.Contains("..", StringComparison.Ordinal)
        && !r.StartsWith('-') && r.All(c => !char.IsControl(c) && c != ' ');

    /// <summary>Runs `gh` with an argument list (no shell involved). Sanitizes stderr so a
    /// stray token pattern can never reach our error output/logs.</summary>
    private static async Task<string> RunGh(string[] args, CancellationToken ct)
    {
        var psi = new ProcessStartInfo("gh")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);

        using var process = new Process { StartInfo = psi };
        try
        {
            if (!process.Start()) throw new LernaCliException("Could not start gh");
        }
        catch (Exception ex) when (ex is not LernaCliException)
        {
            throw new LernaCliException("gh CLI is not available; install and authenticate the GitHub CLI (gh) to use `lerna import`");
        }

        var stdoutTask = process.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = process.StandardError.ReadToEndAsync(ct);
        await process.WaitForExitAsync(ct).ConfigureAwait(false);
        var stdout = await stdoutTask.ConfigureAwait(false);
        var stderr = await stderrTask.ConfigureAwait(false);
        if (process.ExitCode != 0)
            throw new LernaCliException($"gh api failed: {SanitizeGhError(stderr)}");
        return stdout;
    }

    private static string SanitizeGhError(string message)
    {
        var trimmed = message.Trim();
        if (trimmed.Length > 400) trimmed = trimmed[..400] + "...";
        return TokenPattern.Replace(trimmed, "[redacted]");
    }

    private static async Task<(bool IsPrivate, string DefaultBranch)> FetchRepoMetadataAsync(
        string owner, string repo, CancellationToken ct)
    {
        var json = await RunGh(["api", $"repos/{owner}/{repo}"], ct).ConfigureAwait(false);
        var obj = ParseJsonObject(json, "repository metadata from gh api");
        var isPrivate = obj["private"]?.GetValueKind() == JsonValueKind.True;
        var defaultBranch = obj["default_branch"]?.GetValueKind() == JsonValueKind.String
            ? obj["default_branch"]!.GetValue<string>() : "main";
        return (isPrivate, defaultBranch);
    }

    private static async Task<byte[]> FetchFileBytesAsync(string owner, string repo, string path, string gitRef, CancellationToken ct)
    {
        if (!IsSafeRepoPath(path)) throw new LernaCliException($"Invalid path: {path}");
        var json = await RunGh(
            ["api", "-X", "GET", $"repos/{owner}/{repo}/contents/{path}", "-f", $"ref={gitRef}"], ct).ConfigureAwait(false);
        var obj = ParseJsonObject(json, $"contents response for {path}");

        if (obj["type"]?.GetValueKind() != JsonValueKind.String || obj["type"]!.GetValue<string>() != "file")
            throw new LernaCliException($"{path} is not a regular file in the repository");

        var size = obj["size"]?.GetValueKind() == JsonValueKind.Number ? obj["size"]!.GetValue<long>() : -1;
        if (size < 0 || size > MaxFileBytes) throw new LernaCliException($"{path} exceeds the 1 MiB import size limit");

        var encoding = obj["encoding"]?.GetValueKind() == JsonValueKind.String ? obj["encoding"]!.GetValue<string>() : null;
        var content = obj["content"]?.GetValueKind() == JsonValueKind.String ? obj["content"]!.GetValue<string>() : null;
        if (encoding != "base64" || content is null) throw new LernaCliException($"{path} content was not returned as base64");

        byte[] bytes;
        try { bytes = Convert.FromBase64String(content.Replace("\n", "")); }
        catch (FormatException) { throw new LernaCliException($"{path} content was not valid base64"); }
        if (bytes.LongLength > MaxFileBytes) throw new LernaCliException($"{path} exceeds the 1 MiB import size limit");
        return bytes;
    }

    private static JsonObject ParseJsonObject(string json, string label)
    {
        JsonNode? node;
        try { node = JsonNode.Parse(json); }
        catch (JsonException) { throw new LernaCliException($"Could not parse {label}"); }
        return node as JsonObject ?? throw new LernaCliException($"Unexpected shape for {label}");
    }

    private static string RequireString(JsonObject obj, string key, string label)
    {
        if (obj[key]?.GetValueKind() != JsonValueKind.String)
            throw new LernaCliException($"Imported config missing required field: {label}");
        return obj[key]!.GetValue<string>();
    }

    private static string? OptionalString(JsonObject obj, string key) =>
        obj[key]?.GetValueKind() == JsonValueKind.String ? obj[key]!.GetValue<string>() : null;

    /// <summary>Accepts either {"lerna":{...}} or a flat top-level shape.</summary>
    private static JsonObject ExtractConfigObject(JsonObject root) => root["lerna"] as JsonObject ?? root;

    /// <summary>Walks a "a.b.c" dotted path of plain object properties (no array indices),
    /// resolving to a string leaf. Used only against a file we already fetched from the same
    /// repository -- never used to reach outside that document.</summary>
    private static string ExtractSecretField(JsonObject root, string fieldPath)
    {
        if (!FieldPathPattern.IsMatch(fieldPath))
            throw new LernaCliException("secret.field must match ^[A-Za-z0-9_]+(\\.[A-Za-z0-9_]+)*$");
        JsonNode? current = root;
        foreach (var segment in fieldPath.Split('.'))
        {
            if (current is not JsonObject obj) throw new LernaCliException($"secret.field '{fieldPath}' not found in secrets file");
            current = obj[segment];
        }
        if (current?.GetValueKind() != JsonValueKind.String)
            throw new LernaCliException($"secret.field '{fieldPath}' must resolve to a string value");
        return current.GetValue<string>();
    }

    /// <summary>Writes the resolved secret to ~/.copilot/lerna/keys/{owner}__{repo}.key,
    /// owner-only from the moment of creation. Throws (never silently degrades) if the
    /// platform-specific hardening cannot be verified.</summary>
    private static string MaterializeSecret(string owner, string repo, string secretValue)
    {
        var home = Environment.GetEnvironmentVariable("HOME") ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var dir = Path.Combine(home, ".copilot", "lerna", "keys");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, $"{owner}__{repo}.key");
        if (File.Exists(path)) File.Delete(path); // never append to a possibly differently-permissioned leftover

        var bytes = Encoding.UTF8.GetBytes(secretValue);
        if (OperatingSystem.IsWindows())
        {
            using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                stream.Write(bytes, 0, bytes.Length);
            WindowsAcl.ProtectToCurrentUser(path);
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
            using var stream = new FileStream(path, options);
            stream.Write(bytes, 0, bytes.Length);
        }
        return path;
    }

    public static async Task<Result> RunAsync(string repository, string? gitRef, string? filePath, CancellationToken ct)
    {
        var (owner, repo) = ParseRepository(repository);
        var path = string.IsNullOrWhiteSpace(filePath) ? "lerna.json" : filePath;
        if (!IsSafeRepoPath(path)) throw new LernaCliException("Invalid --path");

        var (isPrivate, defaultBranch) = await FetchRepoMetadataAsync(owner, repo, ct).ConfigureAwait(false);
        if (!isPrivate)
            throw new LernaCliException($"Refusing to import from {owner}/{repo}: the repository must be private");

        var effectiveRef = string.IsNullOrWhiteSpace(gitRef) ? defaultBranch : gitRef;
        if (!IsSafeRef(effectiveRef)) throw new LernaCliException("Invalid --ref");

        var configBytes = await FetchFileBytesAsync(owner, repo, path, effectiveRef, ct).ConfigureAwait(false);
        var configRoot = ParseJsonObject(Encoding.UTF8.GetString(configBytes), path);
        var lerna = ExtractConfigObject(configRoot);

        var model = RequireString(lerna, "model", "model");
        if (!ConfigValidation.IsValidNativeId(model)) throw new LernaCliException("Imported model must match ^[a-zA-Z0-9._-]+$");
        var deployment = OptionalString(lerna, "deployment");
        if (deployment is not null && !ConfigValidation.IsValidNativeId(deployment))
            throw new LernaCliException("Imported deployment must match ^[a-zA-Z0-9._-]+$");
        var endpoint = RequireString(lerna, "endpoint", "endpoint");
        if (ConfigValidation.ValidateEndpoint(endpoint) is { } endpointError)
            throw new LernaCliException("Imported " + endpointError);

        if (lerna["keyFile"] is not null)
            throw new LernaCliException(
                "Imported config must not specify keyFile; a repository cannot assert a path on your machine. Use keyEnv or secret:{path,field} instead.");
        if (lerna["apiKey"] is not null || lerna["api_key"] is not null)
            throw new LernaCliException(
                "Imported config must not contain a literal apiKey; use secret:{path,field} referencing a same-repo secrets file, or keyEnv.");

        var hasKeyEnv = lerna["keyEnv"]?.GetValueKind() == JsonValueKind.String;
        var hasSecret = lerna["secret"] is JsonObject;
        if (hasKeyEnv == hasSecret) throw new LernaCliException("Imported config must specify exactly one of keyEnv or secret");

        string? keyEnv = null;
        string? materializedKeyPath = null;

        if (hasKeyEnv)
        {
            keyEnv = lerna["keyEnv"]!.GetValue<string>();
            if (!EnvNamePattern.IsMatch(keyEnv)) throw new LernaCliException("Imported keyEnv must be a valid environment variable name");
        }
        else
        {
            var secretObj = (JsonObject)lerna["secret"]!;
            var secretPath = RequireString(secretObj, "path", "secret.path");
            var secretField = RequireString(secretObj, "field", "secret.field");
            if (!IsSafeRepoPath(secretPath)) throw new LernaCliException("Invalid secret.path");

            var secretBytes = await FetchFileBytesAsync(owner, repo, secretPath, effectiveRef, ct).ConfigureAwait(false);
            var secretRoot = ParseJsonObject(Encoding.UTF8.GetString(secretBytes), secretPath);
            var secretValue = ExtractSecretField(secretRoot, secretField);

            materializedKeyPath = MaterializeSecret(owner, repo, secretValue);
            if (ConfigValidation.CheckKeyFileAccess(materializedKeyPath) is { } keyError)
                throw new LernaCliException("Materialized key file failed its own safety check: " + keyError);
        }

        var config = new LernaConfig
        {
            Enabled = true,
            Model = model,
            Deployment = deployment,
            Endpoint = endpoint,
            KeyEnv = keyEnv,
            KeyFile = materializedKeyPath,
            SourceRepository = $"{owner}/{repo}",
            SourceRef = effectiveRef,
            SourcePath = path,
        };

        var errors = config.FormatErrors();
        if (errors.Count > 0) throw new LernaCliException("Imported config is invalid: " + string.Join("; ", errors));

        return new Result(config, materializedKeyPath);
    }
}
