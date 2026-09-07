import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Bridge, requestSessionId } from "../integration/extensions/lerna/bridge.mjs";

function bridge(t) {
  const value = new Bridge(process.execPath, [fileURLToPath(new URL("./fixtures/bridge-helper.mjs", import.meta.url))]);
  t.after(() => value.close());
  return value;
}

test("planner attribution uses the exact native session header only when context is absent", () => {
  const planner = new Request("https://api.githubcopilot.com/model/fusion", { headers: { "x-client-session-id": "ours" } });
  assert.equal(requestSessionId(planner, {}, "ours"), "ours");
  assert.equal(requestSessionId(planner, { sessionId: "other" }, "ours"), "other");
  assert.equal(requestSessionId(planner, {}, "different"), undefined);
  assert.equal(requestSessionId(new Request("https://api.githubcopilot.com/responses", {
    headers: { "x-client-session-id": "ours" },
  }), {}, "ours"), undefined);
});

test("bridge reconstructs streamed responses and grants bounded credits", async t => {
  const value = bridge(t);
  const response = await value.forward(new Request("https://api.githubcopilot.com/responses"), {
    sessionId: "test", signal: new AbortController().signal,
  });
  assert.equal(await response.text(), "hello");
  assert.equal((await value.invoke("status")).credits, 2);
});

test("bridge sends cancellation to the helper", async t => {
  const value = bridge(t);
  const response = await value.forward(new Request("https://api.githubcopilot.com/responses"), {
    sessionId: "test", signal: new AbortController().signal,
  });
  await response.body.cancel();
  assert.equal((await value.invoke("status")).cancellations, 1);
});

test("bridge rejects oversized request bodies before forwarding", async t => {
  const value = bridge(t);
  await assert.rejects(value.forward(new Request("https://api.githubcopilot.com/responses", {
    method: "POST", body: Buffer.alloc(16 * 1024 * 1024 + 1),
  }), { sessionId: "test", signal: new AbortController().signal }), /16 MiB/);
});

test("Azure login waits for the native sign-in dialog", async t => {
  const value = bridge(t);
  let accepted = false;
  const result = await value.invoke("azure.login", {}, {
    onProgress: async ({ userCode }) => {
      assert.equal(userCode, "ABC12345");
      await new Promise(resolve => setTimeout(resolve, 10));
      accepted = true;
    },
  });
  assert.equal(accepted, true);
  assert.equal(result.authenticated, true);
});

test("declining sign-in rejects the operation", async t => {
  const value = bridge(t);
  await assert.rejects(value.invoke("azure.login", {}, {
    onProgress: () => { throw new Error("Cancelled"); },
  }), /Cancelled/);
});

test("helper errors and invalid frames fail safely", async t => {
  const value = bridge(t);
  await assert.rejects(value.invoke("error"), /Operation rejected/);
  await assert.rejects(value.invoke("malformed"), /Invalid response/);
  await assert.rejects(value.invoke("status"), /not running/);
});
