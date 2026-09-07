import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const project = join(repoRoot, 'tests', 'WireCacheHarness', 'WireCacheHarness.csproj');

test('Azure Responses prompt cache policy is scoped, stable, and caller-safe', () => {
  const result = spawnSync('dotnet', ['run', '--project', project, '-c', 'Release', '--nologo'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(result.status, 0, `cache wire harness failed:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /prompt cache wire checks passed/);
});
