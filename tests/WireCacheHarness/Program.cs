using System.Net;
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

var longHostId = new string('x', 428);
var withHostIds = (JsonObject)baseBody.DeepClone();
withHostIds["input"] = new JsonArray(
    new JsonObject { ["type"] = "message", ["role"] = "user", ["content"] = "hello", ["id"] = longHostId },
    new JsonObject { ["type"] = "function_call_output", ["call_id"] = longHostId, ["output"] = "done", ["id"] = longHostId },
    new JsonObject { ["type"] = "message", ["role"] = "user", ["content"] = "short", ["id"] = new string('y', 64) },
    new JsonObject { ["type"] = "item_reference", ["id"] = longHostId });
var normalizedIds = Rewrite(withHostIds)["input"]!.AsArray();
Check(normalizedIds[0]!["id"] is null, "oversized message item id was forwarded to Azure");
Check(normalizedIds[1]!["id"] is null, "oversized tool output item id was forwarded to Azure");
Check(normalizedIds[1]!["call_id"]!.GetValue<string>() == longHostId, "tool call relationship was altered");
Check(normalizedIds[2]!["id"]!.GetValue<string>().Length == 64, "valid item id was removed");
Check(normalizedIds[3]!["id"]!.GetValue<string>() == longHostId, "item reference id was silently altered");

var withEncryptedReasoning = (JsonObject)baseBody.DeepClone();
withEncryptedReasoning["input"] = new JsonArray(
    new JsonObject
    {
        ["type"] = "reasoning",
        ["id"] = Convert.ToBase64String(new byte[315]),
        ["encrypted_content"] = "copilot-bound-ciphertext",
        ["summary"] = new JsonArray(),
    },
    new JsonObject
    {
        ["type"] = "reasoning",
        ["id"] = "rs_azure_reasoning_item",
        ["encrypted_content"] = "azure-bound-ciphertext",
        ["summary"] = new JsonArray(),
    },
    new JsonObject { ["type"] = "message", ["role"] = "user", ["content"] = "continue" });
var normalizedReasoning = Rewrite(withEncryptedReasoning)["input"]!.AsArray();
Check(normalizedReasoning.Count == 2, "foreign encrypted reasoning item was forwarded to Azure");
Check(normalizedReasoning[0]!["id"]!.GetValue<string>() == "rs_azure_reasoning_item",
    "Azure reasoning continuation item was removed");
Check(normalizedReasoning[0]!["encrypted_content"]!.GetValue<string>() == "azure-bound-ciphertext",
    "Azure reasoning continuation content was altered");

// The mirror image, for a model deliberately left on Copilot while others route to Foundry:
// Azure's own rs_ items are the foreign ones now, and Copilot answers HTTP 400 if they survive.
var backToCopilot = (JsonObject)baseBody.DeepClone();
backToCopilot["input"] = new JsonArray(
    new JsonObject
    {
        ["type"] = "reasoning",
        ["id"] = Convert.ToBase64String(new byte[315]),
        ["encrypted_content"] = "copilot-bound-ciphertext",
        ["summary"] = new JsonArray(),
    },
    new JsonObject
    {
        ["type"] = "reasoning",
        ["id"] = "rs_azure_reasoning_item",
        ["encrypted_content"] = "azure-bound-ciphertext",
        ["summary"] = new JsonArray(),
    },
    new JsonObject { ["type"] = "message", ["role"] = "user", ["content"] = "continue" });
Check(ModelWire.StripForeignEncryptedReasoning(backToCopilot, ReasoningOrigin.Copilot),
    "scrub did not report removing Azure reasoning");
var copilotReasoning = backToCopilot["input"]!.AsArray();
Check(copilotReasoning.Count == 2, "Azure encrypted reasoning item was forwarded to Copilot");
Check(copilotReasoning[0]!["encrypted_content"]!.GetValue<string>() == "copilot-bound-ciphertext",
    "Copilot's own reasoning continuation item was removed");
Check(copilotReasoning[1]!["type"]!.GetValue<string>() == "message", "user input was altered");

// A conversation Lerna never routed must be left completely alone.
var untouched = (JsonObject)baseBody.DeepClone();
Check(!ModelWire.StripForeignEncryptedReasoning(untouched, ReasoningOrigin.Copilot),
    "scrub reported a change on a body with no foreign reasoning");
Check(untouched["input"]!.AsArray().Count == 1, "clean body was modified");

// A deployment refusing on capacity must hand the turn back to Copilot, never fail it, while a
// genuine rejection of the request itself must still surface.
Check(Bridge.IsCapacityRefusal(HttpStatusCode.TooManyRequests), "429 was not treated as a capacity refusal");
Check(Bridge.IsCapacityRefusal(HttpStatusCode.ServiceUnavailable), "503 was not treated as a capacity refusal");
Check(Bridge.IsCapacityRefusal((HttpStatusCode)529), "529 overloaded was not treated as a capacity refusal");
Check(!Bridge.IsCapacityRefusal(HttpStatusCode.BadRequest), "400 must not be retried on Copilot");
Check(!Bridge.IsCapacityRefusal(HttpStatusCode.Unauthorized), "401 must not be retried on Copilot");
Check(!Bridge.IsCapacityRefusal(HttpStatusCode.OK), "200 must not be treated as a refusal");

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
