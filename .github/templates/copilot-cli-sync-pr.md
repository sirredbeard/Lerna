## Copilot CLI compatibility sync

This branch was created by the scheduled Lerna compatibility check. It compares the newest GitHub Copilot CLI release against the HydraFusion allowlist used by Lerna and flags model drift.

Please review the existing guidance in these files before changing the route map:

- `README.md`
- `RESEARCH.md`
- `src/Lerna/Configuration.cs`

Then validate the Foundry catalog with Azure CLI:

```bash
az login
az account set --subscription "$AZURE_SUBSCRIPTION_ID"
az cognitiveservices model list \
  --location eastus2 \
  --query "[?name=='gpt-5.6-sol' || name=='gpt-5.6-luna' || name=='gpt-5.6-terra' || name=='claude-opus-5'].{model:name,format:format,version:version,skus:skus[].name}" \
  --output table
```

If the latest Copilot CLI release does not introduce a new HydraFusion-compatible model set, keep the current Lerna mapping as-is and refresh the release artifact. If it does, update the mapping and route settings to match the equivalent Azure deployments, then ask for review.
