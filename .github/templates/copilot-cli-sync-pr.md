## Copilot CLI compatibility sync

This branch was created by the scheduled Lerna compatibility check. It compares models mentioned by the newest GitHub Copilot CLI release against Lerna's reviewed model catalog and HydraFusion allowlist, then flags relevant changes for compatibility review.

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

The Copilot model picker and HydraFusion do not necessarily use the same model universe. Keep the current Lerna allowlist unless the `/model/fusion` planner accepts the new ID in a validated plan. If it does, update the mapping and route settings to match the equivalent Azure deployment, then ask for review.
