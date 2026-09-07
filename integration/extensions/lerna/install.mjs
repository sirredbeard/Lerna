import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = "sirredbeard/Lerna";
const githubToken = /^(?:gh[opusr]_|github_pat_)[A-Za-z0-9_]+$/;
const assetHosts = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const maxBinary = 100 * 1024 * 1024;

export function platformAsset(platform = process.platform, arch = process.arch) {
  const rid = {
    "linux:x64": "linux-x64", "linux:arm64": "linux-arm64",
    "win32:x64": "win-x64", "win32:arm64": "win-arm64", "darwin:arm64": "osx-arm64",
  }[`${platform}:${arch}`];
  if (!rid) throw new Error("Lerna supports Linux x64/arm64, Windows x64/arm64, and macOS arm64.");
  return { rid, name: `lerna-${rid}${platform === "win32" ? ".exe" : ""}` };
}

export function checksumFor(text, name) {
  const matches = text.split(/\r?\n/).map(line => /^([a-f0-9]{64}) [ *](.+)$/i.exec(line))
    .filter(match => match?.[2] === name);
  if (matches.length !== 1) throw new Error("Release checksum is missing or ambiguous.");
  return matches[0][1].toLowerCase();
}

async function bounded(response, limit) {
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`GitHub download failed (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body || []) {
      size += chunk.byteLength;
      if (size > limit) throw new Error("GitHub download exceeds its size limit.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
}

export async function githubDownload(url, token, limit, fetcher = fetch) {
  let current = new URL(url);
  if (current.origin !== "https://api.github.com") throw new Error("Expected a GitHub API URL.");
  for (let redirects = 0; redirects < 4; redirects++) {
    if (current.protocol !== "https:" || current.username || current.password
        || (current.hostname !== "api.github.com" && !assetHosts.has(current.hostname))) {
      throw new Error("Unexpected GitHub download destination.");
    }
    const headers = {
      "User-Agent": "Lerna",
      Accept: current.pathname.includes("/releases/tags/")
        ? "application/vnd.github+json" : "application/octet-stream",
    };
    if (current.hostname === "api.github.com") {
      headers["X-GitHub-Api-Version"] = "2022-11-28";
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetcher(current.href, {
      headers, redirect: "manual", signal: AbortSignal.timeout(120000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("GitHub returned a redirect without a destination.");
      current = new URL(location, current);
      continue;
    }
    return bounded(response, limit);
  }
  throw new Error("Too many GitHub download redirects.");
}

async function gitCredential() {
  return new Promise(resolve => {
    const child = execFile("git", ["credential", "fill"], {
      windowsHide: true, timeout: 10000, maxBuffer: 16384,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    }, (error, stdout) => {
      const token = error ? "" : stdout.split(/\r?\n/).find(line => line.startsWith("password="))?.slice(9);
      resolve(githubToken.test(token || "") ? token : undefined);
    });
    child.stdin?.end("protocol=https\nhost=github.com\n\n");
  });
}

async function* credentials() {
  const seen = new Set();
  for (const name of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const token = process.env[name];
    if (token && githubToken.test(token) && !seen.has(token)) { seen.add(token); yield token; }
  }
  const stored = await gitCredential();
  if (stored && !seen.has(stored)) { seen.add(stored); yield stored; }
  try {
    const { stdout } = await exec("gh", ["auth", "token", "--hostname", "github.com"], {
      timeout: 10000, maxBuffer: 16384, windowsHide: true,
    });
    const token = stdout.trim();
    if (githubToken.test(token) && !seen.has(token)) yield token;
  } catch {}
}

export async function installRelease({ root, version, token, fetcher = fetch, platform, arch }) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error("Invalid Lerna release version.");
  const { rid, name } = platformAsset(platform, arch);
  const directory = join(root, version, rid);
  const binary = join(directory, name.endsWith(".exe") ? "lerna.exe" : "lerna");
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  try {
    const stat = await lstat(binary);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBinary) throw new Error("Invalid cached binary.");
    const expected = (await readFile(`${binary}.sha256`, "utf8")).trim();
    if (/^[a-f0-9]{64}$/.test(expected) && hash(await readFile(binary)) === expected) return binary;
  } catch {}

  const release = JSON.parse(await githubDownload(
    `https://api.github.com/repos/${repository}/releases/tags/v${version}`, token, 1024 * 1024, fetcher,
  ));
  if (release.tag_name !== `v${version}` || release.draft) throw new Error("Unexpected Lerna release.");
  const assetUrl = assetName => {
    const matches = release.assets?.filter(asset => asset.name === assetName) || [];
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id)) {
      throw new Error(`Release v${version} is missing ${assetName}.`);
    }
    return `https://api.github.com/repos/${repository}/releases/assets/${matches[0].id}`;
  };
  const sums = await githubDownload(assetUrl("SHA256SUMS"), token, 16384, fetcher);
  const expected = checksumFor(sums.toString("utf8"), name);
  const bytes = await githubDownload(assetUrl(name), token, maxBinary, fetcher);
  if (hash(bytes) !== expected) throw new Error("Lerna binary checksum does not match the release.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `.download-${randomUUID()}`);
  try {
    await writeFile(temporary, bytes, { mode: 0o700, flag: "wx" });
    try { await rename(temporary, binary); }
    catch (error) {
      if (!["EEXIST", "EPERM"].includes(error.code) || hash(await readFile(binary)) !== expected) throw error;
    }
    await writeFile(`${binary}.sha256`, `${expected}\n`, { mode: 0o600 });
    return binary;
  } finally { await rm(temporary, { force: true }); }
}

export async function ensureBinary(version) {
  if (process.env.LERNA_BINARY) {
    if (!isAbsolute(process.env.LERNA_BINARY)) throw new Error("LERNA_BINARY must be an absolute path.");
    const stat = await lstat(process.env.LERNA_BINARY);
    if (!stat.isFile()) throw new Error("LERNA_BINARY must point to a regular executable.");
    return process.env.LERNA_BINARY;
  }
  const root = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "lerna", "bin");
  let lastError;
  try { return await installRelease({ root, version }); }
  catch (error) {
    lastError = error;
    if (![401, 403, 404].includes(error.status)) throw error;
  }
  for await (const token of credentials()) {
    try { return await installRelease({ root, version, token }); }
    catch (error) {
      lastError = error;
      if (![401, 403, 404].includes(error.status)) throw error;
    }
  }
  throw new Error(`Lerna v${version} could not be downloaded (HTTP ${lastError?.status}). ` +
    "The release must exist. For this private repo, use an authorized Git credential or sign in with gh.");
}
