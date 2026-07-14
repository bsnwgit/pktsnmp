# Contributing to pktSNMP

## Branch strategy

| Branch | Purpose |
|---|---|
| `main` | Production-ready code — reflects what is deployed |
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

```bash
cd pktsnmp

# Make sure you're up to date
git checkout develop
git pull

# Create a feature branch
git checkout -b feature/your-feature-name
```

### Committing changes

```bash
git add -A
git commit -m "short description of what changed"
git push -u origin feature/your-feature-name
```

### Opening a PR

```bash
# PR from feature branch into develop
gh pr create --base develop --head feature/your-feature-name --title "Your feature title"
```

### Releasing (merging develop → main)

When `develop` is stable and ready to ship:

```bash
gh pr create --base main --head develop --title "Release: description"
# Review and merge on GitHub, then, on the server:
cd pktsnmp && git pull && cd frontend && npm ci && npm run build && cd .. && bash install.sh
```

## Deployment rules

- **Never deploy directly from a feature branch** — merge to `develop` first
- **Deployment/diagnostic helper scripts are environment-specific** — keep them in a local, untracked `scripts/` directory (already excluded via `.gitignore`); they are not part of this repository
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
