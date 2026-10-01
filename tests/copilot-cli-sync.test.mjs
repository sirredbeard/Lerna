import assert from "node:assert/strict";
import test from "node:test";
import {
  extractModelIds,
  modelDelta,
} from "../.github/scripts/check-copilot-cli-sync.mjs";

test("extracts model IDs from release-note names and canonical IDs", () => {
  assert.deepEqual(extractModelIds(`
    Add support for GPT-6.1 Sol, GPT-6 Luna, Claude Opus 5.5,
    Gemini 3.8 Flash, Grok 4.7, MAI Code 1.1 Flash, and kimi-k2.7-code.
  `), [
    "claude-opus-5.5",
    "gemini-3.8-flash",
    "gpt-6-luna",
    "gpt-6.1-sol",
    "grok-4.7",
    "kimi-k2.7-code",
    "mai-code-1.1-flash",
  ]);
});

test("flags only unreviewed release models or HydraFusion allowlist changes", () => {
  const previous = {
    hydraFusionModels: ["gpt-5.6-sol"],
    copilotCliModels: ["gpt-5.6-sol", "gpt-6.1-sol"],
  };

  assert.equal(modelDelta(previous, ["gpt-5.6-sol"], ["gpt-6.1-sol"]), false);
  assert.equal(modelDelta(previous, ["gpt-5.6-sol"], ["gpt-5.6-sol"]), false);
  assert.equal(modelDelta(previous, ["gpt-5.6-sol"], ["claude-opus-5.5"]), true);
  assert.equal(modelDelta(previous, ["gpt-5.6-sol", "gpt-6.1-sol"], []), true);
});
