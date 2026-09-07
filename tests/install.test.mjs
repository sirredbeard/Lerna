import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checksumFor, githubDownload, installRelease, platformAsset } from "../integration/extensions/lerna/install.mjs";

test("platform selection rejects unsupported builds", () => {
  assert.equal(platformAsset("linux", "arm64").name, "lerna-linux-arm64");
  assert.equal(platformAsset("win32", "x64").name, "lerna-win-x64.exe");
  assert.equal(platformAsset("win32", "arm64").name, "lerna-win-arm64.exe");
  assert.equal(platformAsset("darwin", "arm64").name, "lerna-osx-arm64");
  assert.throws(() => platformAsset("darwin", "x64"), /supports Linux/);
});

test("checksum lookup requires exactly one matching filename", () => {
  const hash = "a".repeat(64);
  assert.equal(checksumFor(`${hash} *lerna-linux-x64\n`, "lerna-linux-x64"), hash);
  assert.throws(() => checksumFor(`${hash}  wrong\n`, "lerna-linux-x64"), /missing/);
  assert.throws(() => checksumFor(`${hash}  a\n${hash} *a`, "a"), /ambiguous/);
});

test("GitHub credentials are not forwarded to asset hosts", async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, ...options });
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/file" } })
      : new Response("binary");
  };
  const bytes = await githubDownload("https://api.github.com/repos/o/r/releases/assets/1", "test-credential", 100, fetcher);
  assert.equal(bytes.toString(), "binary");
  assert.equal(requests[0].headers.Authorization, "Bearer test-credential");
  assert.equal(requests[1].headers.Authorization, undefined);
});

test("redirects outside GitHub and oversized downloads are rejected", async () => {
  await assert.rejects(githubDownload("https://api.github.com/file", "token", 100,
    async () => new Response(null, { status: 302, headers: { location: "https://example.com" } })), /Unexpected/);
  await assert.rejects(githubDownload("https://api.github.com/file", undefined, 2,
    async () => new Response("long")), /size limit/);
  await assert.rejects(githubDownload("http://api.github.com/file", undefined, 100), /Expected/);
});

test("release install verifies bytes and reuses the cache without network access", async t => {
  const root = await mkdtemp(join(tmpdir(), "lerna-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("test executable");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const fetcher = async url => {
    if (url.includes("/tags/")) return Response.json({
      tag_name: "v1.0.83", draft: false, assets: [{ id: 1, name: "SHA256SUMS" }, { id: 2, name: "lerna-linux-x64" }],
    });
    return new Response(url.endsWith("/1") ? `${hash}  lerna-linux-x64\n` : bytes);
  };
  const options = { root, version: "1.0.83", platform: "linux", arch: "x64" };
  const path = await installRelease({ ...options, fetcher });
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(await installRelease({ ...options, fetcher: () => { throw new Error("Unexpected fetch"); } }), path);
});

test("a bad checksum never creates an executable", async t => {
  const root = await mkdtemp(join(tmpdir(), "lerna-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fetcher = async url => {
    if (url.includes("/tags/")) return Response.json({
      tag_name: "v1.0.83", assets: [{ id: 1, name: "SHA256SUMS" }, { id: 2, name: "lerna-linux-x64" }],
    });
    return new Response(url.endsWith("/1") ? `${"a".repeat(64)}  lerna-linux-x64\n` : "wrong");
  };
  await assert.rejects(installRelease({ root, version: "1.0.83", fetcher, platform: "linux", arch: "x64" }), /does not match/);
  assert.deepEqual(await readdir(root), []);
});
