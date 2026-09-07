using System.Text.Json.Nodes;
using Lerna;

static JsonObject Rewrite(JsonObject body, ModelMapping? mapping = null)
{
    mapping ??= new ModelMapping
    {
        ResourceId = "/subscriptions/sub-a/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/foundry-a",
        ResourceName = "foundry-a",
        Deployment = "gpt-5.6-sol",
        Endpoint = "https://foundry-a.services.ai.azure.com",
        Wire = ModelWire.Responses,
    };
    return JsonNode.Parse(ModelWire.RewriteModelToDeployment(body, mapping))!.AsObject();
}

static void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

var baseBody = new JsonObject
{
    ["model"] = "gpt-5.6-sol",
    ["instructions"] = "Stable repository instructions that must not appear in the key.",
    ["tools"] = new JsonArray(new JsonObject { ["type"] = "function", ["name"] = "read_file" }),
    ["input"] = new JsonArray(new JsonObject
    {
        ["type"] = "message",
        ["role"] = "user",
        ["content"] = "first task",
    }),
};

var first = Rewrite((JsonObject)baseBody.DeepClone());
var firstKey = first["prompt_cache_key"]!.GetValue<string>();
Check(first["model"]!.GetValue<string>() == "gpt-5.6-sol", "deployment rewrite failed");
Check(firstKey.StartsWith("lerna:", StringComparison.Ordinal), "generated key namespace missing");
Check(firstKey.Length == 64, "generated key must meet the 64-character API limit");
Check(!firstKey.Contains("foundry-a", StringComparison.Ordinal), "key exposed resource name");
Check(!firstKey.Contains("Stable repository", StringComparison.Ordinal), "key exposed prompt text");
Check(first["prompt_cache_options"] is null, "Lerna must not select explicit mode without a breakpoint");

var changedUserInput = (JsonObject)baseBody.DeepClone();
changedUserInput["input"]![0]!["content"] = "second task";
var secondKey = Rewrite(changedUserInput)["prompt_cache_key"]!.GetValue<string>();
Check(secondKey == firstKey, "variable user input changed the stable cache namespace");

var changedInstructions = (JsonObject)baseBody.DeepClone();
changedInstructions["instructions"] = "Different repository instructions";
var instructionKey = Rewrite(changedInstructions)["prompt_cache_key"]!.GetValue<string>();
Check(instructionKey == firstKey, "prompt content changed the workspace cache namespace");

var originalDirectory = Environment.CurrentDirectory;
var otherDirectory = Path.Combine(Path.GetTempPath(), "lerna-cache-scope-test");
Directory.CreateDirectory(otherDirectory);
Environment.CurrentDirectory = otherDirectory;
var workspaceKey = Rewrite((JsonObject)baseBody.DeepClone())["prompt_cache_key"]!.GetValue<string>();
Environment.CurrentDirectory = originalDirectory;
Check(workspaceKey != firstKey, "different local workspaces shared a cache namespace");

var otherResource = new ModelMapping
{
    ResourceId = "/subscriptions/sub-b/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/foundry-b",
    ResourceName = "foundry-b",
    Deployment = "gpt-5.6-sol",
    Endpoint = "https://foundry-b.services.ai.azure.com",
    Wire = ModelWire.Responses,
};
var resourceKey = Rewrite((JsonObject)baseBody.DeepClone(), otherResource)["prompt_cache_key"]!.GetValue<string>();
Check(resourceKey != firstKey, "different Azure resources shared a cache namespace");

var identified = (JsonObject)baseBody.DeepClone();
identified["safety_identifier"] = "user-a";
var identifiedKey = Rewrite(identified)["prompt_cache_key"]!.GetValue<string>();
Check(identifiedKey != firstKey, "safety identity did not scope the cache namespace");

var callerOwned = (JsonObject)baseBody.DeepClone();
callerOwned["prompt_cache_key"] = "caller-owned";
callerOwned["prompt_cache_options"] = new JsonObject { ["mode"] = "explicit", ["ttl"] = "30m" };
var preserved = Rewrite(callerOwned);
Check(preserved["prompt_cache_key"]!.GetValue<string>() == "caller-owned", "caller cache key was overwritten");
Check(preserved["prompt_cache_options"]!["mode"]!.GetValue<string>() == "explicit", "caller cache options were overwritten");

var oneOff = Rewrite(new JsonObject { ["model"] = "gpt-5.6-sol", ["input"] = "one-off prompt" });
Check(oneOff["prompt_cache_key"]!.GetValue<string>() == firstKey,
    "Responses request did not reuse the workspace cache namespace");

var anthropicMapping = otherResource with { Deployment = "claude-opus-5", Wire = ModelWire.Anthropic };
var anthropic = Rewrite(new JsonObject
{
    ["model"] = "claude-opus-5",
    ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = "hello" }),
    ["max_tokens"] = 8,
}, anthropicMapping);
Check(anthropic["prompt_cache_key"] is null, "Responses cache field was added to Anthropic Messages");

Console.WriteLine("prompt cache wire checks passed");
