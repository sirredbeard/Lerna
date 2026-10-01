import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cachedBinary, checksumFor, ensureBinary, githubDownload, installRelease, platformAsset } from "../integration/extensions/lerna/install.mjs";

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

test("release install verifies the release checksum before reusing the cache", async t => {
  const root = await mkdtemp(join(tmpdir(), "lerna-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("test executable");
  const hash = createHash("sha256").update(bytes).digest("hex");
  let requests = 0;
  const fetcher = async url => {
    requests++;
    if (url.includes("/tags/")) return Response.json({
      tag_name: "v1.0.83", draft: false, assets: [{ id: 1, name: "SHA256SUMS" }, { id: 2, name: "lerna-linux-x64" }],
    });
    return new Response(url.endsWith("/1") ? `${hash}  lerna-linux-x64\n` : bytes);
  };
  const options = { root, version: "1.0.83", platform: "linux", arch: "x64" };
  const path = await installRelease({ ...options, fetcher });
  assert.deepEqual(await readFile(path), bytes);
  await rm(`${path}.sha256`);
  assert.equal(await installRelease({ ...options, fetcher }), path);
  assert.equal(await readFile(`${path}.sha256`, "utf8"), `${hash}\n`);
  assert.equal(requests, 5);
});

test("release install replaces a stale Windows cache after republishing", async t => {
  const root = await mkdtemp(join(tmpdir(), "lerna-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const versions = [Buffer.from("first executable"), Buffer.from("republished executable")];
  let release = 0;
  const fetcher = async url => {
    if (url.includes("/tags/")) return Response.json({
      tag_name: "v1.0.83", draft: false, assets: [{ id: 1, name: "SHA256SUMS" }, { id: 2, name: "lerna-win-x64.exe" }],
    });
    const bytes = versions[release];
    const hash = createHash("sha256").update(bytes).digest("hex");
    return new Response(url.endsWith("/1") ? `${hash} *lerna-win-x64.exe\n` : bytes);
  };
  const options = { root, version: "1.0.83", platform: "win32", arch: "x64" };
  const path = await installRelease({ ...options, fetcher });
  assert.deepEqual(await readFile(path), versions[0]);
  release = 1;
  assert.equal(await installRelease({ ...options, fetcher }), path);
  assert.deepEqual(await readFile(path), versions[1]);
});

// ensureBinary honours LERNA_BINARY as an explicit override, so the download and
// cache paths can only be exercised with that override cleared. The build workflow
// sets it for the native smoke test.
function hostCache(root, version) {
  const { rid, name } = platformAsset();
  const directory = join(root, version, rid);
  return { directory, binary: join(directory, name.endsWith(".exe") ? "lerna.exe" : "lerna") };
}

function withoutBinaryOverride(t) {
  const previous = process.env.LERNA_BINARY;
  delete process.env.LERNA_BINARY;
  t.after(() => {
    if (previous === undefined) delete process.env.LERNA_BINARY;
    else process.env.LERNA_BINARY = previous;
  });
}

test("a cached binary is reused when the release cannot be reached", async t => {
  withoutBinaryOverride(t);
  const root = await mkdtemp(join(tmpdir(), "lerna-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("cached executable");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const { directory, binary } = hostCache(root, "1.0.84");
  await mkdir(directory, { recursive: true });
  await writeFile(binary, bytes);
  await writeFile(`${binary}.sha256`, `${hash}\n`);
  assert.equal(await ensureBinary("1.0.84", {
    root,
    fetcher: async () => new Response("unavailable", { status: 503 }),
  }), binary);
  await writeFile(binary, Buffer.from("tampered"));
  await assert.rejects(cachedBinary({ root, version: "1.0.84" }), /does not match its recorded checksum/);
});

test("cache fallback preserves a non-authentication download error", async t => {
  withoutBinaryOverride(t);
  const root = await mkdtemp(join(tmpdir(), "lerna-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    ensureBinary("1.0.84", {
      root,
      fetcher: async () => new Response("unavailable", { status: 500 }),
    }),
    error => error.status === 500 && /HTTP 500/.test(error.message),
  );
});

test("cache fallback does not hide release validation failures", async t => {
  withoutBinaryOverride(t);
  const root = await mkdtemp(join(tmpdir(), "lerna-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("cached executable");
  const { directory, binary } = hostCache(root, "1.0.84");
  await mkdir(directory, { recursive: true });
  await writeFile(binary, bytes);
  await writeFile(`${binary}.sha256`, `${createHash("sha256").update(bytes).digest("hex")}\n`);
  await assert.rejects(
    ensureBinary("1.0.84", { root, fetcher: async () => new Response("{bad json") }),
    SyntaxError,
  );
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
