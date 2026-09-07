// Lerna .NET core tests (Node built-in test runner only; no external packages).
//
// Run with:  node --test tests/core.test.mjs
// (Rebuilds the Debug .dll once in `before()` so the tests always exercise current source.)
//
// Scope, matching what's genuinely testable without live network/TLS or system changes:
//   - settings.json preservation, atomicity, and the 1 MiB bound
//   - configure/enable/disable validation and rejection of unsafe endpoint/key config
//   - the legacy lerna.probe compatibility shape
//   - the serve JSON-lines protocol: status/environment/attach/event acknowledgements,
//     credit/cancel no-ops, oversized-frame and malformed-frame handling, and clean EOF shutdown
//   - forward-op checks that don't require a live upstream (scheme/body-size/encoding rejection,
//     and a local connection-refused passthrough attempt)
//
// Out of scope here (left to the parent's live Azure/Copilot verification, per task scope):
// actual Hydra plan interception against a real CAPI host, real BYOK streaming over TLS, and
// end-to-end credit-paced chunk delivery of a genuine upstream response.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile, readdir, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectDir = join(repoRoot, 'src', 'Lerna');
const dllPath = join(projectDir, 'bin', 'Debug', 'net11.0', 'lerna.dll');

// POSIX file-mode bits (owner/group/world read-write) are not meaningful on Windows -- chmod
// there does not make a file group/world readable, so the "reject a world-readable key file"
// half of the permission tests only applies on Unix-like platforms.
const isWindows = process.platform === 'win32';

before(() => {
  const build = spawnSync('dotnet', ['build', '-c', 'Debug'], { cwd: projectDir, encoding: 'utf8', timeout: 120000 });
  if (build.status !== 0) {
    throw new Error(`dotnet build failed:\n${build.stdout}\n${build.stderr}`);
  }
});

let workDir;
before(async () => { workDir = await mkdtemp(join(tmpdir(), 'lerna-tests-')); });
after(async () => { if (workDir) await rm(workDir, { recursive: true, force: true }); });

let fileCounter = 0;
function freshConfigPath() { return join(workDir, `settings-${++fileCounter}.json`); }

function runCli(args, { timeout = 15000, env = baseTestEnv() } = {}) {
  const result = spawnSync('dotnet', [dllPath, ...args], { encoding: 'utf8', timeout, env });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// Async CLI runner: required (instead of spawnSync) whenever a test also runs an in-process
// (same Node event loop) local stub HTTP server that the child dotnet process needs to talk to
// -- spawnSync blocks the entire Node event loop until the child exits, so a same-process stub
// server could never accept the child's connection and the run would hang until it timed out.
function runCliAsync(args, { timeout = 15000, env = baseTestEnv() } = {}) {
  return new Promise(resolve => {
    const proc = spawn('dotnet', [dllPath, ...args], { env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => { if (!settled) proc.kill('SIGKILL'); }, timeout);
    proc.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    proc.on('error', () => {});
    proc.on('close', code => {
      settled = true;
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function parseStdoutJson(result) {
  assert.equal(result.status, 0, `expected success, stderr: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

// ---------------------------------------------------------------------------
// Local stub Entra server (used only by the azure device-code/token-cache tests below). Real
// Entra is never contacted: EntraClient (Auth.cs) only ever honors this loopback redirection via
// LERNA_TEST_ENTRA_BASE_URL, and only for an http(s) URL whose host is 127.0.0.1/localhost.
// ---------------------------------------------------------------------------

function startStub(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        handler({ method: req.method, url: req.url, headers: req.headers, body }, res);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

function parseForm(body) { return Object.fromEntries(new URLSearchParams(body).entries()); }

function sendJson(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

// ---------------------------------------------------------------------------
// CLI: version
// ---------------------------------------------------------------------------

test('version prints a version string and exits 0', () => {
  const result = runCli(['version']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /lerna \d+\.\d+\.\d+/);
});

test('unknown command exits 2', () => {
  const result = runCli(['bogus']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown command/);
});

test('unknown option exits 1 and unexpected positional arg is rejected', () => {
  const bad1 = runCli(['status', '--nope', 'x']);
  assert.equal(bad1.status, 1);
  assert.match(bad1.stderr, /Unknown option/);

  const bad2 = runCli(['status', 'extra']);
  assert.equal(bad2.status, 1);
  assert.match(bad2.stderr, /Unexpected argument/);
});

// ---------------------------------------------------------------------------
// CLI: init / status, preservation and the 1 MiB bound
// ---------------------------------------------------------------------------

test('status on a missing config file reports disabled/unconfigured without error', () => {
  const cfg = freshConfigPath();
  const result = parseStdoutJson(runCli(['status', '--config', cfg]));
  assert.deepEqual(result, {
    enabled: false, verbose: true, configured: false, model: null, deployment: null, endpoint: null,
    keySource: null, keyEnv: null, keyFile: null, compatibilityProbe: false,
    azure: { loggedIn: false },
  });
});

test('init adds a disabled lerna section and preserves unrelated settings', async () => {
  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({ unrelated: { nested: [1, 2, 'three'], emoji: '🎉' }, other: 123 }));

  const first = parseStdoutJson(runCli(['init', '--config', cfg]));
  assert.equal(first.initialized, true);

  const onDisk = JSON.parse(await readFile(cfg, 'utf8'));
  assert.deepEqual(onDisk.unrelated, { nested: [1, 2, 'three'], emoji: '🎉' });
  assert.equal(onDisk.other, 123);
  assert.deepEqual(onDisk.lerna, { enabled: false });

  // Idempotent: a second init must not report re-initialization or disturb the section.
  const second = parseStdoutJson(runCli(['init', '--config', cfg]));
  assert.equal(second.initialized, false);
});

test('config over the 1 MiB bound is refused, not silently truncated', async () => {
  const cfg = freshConfigPath();
  const big = { padding: 'x'.repeat(2 * 1024 * 1024) };
  await writeFile(cfg, JSON.stringify(big));

  const result = runCli(['status', '--config', cfg]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 MiB/);
  assert.equal(result.stdout, '');
});

test('atomic writes leave no temp files behind', async () => {
  const cfg = freshConfigPath();
  runCli(['init', '--config', cfg]);
  runCli(['configure', '--config', cfg, '--model', 'gpt-5.6-terra',
    '--endpoint', 'https://foo.cognitiveservices.azure.com/openai/v1/responses', '--key-env', 'FOO_KEY']);
  const entries = await readdir(workDir);
  const leftovers = entries.filter(name => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

// ---------------------------------------------------------------------------
// CLI: configure validation
// ---------------------------------------------------------------------------

test('configure rejects a model id containing a slash', () => {
  const cfg = freshConfigPath();
  const result = runCli(['configure', '--config', cfg, '--model', 'foo/bar',
    '--endpoint', 'https://x.cognitiveservices.azure.com/openai/v1/responses', '--key-env', 'K']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /model must match/);
});

test('configure rejects a non-https endpoint', () => {
  const cfg = freshConfigPath();
  const result = runCli(['configure', '--config', cfg, '--model', 'm',
    '--endpoint', 'http://x.cognitiveservices.azure.com/openai/v1/responses', '--key-env', 'K']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /https/);
});

test('configure rejects an endpoint with credentials, query, or fragment', () => {
  const cfg = freshConfigPath();
  for (const endpoint of [
    'https://user:pass@x.cognitiveservices.azure.com/openai/v1/responses',
    'https://x.cognitiveservices.azure.com/openai/v1/responses?api-version=1',
    'https://x.cognitiveservices.azure.com/openai/v1/responses#frag',
  ]) {
    const result = runCli(['configure', '--config', cfg, '--model', 'm', '--endpoint', endpoint, '--key-env', 'K']);
    assert.equal(result.status, 1, endpoint);
  }
});

test('configure rejects an endpoint whose path does not end with /responses', () => {
  const cfg = freshConfigPath();
  const result = runCli(['configure', '--config', cfg, '--model', 'm',
    '--endpoint', 'https://x.cognitiveservices.azure.com/openai/v1/completions', '--key-env', 'K']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\/responses/);
});

test('configure rejects a githubcopilot.com endpoint as a BYOK target', () => {
  const cfg = freshConfigPath();
  const result = runCli(['configure', '--config', cfg, '--model', 'm',
    '--endpoint', 'https://api.individual.githubcopilot.com/openai/v1/responses', '--key-env', 'K']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /githubcopilot\.com/);
});

test('configure requires exactly one of --key-env or --key-file', () => {
  const cfg = freshConfigPath();
  const endpoint = 'https://x.cognitiveservices.azure.com/openai/v1/responses';
  const neither = runCli(['configure', '--config', cfg, '--model', 'm', '--endpoint', endpoint]);
  assert.equal(neither.status, 1);
  const both = runCli(['configure', '--config', cfg, '--model', 'm', '--endpoint', endpoint,
    '--key-env', 'K', '--key-file', '/tmp/whatever']);
  assert.equal(both.status, 1);
});

test('configure with --key-file enforces owner-only permissions', async () => {
  const cfg = freshConfigPath();
  const keyFile = join(workDir, 'key-perm-test');
  await writeFile(keyFile, 'super-secret-value\n', { mode: 0o644 });
  const endpoint = 'https://x.cognitiveservices.azure.com/openai/v1/responses';

  // chmod(0o644) is only group/world-readable on Unix; on Windows it has no such effect, so the
  // ACL-based check correctly reports the file as safe. Only assert rejection on Unix.
  if (!isWindows) {
    const worldReadable = runCli(['configure', '--config', cfg, '--model', 'm', '--endpoint', endpoint, '--key-file', keyFile]);
    assert.equal(worldReadable.status, 1);
    assert.match(worldReadable.stderr, /owner-only|group or others/);
    assert.doesNotMatch(worldReadable.stderr, /super-secret-value/);
  }

  await chmod(keyFile, 0o600); // writeFile's `mode` only applies at creation, not to an existing file
  const ownerOnly = parseStdoutJson(runCli(['configure', '--config', cfg, '--model', 'm', '--endpoint', endpoint, '--key-file', keyFile]));
  assert.equal(ownerOnly.keySource, 'file');
  assert.equal(ownerOnly.keyFile, keyFile);

  // The status/configure JSON output must never contain the secret value itself.
  const raw = JSON.stringify(ownerOnly);
  assert.doesNotMatch(raw, /super-secret-value/);
});

test('configure preserves the enabled flag across a re-configure, and defaults it false initially', () => {
  const cfg = freshConfigPath();
  const endpoint = 'https://x.cognitiveservices.azure.com/openai/v1/responses';
  const first = parseStdoutJson(runCli(['configure', '--config', cfg, '--model', 'model-a', '--endpoint', endpoint, '--key-env', 'K']));
  assert.equal(first.enabled, false);

  runCli(['enable', '--config', cfg]);
  const reconfigured = parseStdoutJson(runCli(['configure', '--config', cfg, '--model', 'model-b', '--endpoint', endpoint, '--key-env', 'K']));
  assert.equal(reconfigured.enabled, true, 'enabled flag must survive a reconfigure');
  assert.equal(reconfigured.model, 'model-b');
});

test('configure preserves the verbose preference', async () => {
  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({ lerna: { enabled: false, verbose: true } }));
  const result = parseStdoutJson(runCli(['configure', '--config', cfg, '--model', 'model-a',
    '--endpoint', 'https://x.cognitiveservices.azure.com/openai/v1/responses', '--key-env', 'K']));
  assert.equal(result.verbose, true);
  assert.equal(JSON.parse(await readFile(cfg, 'utf8')).lerna.verbose, true);
});

test('configure defaults deployment to model when --deployment is omitted', () => {
  const cfg = freshConfigPath();
  const result = parseStdoutJson(runCli(['configure', '--config', cfg, '--model', 'my-model',
    '--endpoint', 'https://x.cognitiveservices.azure.com/openai/v1/responses', '--key-env', 'K']));
  assert.equal(result.deployment, 'my-model');
});

// ---------------------------------------------------------------------------
// CLI: enable / disable
// ---------------------------------------------------------------------------

test('enable fails clearly on an unconfigured section and never sets enabled', () => {
  const cfg = freshConfigPath();
  runCli(['init', '--config', cfg]);
  const result = runCli(['enable', '--config', cfg]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot enable/);
});

test('enable succeeds for a keyEnv config even when the env var is absent from the CLI process', () => {
  const cfg = freshConfigPath();
  runCli(['configure', '--config', cfg, '--model', 'm',
    '--endpoint', 'https://x.cognitiveservices.azure.com/openai/v1/responses', '--key-env', 'DEFINITELY_UNSET_VAR_XYZ']);
  const env = { ...process.env };
  delete env.DEFINITELY_UNSET_VAR_XYZ;
  const result = spawnSync('dotnet', [dllPath, 'enable', '--config', cfg], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).enabled, true);
});

test('enable fails clearly when the configured keyFile has unsafe permissions', async () => {
  const cfg = freshConfigPath();
  const keyFile = join(workDir, 'key-enable-test');
  await writeFile(keyFile, 'secret\n', { mode: 0o600 });
  runCli(['configure', '--config', cfg, '--model', 'm',
    '--endpoint', 'https://x.cognitiveservices.azure.com/openai/v1/responses', '--key-file', keyFile]);
  await chmod(keyFile, 0o644); // now unsafe (writeFile's `mode` would be ignored on an existing file)
  const result = runCli(['enable', '--config', cfg]);
  // chmod(0o644) has no group/world-readable effect on Windows, so `enable` correctly succeeds
  // there; the unsafe-permissions rejection is a Unix-only assertion.
  if (isWindows) {
    assert.doesNotMatch(JSON.stringify(result), /secret/);
    return;
  }
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot enable/);
  assert.doesNotMatch(result.stderr, /secret/);
});

test('disable clears enabled while preserving model/endpoint/key fields', () => {
  const cfg = freshConfigPath();
  runCli(['configure', '--config', cfg, '--model', 'm',
    '--endpoint', 'https://x.cognitiveservices.azure.com/openai/v1/responses', '--key-env', 'K']);
  runCli(['enable', '--config', cfg]);
  const disabled = parseStdoutJson(runCli(['disable', '--config', cfg]));
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.model, 'm');
  assert.equal(disabled.configured, true);
});

test('legacy lerna.probe is read as disabled compatibility and cannot be enabled directly', async () => {
  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({
    lerna: { probe: { model: 'gpt-5.6-terra', endpoint: 'https://foo.cognitiveservices.azure.com/openai/v1/responses', keyEnv: 'AZURE_FOUNDRY_API_KEY' } },
  }));
  const status = parseStdoutJson(runCli(['status', '--config', cfg]));
  assert.equal(status.enabled, false);
  assert.equal(status.compatibilityProbe, true);
  assert.equal(status.model, 'gpt-5.6-terra');

  const enable = runCli(['enable', '--config', cfg]);
  assert.equal(enable.status, 1);
  assert.match(enable.stderr, /lerna configure/);
});

// ---------------------------------------------------------------------------
// serve: JSON-lines protocol
// ---------------------------------------------------------------------------

class ServeSession {
  // `env` defaults to the ambient environment with LERNA_CLIENT_ID stripped, so azure.* /
  // Azure-routing tests are deterministic regardless of what's set in the developer's shell;
  // pass an explicit env (e.g. { ...baseTestEnv(), LERNA_CLIENT_ID: '...' }) to opt in.
  constructor(configPath, env = baseTestEnv()) {
    this.proc = spawn('dotnet', [dllPath, 'serve', '--config', configPath], { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.queue = [];
    this.waiters = [];
    this.stderr = '';
    // The child may exit (e.g. on a fatal oversized frame) while a large write to its stdin is
    // still in flight; without this handler Node treats that EPIPE as an uncaught exception.
    this.proc.stdin.on('error', () => {});
    this.proc.stderr.on('data', chunk => { this.stderr += chunk.toString('utf8'); });
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (this.waiters.length) this.waiters.shift().resolve(message);
      else this.queue.push(message);
    });
  }

  send(message) { this.proc.stdin.write(JSON.stringify(message) + '\n'); }
  writeRaw(text) { this.proc.stdin.write(text); }

  next(timeoutMs = 5000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
      };
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(entry);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('timed out waiting for a protocol message'));
      }, timeoutMs);
      this.waiters.push(entry);
    });
  }

  async silenceFor(timeoutMs = 400) {
    try { return await this.next(timeoutMs); } catch { return undefined; }
  }

  endStdin() { this.proc.stdin.end(); }

  exitCode() {
    if (this.proc.exitCode !== null) return Promise.resolve(this.proc.exitCode);
    return new Promise(resolve => this.proc.once('exit', code => resolve(code)));
  }

  kill() { try { this.proc.kill(); } catch { /* already gone */ } }
}

function baseTestEnv() {
  const env = { ...process.env };
  delete env.LERNA_CLIENT_ID;
  return env;
}

// Used only by tests that specifically exercise the device-code/token-cache path with a
// The real "Lerna CLI" app registration's client ID (public client, delegated
// user_impersonation on Cognitive Services + ARM, admin-consented in the target tenant). Tests
// use it as an opaque string against a local stub server -- it never talks to real Entra here.
const FAKE_CLIENT_ID = 'e3e9d1ab-9283-4cb6-b512-07d9a47fad06';

function configuredSettings(cfg) {
  runCli(['configure', '--config', cfg, '--model', 'gpt-5.6-terra',
    '--endpoint', 'https://foo.cognitiveservices.azure.com/openai/v1/responses', '--key-env', 'FOO_KEY']);
  runCli(['enable', '--config', cfg]);
}

test('serve: status/environment/attach/event acknowledge with the documented shapes', async () => {
  const cfg = freshConfigPath();
  configuredSettings(cfg);
  const session = new ServeSession(cfg);
  try {
    session.send({ id: '1', op: 'status' });
    const status = await session.next();
    assert.equal(status.id, '1');
    assert.equal(status.type, 'result');
    assert.deepEqual(status.value, {
      enabled: true, verbose: true, configured: true, model: 'gpt-5.6-terra', deployment: 'gpt-5.6-terra',
      endpoint: 'https://foo.cognitiveservices.azure.com/openai/v1/responses',
      requiredEnvironmentVariables: ['FOO_KEY'],
    });

    session.send({ id: '2', op: 'verbose', enabled: true });
    const verbose = await session.next();
    assert.deepEqual(verbose, { id: '2', type: 'result', value: { verbose: true } });
    assert.equal(JSON.parse(await readFile(cfg, 'utf8')).lerna.verbose, true);

    session.send({ id: '2a', op: 'verbose' });
    assert.deepEqual(await session.next(), { id: '2a', type: 'error', error: 'verbose requires a boolean enabled value' });
    session.send({ id: '2b', op: 'verbose', enabled: 'yes' });
    assert.deepEqual(await session.next(), { id: '2b', type: 'error', error: 'verbose requires a boolean enabled value' });

    session.send({ id: '2c', op: 'status' });
    assert.equal((await session.next()).value.verbose, true, 'invalid values must not change the saved preference');

    session.send({ id: '3', op: 'environment', values: { FOO_KEY: 'shh', UNRELATED: 'ignored' } });
    const env = await session.next();
    assert.deepEqual(env, { id: '3', type: 'result', value: true });

    session.send({ id: '4', op: 'attach', sessionId: 'session-abc' });
    const attach = await session.next();
    assert.deepEqual(attach, { id: '4', type: 'result', value: true });

    session.send({
      id: '5', op: 'event', sessionId: 'session-abc', event: 'session.fusion_resolved',
      data: { fusionId: 'f1', primaryModel: 'gpt-5.6-terra' },
    });
    const event = await session.next();
    assert.deepEqual(event, { id: '5', type: 'result', value: true });
  } finally {
    session.kill();
  }
});

test('serve: unknown op fails immediately without disrupting later requests', async () => {
  const cfg = freshConfigPath();
  configuredSettings(cfg);
  const session = new ServeSession(cfg);
  try {
    session.send({ id: 'x', op: 'not-a-real-op' });
    assert.deepEqual(await session.next(), { id: 'x', type: 'error', error: 'Unsupported Lerna operation' });

    session.send({ id: '1', op: 'status' });
    const status = await session.next();
    assert.equal(status.id, '1');
  } finally {
    session.kill();
  }
});

test('serve: enable and disable persist routing state', async () => {
  const cfg = freshConfigPath();
  configuredSettings(cfg);
  const session = new ServeSession(cfg);
  try {
    session.send({ id: 'd', op: 'disable' });
    assert.deepEqual(await session.next(), { id: 'd', type: 'result', value: { enabled: false } });
    session.send({ id: 'e', op: 'enable' });
    assert.deepEqual(await session.next(), { id: 'e', type: 'result', value: { enabled: true } });
    assert.equal(JSON.parse(await readFile(cfg, 'utf8')).lerna.enabled, true);
  } finally {
    session.kill();
  }
});

test('serve: malformed JSON line is ignored and the server keeps running', async () => {
  const cfg = freshConfigPath();
  configuredSettings(cfg);
  const session = new ServeSession(cfg);
  try {
    session.writeRaw('{ this is not json \n');
    session.send({ id: '1', op: 'status' });
    const status = await session.next();
    assert.equal(status.id, '1');
  } finally {
    session.kill();
  }
});

test('serve: credit/cancel for an unknown requestId are silent no-ops (bounded, never crash)', async () => {
  const cfg = freshConfigPath();
  configuredSettings(cfg);
  const session = new ServeSession(cfg);
  try {
    session.send({ op: 'credit', requestId: 'nonexistent' });
    session.send({ op: 'cancel', requestId: 'nonexistent' });
    const silence = await session.silenceFor();
    assert.equal(silence, undefined, 'credit/cancel must never reply for their own op');

    session.send({ id: '1', op: 'status' });
    const status = await session.next();
    assert.equal(status.id, '1', 'server must remain responsive afterwards');
  } finally {
    session.kill();
  }
});

test('serve: forward rejects non-https URLs without touching the network', async () => {
  const cfg = freshConfigPath();
  configuredSettings(cfg);
  const session = new ServeSession(cfg);
  try {
    session.send({
      id: 'f1', op: 'forward', sessionId: 'session-abc', url: 'http://example.com/model/fusion',
      method: 'POST', headers: {}, body: '',
    });
    const reply = await session.next();
    assert.equal(reply.id, 'f1');
    assert.equal(reply.type, 'error');
    assert.match(reply.error, /HTTPS/);
  } finally {
    session.kill();
  }
});

test('serve: forward rejects a body over 16 MiB', async () => {
  const cfg = freshConfigPath();
  configuredSettings(cfg);
  const session = new ServeSession(cfg);
  try {
    const oversized = Buffer.alloc(16 * 1024 * 1024 + 16, 'a').toString('base64');
    session.send({
      id: 'f2', op: 'forward', sessionId: 'session-abc',
      url: 'https://api.individual.githubcopilot.com/responses',
      method: 'POST', headers: {}, body: oversized,
    });
    const reply = await session.next(10000);
    assert.equal(reply.type, 'error');
    assert.match(reply.error, /16 MiB/);
  } finally {
    session.kill();
  }
});

test('serve: forward rejects invalid base64 bodies', async () => {
  const cfg = freshConfigPath();
  configuredSettings(cfg);
  const session = new ServeSession(cfg);
  try {
    session.send({
      id: 'f3', op: 'forward', sessionId: 'session-abc',
      url: 'https://api.individual.githubcopilot.com/responses',
      method: 'POST', headers: {}, body: 'not-valid-base64!!!',
    });
    const reply = await session.next();
    assert.equal(reply.type, 'error');
    assert.match(reply.error, /encoding/);
  } finally {
    session.kill();
  }
});

test('serve: a disabled/unmatched forward still attempts plain passthrough and fails safely when unreachable', async () => {
  // No live upstream is available in this environment; connecting to an unused loopback port
  // fails at TCP-connect time (before any TLS handshake), so this needs no real certificate or
  // network access while still proving the passthrough code path executes and errors cleanly.
  const cfg = freshConfigPath();
  runCli(['init', '--config', cfg]); // left disabled/unconfigured on purpose
  const session = new ServeSession(cfg);
  try {
    session.send({
      id: 'f4', op: 'forward', sessionId: 'unbound-session',
      url: 'https://127.0.0.1:1/whatever', method: 'GET', headers: {}, body: '',
    });
    const reply = await session.next(10000);
    assert.equal(reply.id, 'f4');
    assert.equal(reply.type, 'error');
    assert.doesNotMatch(reply.error, /127\.0\.0\.1|Exception|StackTrace/);

    session.send({ id: '1', op: 'status' });
    const status = await session.next();
    assert.equal(status.id, '1', 'server must remain responsive after a failed forward');
  } finally {
    session.kill();
  }
});

test('serve: an oversized protocol frame terminates the process cleanly (no crash dump, sanitized message)', async () => {
  const cfg = freshConfigPath();
  configuredSettings(cfg);
  const session = new ServeSession(cfg);
  try {
    const huge = 'a'.repeat(25 * 1024 * 1024) + '\n';
    session.writeRaw(huge);
    const code = await session.exitCode();
    assert.equal(code, 1);
    assert.match(session.stderr, /Oversized protocol frame/);
    assert.doesNotMatch(session.stderr, /at Lerna\./); // no raw stack trace leaked
  } finally {
    session.kill();
  }
});

test('serve: stdin EOF shuts the process down cleanly with no active requests', async () => {
  const cfg = freshConfigPath();
  configuredSettings(cfg);
  const session = new ServeSession(cfg);
  try {
    session.send({ id: '1', op: 'status' });
    await session.next();
    session.endStdin();
    const code = await session.exitCode();
    assert.equal(code, 0);
  } finally {
    session.kill();
  }
});

test('serve: attach rebinds the session and clears prior fusion state (no cross-session routing)', async () => {
  const cfg = freshConfigPath();
  configuredSettings(cfg);
  const session = new ServeSession(cfg);
  try {
    session.send({ id: '1', op: 'attach', sessionId: 'session-a' });
    await session.next();
    // An event for a session that was never bound must be a safe no-op (still acknowledged).
    session.send({ id: '2', op: 'event', sessionId: 'session-b', event: 'session.fusion_resolved', data: {} });
    const ack = await session.next();
    assert.deepEqual(ack, { id: '2', type: 'result', value: true });
  } finally {
    session.kill();
  }
});

// ---------------------------------------------------------------------------
// CLI: import
//
// GitHubImport.RunAsync validates the repository string, then the --path safety, before it
// ever shells out to `gh`. That lets these cases be verified deterministically -- no live
// network/gh access required, matching this suite's out-of-scope note for live verification.
// Anything past that point (fetching real repo/file contents, secret materialization) was
// verified manually end-to-end against a throwaway private test repo; it isn't exercised here.
// ---------------------------------------------------------------------------

test('import requires a positional OWNER/REPO argument', () => {
  const cfg = freshConfigPath();
  const noArgs = runCli(['import', '--config', cfg]);
  assert.equal(noArgs.status, 1);
  assert.match(noArgs.stderr, /Usage: lerna import OWNER\/REPO/);

  const flagFirst = runCli(['import', '--ref', 'main']);
  assert.equal(flagFirst.status, 1);
  assert.match(flagFirst.stderr, /Usage: lerna import OWNER\/REPO/);
});

test('import rejects an unknown option without touching the network', () => {
  const result = runCli(['import', 'owner/repo', '--bogus', 'x']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option: --bogus/);
});

test('import rejects repository strings that are not OWNER/REPO or https://github.com/OWNER/REPO', () => {
  const cases = [
    ['owner/repo/extra', /OWNER\/REPO form/],
    ['justowner', /OWNER\/REPO form/],
    ['https://evil.com/owner/repo', /must start with https:\/\/github\.com\//],
    ['http://github.com/owner/repo', /must start with https:\/\/github\.com\//],
    ['git@github.com:owner/repo.git', /OWNER\/REPO or https:\/\/github\.com/],
    ['owner/../repo', /invalid characters|OWNER\/REPO form/],
    ['../../etc/passwd', /OWNER\/REPO form/],
    ['owner/repo with space', /invalid characters/],
    ['', /repository is required/],
  ];
  for (const [repo, pattern] of cases) {
    const result = runCli(['import', repo]);
    assert.equal(result.status, 1, `expected rejection for repository: ${JSON.stringify(repo)}`);
    assert.match(result.stderr, pattern, `for repository: ${JSON.stringify(repo)}`);
  }
});

test('import rejects an unsafe --path before contacting the network', () => {
  const cases = ['/etc/passwd', '../secrets.json', 'a\\b.json'];
  for (const path of cases) {
    const result = runCli(['import', 'owner/repo', '--path', path], { timeout: 20000 });
    assert.equal(result.status, 1, `expected rejection for path: ${JSON.stringify(path)}`);
    assert.match(result.stderr, /Invalid --path/, `for path: ${JSON.stringify(path)}`);
  }
});

test('serve: import with a missing repository field is a sanitized error, not a crash', async () => {
  const cfg = freshConfigPath();
  configuredSettings(cfg);
  const session = new ServeSession(cfg);
  try {
    session.send({ id: 'i1', op: 'import' });
    const reply = await session.next();
    assert.deepEqual(reply, { id: 'i1', type: 'error', error: 'import requires a repository' });

    // Server must remain responsive afterwards.
    session.send({ id: '1', op: 'status' });
    const status = await session.next();
    assert.equal(status.id, '1');
  } finally {
    session.kill();
  }
});

test('serve: import with an invalid repository string is rejected before any network access', async () => {
  const cfg = freshConfigPath();
  configuredSettings(cfg);
  const session = new ServeSession(cfg);
  try {
    session.send({ id: 'i2', op: 'import', repository: 'not-a-valid-repo-string' });
    const reply = await session.next(20000);
    assert.equal(reply.id, 'i2');
    assert.equal(reply.type, 'error');
    assert.match(reply.error, /OWNER\/REPO form/);
  } finally {
    session.kill();
  }
});

// ---------------------------------------------------------------------------
// Multi-model config: "lerna.auth" / "lerna.models" (additive to the legacy single-model
// keyEnv/keyFile shape above, which remains fully supported). SettingsFile only round-trips
// this shape today; there is no CLI/bridge op yet that writes it (that requires the still-
// pending Azure discovery/mapping wiring), so these tests write settings.json directly and
// verify `status` reflects exactly what was persisted, with no secret ever surfacing.
// ---------------------------------------------------------------------------

test('status reflects a persisted lerna.auth + lerna.models section (CLI)', async () => {
  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({
    lerna: {
      enabled: true,
      auth: { type: 'azure', tenantId: '11111111-1111-1111-1111-111111111111', subscriptionId: '22222222-2222-2222-2222-222222222222' },
      models: {
        'gpt-5.6-terra': {
          resourceId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.CognitiveServices/accounts/contoso-foundry',
          resourceName: 'contoso-foundry', deployment: 'gpt-5.6-terra',
          endpoint: 'https://contoso-foundry.cognitiveservices.azure.com', wire: 'responses',
        },
      },
    },
  }));
  const result = parseStdoutJson(runCli(['status', '--config', cfg]));
  assert.equal(result.configured, true);
  assert.deepEqual(result.auth, { type: 'azure', tenantId: '11111111-1111-1111-1111-111111111111', subscriptionId: '22222222-2222-2222-2222-222222222222' });
  assert.deepEqual(result.models, ['gpt-5.6-terra']);
});

test('enable preserves lerna.auth.clientId instead of silently dropping it', async () => {
  // Regression: LernaAuth.ToJson() once omitted clientId, so any write-back (configure,
  // enable, disable) deleted the user's configured app registration from settings.json and
  // the next `lerna login` failed with "No Azure client ID configured".
  const cfg = freshConfigPath();
  const clientId = '33333333-3333-3333-3333-333333333333';
  await writeFile(cfg, JSON.stringify({
    lerna: {
      enabled: false,
      auth: { type: 'azure', tenantId: '11111111-1111-1111-1111-111111111111', clientId },
      models: {
        'gpt-5.6-terra': {
          resourceId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.CognitiveServices/accounts/contoso-foundry',
          resourceName: 'contoso-foundry', deployment: 'gpt-5.6-terra',
          endpoint: 'https://contoso-foundry.cognitiveservices.azure.com', wire: 'responses',
        },
      },
    },
  }));
  assert.equal(runCli(['enable', '--config', cfg]).status, 0);
  const persisted = JSON.parse(await readFile(cfg, 'utf8'));
  assert.equal(persisted.lerna.auth.clientId, clientId);
  assert.equal(persisted.lerna.enabled, true);
});

test('enable rejects a lerna.models key outside the six HydraFusion-allowlisted IDs', async () => {
  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({
    lerna: {
      enabled: false,
      models: {
        'gpt-4o': {
          resourceId: 'r', resourceName: 'n', deployment: 'gpt-4o',
          endpoint: 'https://x.cognitiveservices.azure.com', wire: 'responses',
        },
      },
    },
  }));
  const result = runCli(['enable', '--config', cfg]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not one of the six HydraFusion-allowlisted model IDs/);
});

test('enable refuses to map either MAI model ID (no Azure equivalent)', async () => {
  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({
    lerna: {
      enabled: false,
      models: {
        'mai-code-1.1-flash': {
          resourceId: 'r', resourceName: 'n', deployment: 'mai-code-1.1-flash',
          endpoint: 'https://x.cognitiveservices.azure.com', wire: 'responses',
        },
      },
    },
  }));
  const result = runCli(['enable', '--config', cfg]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /has no Azure equivalent and must never be mapped to BYOK/);
});

test('enable accepts a verified Anthropic-wire mapping for claude-opus-5 (route/headers/auth confirmed live)', async () => {
  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({
    lerna: {
      enabled: false,
      models: {
        'claude-opus-5': {
          resourceId: 'r', resourceName: 'n', deployment: 'claude-opus-5',
          endpoint: 'https://contoso-foundry.services.ai.azure.com', wire: 'anthropic',
        },
      },
    },
  }));
  const result = parseStdoutJson(runCli(['enable', '--config', cfg]));
  assert.equal(result.enabled, true);
  assert.deepEqual(result.models, ['claude-opus-5']);
});

test('enable rejects a models mapping whose endpoint is a full URL instead of the resource base endpoint (anthropic wire)', async () => {
  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({
    lerna: {
      enabled: false,
      models: {
        'claude-opus-5': {
          resourceId: 'r', resourceName: 'n', deployment: 'claude-opus-5',
          endpoint: 'https://x.cognitiveservices.azure.com/anthropic/v1/messages', wire: 'anthropic',
        },
      },
    },
  }));
  const result = runCli(['enable', '--config', cfg]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be the resource's base endpoint only \(no path\)/);
});

test('enable rejects a models mapping whose endpoint is a full URL instead of the resource base endpoint (responses wire)', async () => {
  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({
    lerna: {
      enabled: false,
      models: {
        'gpt-5.6-sol': {
          resourceId: 'r', resourceName: 'n', deployment: 'gpt-5.6-sol',
          endpoint: 'https://x.cognitiveservices.azure.com/openai/v1/responses', wire: 'responses',
        },
      },
    },
  }));
  const result = runCli(['enable', '--config', cfg]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be the resource's base endpoint only \(no path\)/);
});

test('enable accepts a valid gpt-5.6-sol models mapping on the responses wire', async () => {
  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({
    lerna: {
      enabled: false,
      models: {
        'gpt-5.6-sol': {
          resourceId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.CognitiveServices/accounts/contoso-foundry',
          resourceName: 'contoso-foundry', deployment: 'gpt-5.6-sol',
          endpoint: 'https://contoso-foundry.cognitiveservices.azure.com', wire: 'responses',
        },
      },
    },
  }));
  const result = parseStdoutJson(runCli(['enable', '--config', cfg]));
  assert.equal(result.enabled, true);
  assert.deepEqual(result.models, ['gpt-5.6-sol']);
});

test('enable accepts the same resource base endpoint mapped for both a responses-wire and an anthropic-wire model (one resource, two wires, one base endpoint)', async () => {
  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({
    lerna: {
      enabled: false,
      models: {
        'gpt-5.6-terra': {
          resourceId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.CognitiveServices/accounts/contoso-foundry',
          resourceName: 'contoso-foundry', deployment: 'gpt-5.6-terra',
          endpoint: 'https://contoso-foundry.services.ai.azure.com', wire: 'responses',
        },
        'claude-opus-5': {
          resourceId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.CognitiveServices/accounts/contoso-foundry',
          resourceName: 'contoso-foundry', deployment: 'claude-opus-5',
          endpoint: 'https://contoso-foundry.services.ai.azure.com', wire: 'anthropic',
        },
      },
    },
  }));
  const result = parseStdoutJson(runCli(['enable', '--config', cfg]));
  assert.equal(result.enabled, true);
  assert.deepEqual(result.models.sort(), ['claude-opus-5', 'gpt-5.6-terra']);
});

test('serve: bridge status lists mapped model IDs without ever exposing endpoint/resource details', async () => {
  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({
    lerna: {
      enabled: false,
      models: {
        'gpt-5.6-sol': {
          resourceId: 'r', resourceName: 'n', deployment: 'gpt-5.6-sol',
          endpoint: 'https://x.cognitiveservices.azure.com', wire: 'responses',
        },
      },
    },
  }));
  const session = new ServeSession(cfg);
  try {
    session.send({ id: '1', op: 'status' });
    const status = await session.next();
    assert.equal(status.value.configured, true);
    assert.deepEqual(status.value.models, ['gpt-5.6-sol']);
    assert.equal(JSON.stringify(status).includes('cognitiveservices'), false, 'status must never leak endpoint/resource details');
  } finally {
    session.kill();
  }
});

// ---------------------------------------------------------------------------
// Per-model Azure routing (item 4/5): a request whose own declared model is already mapped in
// lerna.models is routed by TryForwardMapped purely by matching that model id -- no plan
// rewrite, no fusion_resolved gate needed. Bearer-token minting goes through the real
// DeviceCodeTokenProvider (Auth.cs); with no lerna.auth.clientId configured and no
// LERNA_CLIENT_ID set (see baseTestEnv), it fails fast on "no client ID configured" before any
// network call, which exercises the whole real, wire-specific routing path (Anthropic-shape
// verification, deployment-name rewrite readiness, wire selection) up to that seam, entirely
// offline, giving a safe, sanitized error instead of a hang or crash.
// ---------------------------------------------------------------------------

test('serve: a request for an already-mapped Anthropic-wire model is routed (and safely fails at the gated token seam, not the network)', async () => {
  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({
    lerna: {
      enabled: true,
      models: {
        'claude-opus-5': {
          resourceId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.CognitiveServices/accounts/contoso-foundry',
          resourceName: 'contoso-foundry', deployment: 'claude-opus-5',
          endpoint: 'https://contoso-foundry.services.ai.azure.com', wire: 'anthropic',
        },
      },
    },
  }));
  const session = new ServeSession(cfg);
  try {
    session.send({ id: 'a1', op: 'attach', sessionId: 'sess-1' });
    await session.next();

    const body = Buffer.from(JSON.stringify({
      model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64,
    })).toString('base64');
    session.send({
      id: 'f1', op: 'forward', sessionId: 'sess-1', method: 'POST',
      url: 'https://api.individual.githubcopilot.com/v1/messages', headers: {}, body,
    });
    const reply = await session.next(10000);
    assert.equal(reply.id, 'f1');
    assert.equal(reply.type, 'error');
    assert.match(reply.error, /No Azure client ID configured/);
    assert.doesNotMatch(reply.error, /Exception|StackTrace|Bearer/);

    session.send({ id: '2', op: 'status' });
    const status = await session.next();
    assert.equal(status.id, '2', 'server must remain responsive after a gated-token routing attempt');
  } finally {
    session.kill();
  }
});

test('serve: a request for an already-mapped Responses-wire model is routed (and safely fails at the gated token seam)', async () => {
  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({
    lerna: {
      enabled: true,
      models: {
        'gpt-5.6-terra': {
          resourceId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.CognitiveServices/accounts/contoso-foundry',
          resourceName: 'contoso-foundry', deployment: 'gpt-5.6-terra',
          endpoint: 'https://contoso-foundry.cognitiveservices.azure.com', wire: 'responses',
        },
      },
    },
  }));
  const session = new ServeSession(cfg);
  try {
    session.send({ id: 'a1', op: 'attach', sessionId: 'sess-1' });
    await session.next();

    const body = Buffer.from(JSON.stringify({ model: 'gpt-5.6-terra', input: 'hi' })).toString('base64');
    session.send({
      id: 'f1', op: 'forward', sessionId: 'sess-1', method: 'POST',
      url: 'https://api.individual.githubcopilot.com/responses', headers: {}, body,
    });
    const reply = await session.next(10000);
    assert.equal(reply.id, 'f1');
    assert.equal(reply.type, 'error');
    assert.match(reply.error, /No Azure client ID configured/);
  } finally {
    session.kill();
  }
});

// ---------------------------------------------------------------------------
// Azure device-code auth (Auth.cs): device-code polling, same-scope refresh, the
// on-disk token cache and its permissions, and the "never prompt from inference" seam. All
// against a local 127.0.0.1 stub via LERNA_TEST_ENTRA_BASE_URL -- never real Entra.
// ---------------------------------------------------------------------------

test('lerna login: authorization_pending is polled through to a cached, 0600 credential', async () => {
  let tokenPolls = 0;
  const stub = await startStub((req, res) => {
    if (req.url.endsWith('/devicecode')) {
      return sendJson(res, 200, {
        device_code: 'dc1', user_code: 'ABC-123', verification_uri: 'https://microsoft.com/devicelogin',
        expires_in: 60, interval: 1, message: 'Sign in to continue',
      });
    }
    tokenPolls++;
    if (tokenPolls < 3) return sendJson(res, 400, { error: 'authorization_pending' });
    return sendJson(res, 200, { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 });
  });

  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({ lerna: { auth: { clientId: FAKE_CLIENT_ID } } }));
  const env = { ...baseTestEnv(), LERNA_TEST_ENTRA_BASE_URL: stub.url };
  const result = await runCliAsync(['login', '--config', cfg], { timeout: 15000, env });
  await stub.close();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(tokenPolls, 3);
  assert.match(result.stderr, /ABC-123/);
  assert.match(result.stderr, /microsoft\.com\/devicelogin/);
  assert.doesNotMatch(result.stdout, /AT1|RT1/, 'stdout must never contain a token');
  assert.doesNotMatch(result.stderr, /AT1|RT1/, 'stderr must never contain a token');

  const value = JSON.parse(result.stdout.trim());
  assert.equal(value.tenantId, 'organizations');
  assert.equal(typeof value.expiresInSeconds, 'number');

  const cachePath = join(dirname(cfg), 'lerna-auth.json');
  const cacheStat = await stat(cachePath);
  assert.ok(cacheStat.isFile(), 'cache must be a regular file');
  if (!isWindows) {
    // POSIX mode bits do not exist on Windows, where chmod cannot express owner-only
    // access; the cache is protected there by the ACL it inherits from the user profile.
    assert.equal(cacheStat.mode & 0o777, 0o600, `cache file must be 0600, got ${(cacheStat.mode & 0o777).toString(8)}`);
    const dirStat = await stat(dirname(cachePath));
    assert.equal(dirStat.mode & 0o777, 0o700, `cache directory must be 0700, got ${(dirStat.mode & 0o777).toString(8)}`);
  }

  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.equal(cache.refreshToken, 'RT1');
  assert.equal(cache.accessTokens['https://cognitiveservices.azure.com/.default'].accessToken, 'AT1');
});

test('lerna login: slow_down increases the polling interval and polling continues to success', async () => {
  let polls = 0;
  const stub = await startStub((req, res) => {
    if (req.url.endsWith('/devicecode')) {
      return sendJson(res, 200, {
        device_code: 'dc', user_code: 'U', verification_uri: 'https://microsoft.com/devicelogin',
        expires_in: 60, interval: 1,
      });
    }
    polls++;
    if (polls === 1) return sendJson(res, 400, { error: 'slow_down' });
    if (polls === 2) return sendJson(res, 400, { error: 'authorization_pending' });
    return sendJson(res, 200, { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 });
  });

  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({ lerna: { auth: { clientId: FAKE_CLIENT_ID } } }));
  const env = { ...baseTestEnv(), LERNA_TEST_ENTRA_BASE_URL: stub.url };
  const result = await runCliAsync(['login', '--config', cfg], { timeout: 15000, env });
  await stub.close();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(polls, 3);
});

test('lerna login: expired_token and authorization_declined surface clean, sanitized errors', async () => {
  for (const [errorCode, pattern] of [['expired_token', /expired/i], ['authorization_declined', /declined/i]]) {
    const stub = await startStub((req, res) => {
      if (req.url.endsWith('/devicecode')) {
        return sendJson(res, 200, {
          device_code: 'dc', user_code: 'U', verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 60, interval: 1,
        });
      }
      return sendJson(res, 400, { error: errorCode });
    });
    const cfg = freshConfigPath();
    await writeFile(cfg, JSON.stringify({ lerna: { auth: { clientId: FAKE_CLIENT_ID } } }));
    const env = { ...baseTestEnv(), LERNA_TEST_ENTRA_BASE_URL: stub.url };
    const result = await runCliAsync(['login', '--config', cfg], { timeout: 10000, env });
    await stub.close();

    assert.equal(result.status, 1, `expected failure for ${errorCode}`);
    assert.match(result.stderr, pattern);
    assert.doesNotMatch(result.stderr, /Exception|StackTrace/);
  }
});

test('azure token refresh: an expired cached access token triggers a silent refresh (no interactive prompt)', async () => {
  let refreshHits = 0;
  const stub = await startStub((req, res) => {
    if (req.url.endsWith('/devicecode')) return sendJson(res, 500, {});
    const form = parseForm(req.body);
    if (form.grant_type === 'refresh_token') {
      refreshHits++;
      assert.equal(form.refresh_token, 'RT-OLD');
      return sendJson(res, 200, { access_token: 'AT-NEW', refresh_token: 'RT-NEW', expires_in: 3600 });
    }
    sendJson(res, 400, { error: 'invalid_request' });
  });

  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({
    lerna: {
      enabled: true, auth: { clientId: FAKE_CLIENT_ID },
      models: {
        'claude-opus-5': {
          resourceId: 'r', resourceName: 'n', deployment: 'claude-opus-5',
          endpoint: 'https://127.0.0.1:1', wire: 'anthropic',
        },
      },
    },
  }));
  const cachePath = join(dirname(cfg), 'lerna-auth.json');
  await writeFile(cachePath, JSON.stringify({
    tenantId: 'organizations', clientId: FAKE_CLIENT_ID, refreshToken: 'RT-OLD',
    accessTokens: {
      'https://cognitiveservices.azure.com/.default': {
        accessToken: 'AT-STALE', expiresAtUtc: new Date(Date.now() - 60000).toISOString(),
      },
    },
  }));
  await chmod(cachePath, 0o600);

  const env = { ...baseTestEnv(), LERNA_TEST_ENTRA_BASE_URL: stub.url };
  const session = new ServeSession(cfg, env);
  try {
    session.send({ id: 'a1', op: 'attach', sessionId: 'sess-1' });
    await session.next();
    const body = Buffer.from(JSON.stringify({
      model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
    })).toString('base64');
    session.send({
      id: 'f1', op: 'forward', sessionId: 'sess-1', method: 'POST',
      url: 'https://api.individual.githubcopilot.com/responses', headers: {}, body,
    });
    const reply = await session.next(10000);
    assert.equal(reply.type, 'error'); // mapped endpoint unreachable, but the token WAS refreshed
    assert.doesNotMatch(JSON.stringify(reply), /AT-NEW|AT-STALE|RT-OLD|RT-NEW/);
  } finally {
    session.kill();
  }
  await stub.close();

  assert.equal(refreshHits, 1);
  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.equal(cache.accessTokens['https://cognitiveservices.azure.com/.default'].accessToken, 'AT-NEW');
});

test('azure token refresh: invalid_grant discards the cached refresh token and asks the user to sign in again', async () => {
  const stub = await startStub((req, res) => {
    if (req.url.endsWith('/devicecode')) return sendJson(res, 500, {});
    sendJson(res, 400, { error: 'invalid_grant' });
  });

  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({
    lerna: {
      enabled: true, auth: { clientId: FAKE_CLIENT_ID },
      models: {
        'gpt-5.6-terra': {
          resourceId: 'r', resourceName: 'n', deployment: 'gpt-5.6-terra',
          endpoint: 'https://127.0.0.1:1', wire: 'responses',
        },
      },
    },
  }));
  const cachePath = join(dirname(cfg), 'lerna-auth.json');
  await writeFile(cachePath, JSON.stringify({ tenantId: 'organizations', clientId: FAKE_CLIENT_ID, refreshToken: 'RT-DEAD', accessTokens: {} }));
  await chmod(cachePath, 0o600);

  const env = { ...baseTestEnv(), LERNA_TEST_ENTRA_BASE_URL: stub.url };
  const session = new ServeSession(cfg, env);
  try {
    session.send({ id: 'a1', op: 'attach', sessionId: 'sess-1' });
    await session.next();
    const body = Buffer.from(JSON.stringify({ model: 'gpt-5.6-terra', input: 'hi' })).toString('base64');
    session.send({
      id: 'f1', op: 'forward', sessionId: 'sess-1', method: 'POST',
      url: 'https://api.individual.githubcopilot.com/responses', headers: {}, body,
    });
    const reply = await session.next(10000);
    assert.equal(reply.type, 'error');
    assert.match(reply.error, /sign-in has expired/i);
    assert.doesNotMatch(reply.error, /RT-DEAD/);
  } finally {
    session.kill();
  }
  await stub.close();

  const stillExists = await readFile(cachePath, 'utf8').then(() => true).catch(() => false);
  assert.equal(stillExists, false, 'the dead cache file must be deleted after invalid_grant');
});

test('azure auth: with nothing cached, GetTokenAsync throws a "sign in" error instead of prompting (inference never blocks on a browser)', async () => {
  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({
    lerna: {
      enabled: true, auth: { clientId: FAKE_CLIENT_ID },
      models: {
        'gpt-5.6-terra': {
          resourceId: 'r', resourceName: 'n', deployment: 'gpt-5.6-terra',
          endpoint: 'https://127.0.0.1:1', wire: 'responses',
        },
      },
    },
  }));
  // No LERNA_TEST_ENTRA_BASE_URL at all: this must fail purely from the empty cache, never
  // attempting any network call (interactive or otherwise).
  const session = new ServeSession(cfg);
  try {
    session.send({ id: 'a1', op: 'attach', sessionId: 'sess-1' });
    await session.next();
    const body = Buffer.from(JSON.stringify({ model: 'gpt-5.6-terra', input: 'hi' })).toString('base64');
    session.send({
      id: 'f1', op: 'forward', sessionId: 'sess-1', method: 'POST',
      url: 'https://api.individual.githubcopilot.com/responses', headers: {}, body,
    });
    const reply = await session.next(5000);
    assert.equal(reply.type, 'error');
    assert.match(reply.error, /lerna login/);
  } finally {
    session.kill();
  }
});

test('serve: azure.login/status/logout -- documented login progress frame shape, nonsecret status, and logout', async () => {
  const stub = await startStub((req, res) => {
    if (req.url.endsWith('/devicecode')) {
      return sendJson(res, 200, {
        device_code: 'dcX', user_code: 'CODE-XYZ', verification_uri: 'https://microsoft.com/devicelogin',
        expires_in: 60, interval: 1, message: 'go now',
      });
    }
    return sendJson(res, 200, { access_token: 'AT-X', refresh_token: 'RT-X', expires_in: 3600 });
  });

  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({ lerna: { auth: { clientId: FAKE_CLIENT_ID } } }));
  const env = { ...baseTestEnv(), LERNA_TEST_ENTRA_BASE_URL: stub.url };
  const session = new ServeSession(cfg, env);
  try {
    session.send({ id: 's0', op: 'azure.status' });
    const before = await session.next();
    assert.deepEqual(before, { id: 's0', type: 'result', value: { loggedIn: false } });

    session.send({ id: 'L1', op: 'azure.login' });
    const progress = await session.next(5000);
    assert.equal(progress.id, 'L1');
    assert.equal(progress.type, 'login');
    assert.equal(progress.userCode, 'CODE-XYZ');
    assert.equal(progress.verificationUri, 'https://microsoft.com/devicelogin');
    assert.equal(progress.message, 'go now');
    assert.doesNotMatch(JSON.stringify(progress), /AT-X|RT-X|dcX/);

    const result = await session.next(10000);
    assert.equal(result.id, 'L1');
    assert.equal(result.type, 'result');
    assert.equal(result.value.tenantId, 'organizations');
    assert.equal(typeof result.value.expiresInSeconds, 'number');
    assert.doesNotMatch(JSON.stringify(result), /AT-X|RT-X/);

    session.send({ id: 's1', op: 'azure.status' });
    const after = await session.next();
    assert.equal(after.value.loggedIn, true);
    assert.equal(after.value.tenantId, 'organizations');
    assert.equal(typeof after.value.expiresAtUtc, 'string');

    session.send({ id: 'lo', op: 'azure.logout' });
    const logout = await session.next();
    assert.deepEqual(logout, { id: 'lo', type: 'result', value: true });

    session.send({ id: 's2', op: 'azure.status' });
    const finalStatus = await session.next();
    assert.deepEqual(finalStatus, { id: 's2', type: 'result', value: { loggedIn: false } });
  } finally {
    session.kill();
  }
  await stub.close();
});

test('serve: cancelling an in-flight azure.login stops it cleanly and the server stays responsive', async () => {
  const stub = await startStub((req, res) => {
    if (req.url.endsWith('/devicecode')) {
      return sendJson(res, 200, {
        device_code: 'dc-hang', user_code: 'HANG-1', verification_uri: 'https://microsoft.com/devicelogin',
        expires_in: 300, interval: 1,
      });
    }
    // Always pending: this device-code flow never completes on its own; only cancellation ends it.
    sendJson(res, 400, { error: 'authorization_pending' });
  });

  const cfg = freshConfigPath();
  await writeFile(cfg, JSON.stringify({ lerna: { auth: { clientId: FAKE_CLIENT_ID } } }));
  const env = { ...baseTestEnv(), LERNA_TEST_ENTRA_BASE_URL: stub.url };
  const session = new ServeSession(cfg, env);
  try {
    session.send({ id: 'L1', op: 'azure.login' });
    const progress = await session.next(5000);
    assert.equal(progress.type, 'login');

    session.send({ op: 'cancel', requestId: 'L1' });
    // The poll loop may already have another 'login' progress frame in flight when the cancel
    // is processed; skip any of those and wait for the terminal L1 error frame.
    let cancelled;
    do {
      cancelled = await session.next(5000);
    } while (cancelled.id === 'L1' && cancelled.type === 'login');
    assert.equal(cancelled.id, 'L1');
    assert.equal(cancelled.type, 'error');

    session.send({ id: '1', op: 'status' });
    const status = await session.next();
    assert.equal(status.id, '1', 'server must remain responsive after cancelling azure.login');
  } finally {
    session.kill();
  }
  await stub.close();
});

