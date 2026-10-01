import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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

export function normalizeModelList(list) {
  return [...new Set((list ?? []).map((value) => String(value).trim()).filter(Boolean))].sort();
}

export function extractModelIds(value) {
  if (!value) return [];
  const normalized = String(value).toLowerCase().replaceAll('_', '-');
  const patterns = [
    /\bgpt[- ]\d+(?:\.\d+)*(?:[- ](?:sol|luna|terra|astra|mini|codex))?\b/g,
    /\bclaude[- ](?:haiku|sonnet|opus|fable)[- ]\d+(?:\.\d+)*(?:[- ]fast)?\b/g,
    /\bgemini[- ]\d+(?:\.\d+)*(?:[- ]flash)?\b/g,
    /\bgrok[- ]\d+(?:\.\d+)*\b/g,
    /\bmai[- ]code[- ]\d+(?:\.\d+)*(?:[- ]flash(?:[- ]picker)?)?\b/g,
    /\bkimi[- ]k\d+(?:\.\d+)*(?:[- ]code)?\b/g,
  ];
  return normalizeModelList(patterns.flatMap(pattern =>
    [...normalized.matchAll(pattern)].map(match => match[0].replaceAll(' ', '-')),
  ));
}

export function modelDelta(previousState, currentHydraFusionModels, releaseModels) {
  const previousHydra = normalizeModelList(previousState.hydraFusionModels);
  const previousCopilot = new Set(normalizeModelList(previousState.copilotCliModels));
  return JSON.stringify(normalizeModelList(currentHydraFusionModels)) !== JSON.stringify(previousHydra)
    || normalizeModelList(releaseModels).some(model => !previousCopilot.has(model));
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
  const releaseModels = extractModelIds(releaseNotes);

  let previousState;
  try {
    previousState = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read the committed Copilot CLI compatibility baseline at ${statePath}: ${error.message}`);
  }

  const copilotCliModels = normalizeModelList([...previousState.copilotCliModels, ...releaseModels]);
  const hasModelDelta = modelDelta(previousState, hydraFusionModels, releaseModels);

  const state = {
    lastTag: latestRelease.tag_name,
    latestVersion,
    hydraFusionModels,
    copilotCliModels,
    checkedAt: new Date().toISOString(),
  };

  if (hasModelDelta) writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const outputs = [
    `latest_version=${latestVersion}`,
    `latest_tag=${latestRelease.tag_name}`,
    `latest_release_url=${latestRelease.html_url}`,
    `copilot_cli_models=${copilotCliModels.join(',') || 'n/a'}`,
    `release_models=${releaseModels.join(',') || 'n/a'}`,
    `hydra_fusion_models=${hydraFusionModels.join(',')}`,
    `model_delta=${hasModelDelta ? 'changed' : 'none'}`,
  ];

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
  }

  console.log(`Copilot CLI latest: ${latestRelease.tag_name} (${latestVersion})`);
  console.log(`HydraFusion allowlist: ${hydraFusionModels.join(', ')}`);
  console.log(`Reviewed Copilot CLI models: ${previousState.copilotCliModels.join(', ') || 'none recorded'}`);
  console.log(`Models mentioned by this release: ${releaseModels.join(', ') || 'none'}`);
  if (hasModelDelta) {
    console.log('The release mentions an unreviewed model or the HydraFusion allowlist changed; a compatibility PR should be prepared.');
  } else {
    console.log('No unreviewed model additions detected; the current Lerna build can be refreshed without a routing change.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    process.exit(1);
  });
}
