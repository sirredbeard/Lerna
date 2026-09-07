import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const repoRoot = process.cwd();
const statePath = `${repoRoot}/.github/copilot-cli-state.json`;
const hydraFusionModels = [
  'claude-opus-5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'mai-code-1.1-flash',
  'mai-code-1-flash-picker',
];

function normalizeModelList(list) {
  return [...new Set((list ?? []).map((value) => String(value).trim()).filter(Boolean))].sort();
}

function extractModelIdsFromMarkdown(value) {
  if (!value) return [];
  const matches = value.match(/(?:gpt-5\.6-(?:sol|luna|terra)|claude-opus-5|mai-code-1\.1-flash|mai-code-1-flash-picker)/g);
  return normalizeModelList(matches ?? []);
}

async function fetchJson(url) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'lerna-copilot-sync',
  };
  if (process.env.GH_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status} ${response.statusText}) for ${url}`);
  }

  return response.json();
}

async function main() {
  const latestRelease = await fetchJson('https://api.github.com/repos/github/copilot-cli/releases/latest');
  const latestVersion = String(latestRelease.tag_name || '').replace(/^v/, '');
  const releaseNotes = [latestRelease.name, latestRelease.body].filter(Boolean).join('\n');
  const repoReadme = existsSync(`${repoRoot}/README.md`) ? readFileSync(`${repoRoot}/README.md`, 'utf8') : '';
  const repoResearch = existsSync(`${repoRoot}/RESEARCH.md`) ? readFileSync(`${repoRoot}/RESEARCH.md`, 'utf8') : '';
  const copilotCliModels = normalizeModelList([
    ...extractModelIdsFromMarkdown(releaseNotes),
    ...extractModelIdsFromMarkdown(repoReadme),
    ...extractModelIdsFromMarkdown(repoResearch),
  ]);

  let previousState = { lastTag: null, hydraFusionModels: [], copilotCliModels: [] };
  if (existsSync(statePath)) {
    try {
      previousState = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {
      previousState = { lastTag: null, hydraFusionModels: [], copilotCliModels: [] };
    }
  }

  const modelDelta = previousState.lastTag
    ? JSON.stringify(copilotCliModels) !== JSON.stringify(previousState.copilotCliModels)
      || JSON.stringify(hydraFusionModels) !== JSON.stringify(previousState.hydraFusionModels)
    : false;

  const state = {
    lastTag: latestRelease.tag_name,
    latestVersion,
    hydraFusionModels,
    copilotCliModels,
    checkedAt: new Date().toISOString(),
  };

  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const outputs = [
    `latest_version=${latestVersion}`,
    `latest_tag=${latestRelease.tag_name}`,
    `latest_release_url=${latestRelease.html_url}`,
    `copilot_cli_models=${copilotCliModels.join(',') || 'n/a'}`,
    `hydra_fusion_models=${hydraFusionModels.join(',')}`,
    `model_delta=${modelDelta ? 'changed' : 'none'}`,
  ];

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
  }

  console.log(`Copilot CLI latest: ${latestRelease.tag_name} (${latestVersion})`);
  console.log(`HydraFusion allowlist: ${hydraFusionModels.join(', ')}`);
  console.log(`Copilot CLI observed models: ${copilotCliModels.join(', ') || 'none detected'}`);
  if (modelDelta) {
    console.log('Model support differs from the last checked state; a repair PR should be prepared.');
  } else {
    console.log('No model drift detected; the current Lerna build can be refreshed without a routing change.');
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
