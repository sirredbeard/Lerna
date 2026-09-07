using System.Diagnostics;
using System.Text.Json.Nodes;

namespace Lerna;

public static class Program
{
    public const string AppVersion = "1.0.83";

    public static async Task<int> Main(string[] args)
    {
        try
        {
            if (args.Length == 0)
            {
                Console.Error.WriteLine(
                    "Usage: lerna <version|status|init|configure|enable|disable|import|login|logout|copilot|serve> [options]\n" +
                    "  lerna copilot [copilot args...]  Launch the installed copilot CLI with BYOK\n" +
                    "                                    interception enabled for that run only.\n" +
                    "  lerna login                      Sign in to Azure via an Entra device code\n" +
                    "  lerna logout                      Forget the cached Azure sign-in");
                return 2;
            }

            var command = args[0];
            var rest = args[1..];
            return command switch
            {
                "version" => CommandVersion(rest),
                "status" => CommandStatus(rest),
                "init" => CommandInit(rest),
                "configure" => CommandConfigure(rest),
                "enable" => CommandEnable(rest),
                "disable" => CommandDisable(rest),
                "import" => await CommandImport(rest),
                "login" => await CommandLogin(rest),
                "logout" => CommandLogout(rest),
                "copilot" => await CommandCopilot(rest),
                "serve" => await CommandServe(rest),
                _ => Unknown(command),
            };
        }
        catch (LernaCliException ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }

    private static int Unknown(string command)
    {
        Console.Error.WriteLine($"Unknown command: {command}");
        return 2;
    }

    /// <summary>Parses `--name value` pairs. Every option in this CLI takes a value;
    /// anything else (unknown option, bare positional argument, missing value) is rejected.</summary>
    private static Dictionary<string, string> ParseOptions(string[] args, HashSet<string> known)
    {
        var result = new Dictionary<string, string>();
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (!arg.StartsWith("--", StringComparison.Ordinal))
                throw new LernaCliException($"Unexpected argument: {arg}");
            var name = arg[2..];
            if (!known.Contains(name)) throw new LernaCliException($"Unknown option: --{name}");
            if (i + 1 >= args.Length) throw new LernaCliException($"Option --{name} requires a value");
            if (result.ContainsKey(name)) throw new LernaCliException($"Option --{name} was specified more than once");
            result[name] = args[++i];
        }
        return result;
    }

    private static int CommandVersion(string[] args)
    {
        ParseOptions(args, []);
        Console.WriteLine($"lerna {AppVersion} (.NET {Environment.Version})");
        return 0;
    }

    private static int CommandStatus(string[] args)
    {
        var opts = ParseOptions(args, ["config"]);
        var path = SettingsFile.Resolve(opts.GetValueOrDefault("config"));
        var root = SettingsFile.LoadRoot(path);
        var config = SettingsFile.ReadLerna(root);
        var json = StatusJson(config);
        json["azure"] = DeviceCodeAuth.Status(path);
        Console.WriteLine(json.ToJsonString());
        return 0;
    }

    internal static JsonObject StatusJson(LernaConfig config)
    {
        var json = new JsonObject
        {
            ["enabled"] = config.Enabled,
            ["verbose"] = config.Verbose,
            ["configured"] = config.Configured,
            ["model"] = config.Model,
            ["deployment"] = config.EffectiveDeployment,
            ["endpoint"] = config.Endpoint,
            ["keySource"] = config.KeySourceName == "none" ? null : config.KeySourceName,
            ["keyEnv"] = config.KeyEnv,
            ["keyFile"] = config.KeyFile,
            ["compatibilityProbe"] = config.CompatibilityProbe,
        };
        if (config.SourceRepository is not null)
        {
            json["source"] = new JsonObject
            {
                ["repository"] = config.SourceRepository,
                ["ref"] = config.SourceRef,
                ["path"] = config.SourcePath,
            };
        }
        if (config.Auth is not null) json["auth"] = config.Auth.ToJson();
        if (config.Models.Count > 0)
        {
            var models = new JsonArray();
            foreach (var modelId in config.Models.Keys) models.Add((JsonNode?)modelId);
            json["models"] = models;
        }
        return json;
    }

    private static int CommandInit(string[] args)
    {
        var opts = ParseOptions(args, ["config"]);
        var path = SettingsFile.Resolve(opts.GetValueOrDefault("config"));
        var root = SettingsFile.LoadRoot(path);
        var added = SettingsFile.EnsureInitialized(root);
        if (added) SettingsFile.SaveRootAtomic(path, root);
        Console.WriteLine(new JsonObject { ["initialized"] = added, ["path"] = path }.ToJsonString());
        return 0;
    }

    private static int CommandConfigure(string[] args)
    {
        var opts = ParseOptions(args, ["config", "model", "endpoint", "deployment", "key-env", "key-file"]);
        if (!opts.TryGetValue("model", out var model)) throw new LernaCliException("--model is required");
        if (!opts.TryGetValue("endpoint", out var endpoint)) throw new LernaCliException("--endpoint is required");
        opts.TryGetValue("deployment", out var deployment);
        var hasKeyEnv = opts.TryGetValue("key-env", out var keyEnv);
        var hasKeyFile = opts.TryGetValue("key-file", out var keyFile);
        if (hasKeyEnv == hasKeyFile) throw new LernaCliException("Specify exactly one of --key-env or --key-file");
        var resolvedKeyFile = hasKeyFile ? ConfigValidation.ExpandHome(keyFile!) : null;

        var path = SettingsFile.Resolve(opts.GetValueOrDefault("config"));
        var root = SettingsFile.LoadRoot(path);
        var existing = SettingsFile.ReadLerna(root);
        // A never-before-seen or legacy-probe lerna section has no real "enabled" state yet.
        var preservedEnabled = existing.CompatibilityProbe ? false : existing.Enabled;

        var config = new LernaConfig
        {
            Enabled = preservedEnabled,
            Verbose = existing.Verbose,
            Model = model,
            Deployment = deployment,
            Endpoint = endpoint,
            KeyEnv = hasKeyEnv ? keyEnv : null,
            KeyFile = resolvedKeyFile,
        };

        var errors = config.FormatErrors();
        if (errors.Count > 0) throw new LernaCliException(string.Join("; ", errors));
        if (resolvedKeyFile is not null && ConfigValidation.CheckKeyFileAccess(resolvedKeyFile) is { } keyFileError)
            throw new LernaCliException(keyFileError);

        SettingsFile.WriteLerna(root, config);
        SettingsFile.SaveRootAtomic(path, root);
        Console.WriteLine(StatusJson(config).ToJsonString());
        return 0;
    }

    private static int CommandEnable(string[] args)
    {
        var opts = ParseOptions(args, ["config"]);
        var path = SettingsFile.Resolve(opts.GetValueOrDefault("config"));
        var root = SettingsFile.LoadRoot(path);
        var existing = SettingsFile.ReadLerna(root);
        if (existing.CompatibilityProbe)
            throw new LernaCliException("Run `lerna configure` first; a legacy lerna.probe section cannot be enabled directly");

        // The legacy single-model shape and the new per-model "lerna.models" mapping are two
        // independent, additive config paths (item 3): only validate the one(s) actually in use,
        // so a models-only config doesn't spuriously fail on "model is required".
        var legacyConfigured = !string.IsNullOrEmpty(existing.Model) || !string.IsNullOrEmpty(existing.Endpoint)
            || !string.IsNullOrEmpty(existing.KeyEnv) || !string.IsNullOrEmpty(existing.KeyFile);
        var errors = legacyConfigured ? existing.FormatErrors() : new List<string>();
        errors.AddRange(existing.ModelsFormatErrors());
        if (!legacyConfigured && existing.Models.Count == 0)
            errors.Add("model is required, or at least one lerna.models mapping");
        if (errors.Count > 0) throw new LernaCliException("Cannot enable: " + string.Join("; ", errors));

        // keyEnv readability is intentionally NOT checked here: the CLI process may run before
        // the interactive Copilot session grants access to that environment variable. A keyFile,
        // however, is checkable right now, and safety must never be skipped silently.
        if (!string.IsNullOrEmpty(existing.KeyFile)
            && ConfigValidation.CheckKeyFileAccess(existing.KeyFile) is { } keyFileError)
            throw new LernaCliException("Cannot enable: " + keyFileError);

        var updated = existing with { Enabled = true };
        SettingsFile.WriteLerna(root, updated);
        SettingsFile.SaveRootAtomic(path, root);
        Console.WriteLine(StatusJson(updated).ToJsonString());
        return 0;
    }

    private static int CommandDisable(string[] args)
    {
        var opts = ParseOptions(args, ["config"]);
        var path = SettingsFile.Resolve(opts.GetValueOrDefault("config"));
        var root = SettingsFile.LoadRoot(path);
        var existing = SettingsFile.ReadLerna(root);
        var updated = existing with { Enabled = false };
        SettingsFile.WriteLerna(root, updated);
        SettingsFile.SaveRootAtomic(path, root);
        Console.WriteLine(StatusJson(updated).ToJsonString());
        return 0;
    }

    private static async Task<int> CommandImport(string[] args)
    {
        if (args.Length == 0 || args[0].StartsWith("--", StringComparison.Ordinal))
            throw new LernaCliException("Usage: lerna import OWNER/REPO [--ref REF] [--path PATH] [--config PATH]");
        var repository = args[0];
        var opts = ParseOptions(args[1..], ["ref", "path", "config"]);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        GitHubImport.Result result;
        try
        {
            result = await GitHubImport.RunAsync(
                repository, opts.GetValueOrDefault("ref"), opts.GetValueOrDefault("path"), cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw new LernaCliException("Import timed out contacting GitHub");
        }

        var path = SettingsFile.Resolve(opts.GetValueOrDefault("config"));
        var root = SettingsFile.LoadRoot(path);
        SettingsFile.WriteLerna(root, result.Config);
        SettingsFile.SaveRootAtomic(path, root);
        Console.WriteLine(StatusJson(result.Config).ToJsonString());
        return 0;
    }

    /// <summary>Launches the already-installed `copilot` executable with the one environment
    /// variable that disables its native WebSocket response callback, so the HTTP-based BYOK
    /// interception path is used for this run instead. Every argument after "copilot" is passed
    /// through untouched -- this command does not parse or validate them.
    ///
    /// This never downloads a binary, never invokes a shell (no /bin/sh, no cmd.exe -- process
    /// creation goes straight to the resolved executable with an explicit argument list), and
    /// never mutates this process's own environment or any user profile/rc file: the variable is
    /// set only in the spawned child's environment block.</summary>
    private static async Task<int> CommandCopilot(string[] args)
    {
        var psi = new ProcessStartInfo("copilot") { UseShellExecute = false };
        foreach (var arg in args) psi.ArgumentList.Add(arg);
        // Must be the literal string "true" -- "1" is not recognized by the native CLI.
        psi.Environment["COPILOT_CLI_DISABLE_WEBSOCKET_RESPONSES"] = "true";

        using var process = new Process { StartInfo = psi };
        try
        {
            if (!process.Start()) throw new LernaCliException("Could not start the copilot executable");
        }
        catch (Exception ex) when (ex is not LernaCliException)
        {
            throw new LernaCliException("Could not find or start `copilot` on PATH");
        }

        // Stdio is inherited directly (no redirection was requested above), so the child gets a
        // real, interactive terminal exactly as if the user had run `copilot` themselves.
        await process.WaitForExitAsync().ConfigureAwait(false);
        return process.ExitCode;
    }

    private static async Task<int> CommandServe(string[] args)
    {
        var opts = ParseOptions(args, ["config"]);
        var configPath = SettingsFile.Resolve(opts.GetValueOrDefault("config"));
        await using var stdin = Console.OpenStandardInput();
        await using var stdout = Console.OpenStandardOutput();
        var bridge = new Bridge(configPath);
        await bridge.RunAsync(stdin, stdout);
        return 0;
    }

    /// <summary>Runs the interactive Entra device-code flow directly from the CLI (no Copilot
    /// extension in the loop), printing the verification URL and user code to stderr as soon as
    /// they're known, then blocking until sign-in completes, is declined, or expires. Prints only
    /// a nonsecret summary (tenant, expiry) to stdout on success -- never a token.</summary>
    private static async Task<int> CommandLogin(string[] args)
    {
        var opts = ParseOptions(args, ["config"]);
        var path = SettingsFile.Resolve(opts.GetValueOrDefault("config"));

        using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(16));
        JsonObject result;
        try
        {
            result = await DeviceCodeAuth.LoginAsync(path, (message, verificationUri, userCode) =>
            {
                Console.Error.WriteLine(message);
                Console.Error.WriteLine($"Verification URL: {verificationUri}");
                Console.Error.WriteLine($"Code: {userCode}");
                return Task.CompletedTask;
            }, cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw new LernaCliException("Azure sign-in timed out");
        }

        Console.WriteLine(result.ToJsonString());
        return 0;
    }

    private static int CommandLogout(string[] args)
    {
        var opts = ParseOptions(args, ["config"]);
        var path = SettingsFile.Resolve(opts.GetValueOrDefault("config"));
        DeviceCodeAuth.Logout(path);
        Console.WriteLine(new JsonObject { ["loggedOut"] = true }.ToJsonString());
        return 0;
    }
}
