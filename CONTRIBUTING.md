# Contributing to pktSNMP

## Branch strategy

| Branch | Purpose |
|---|---|
| `main` | Production-ready code — reflects what is deployed on O2 |
| `develop` | Integration branch — all feature work merges here first |
| `feature/<name>` | Individual features or bug fixes, branched from `develop` |

## Workflow

```
main
 └─ develop
     ├─ feature/trap-receiver
     ├─ feature/dashboard-charts
     └─ feature/alert-rules
```

### Starting new work

```powershell
cd "C:\Users\robert.barnett\My Drive\Documents\Claude\Projects\pktSNMP"

# Make sure you're up to date
git checkout develop
git pull

# Create a feature branch
git checkout -b feature/your-feature-name
```

### Committing changes

```powershell
git add -A
git commit -m "short description of what changed"
git push -u origin feature/your-feature-name
```

### Opening a PR

```powershell
# PR from feature branch into develop
gh pr create --base develop --head feature/your-feature-name --title "Your feature title"
```

### Deploying to O2 (merging develop → main)

When `develop` is stable and ready to ship:

```powershell
gh pr create --base main --head develop --title "Release: description"
# Review and merge on GitHub, then:
python scripts/deploy_frontend.py
```

## Deployment rules

- **Never deploy directly from a feature branch** — merge to `develop` first
- **Never build the frontend on Windows** — `deploy_frontend.py` handles this via Paramiko on O2
- **One script run, no retries** — repeated SSH connections can lock the server and require a reboot
- **Backup before marking any TODO item complete** — see `backup.py`

## Commit message style

```
type: short description (imperative, lowercase)

Examples:
  feat: add SNMP v3 credential rotation
  fix: handle missing otelcol_label on ingest
  chore: update requirements.txt
  docs: expand collector setup guide
```
