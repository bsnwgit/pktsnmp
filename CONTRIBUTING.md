# Contributing to pktSNMP

## Branch strategy

> **Note:** This repo previously used a `main` → `develop` → `feature/<name>` three-tier
> flow (see git history through PR #15). It no longer does — there is no `develop` branch.
> Every PR since has branched from and merged directly into `main`.

| Branch | Purpose |
|---|---|
| `main` | Production-ready code — reflects what is deployed |
| `feature/<name>` / `fix/<name>` | Individual features or bug fixes, branched from `main` |

## Workflow

```
main
 ├─ feature/local-poll-interface-metrics
 ├─ fix/system-resources-metrics
 └─ feature/app-wide-contextual-help
```

### Starting new work

```bash
cd pktsnmp

# Make sure you're up to date
git checkout main
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
# PR from feature branch directly into main
gh pr create --base main --head feature/your-feature-name --title "Your feature title"
```

### Deploying after merge

```bash
# On the server:
cd pktsnmp && git pull && cd frontend && npm ci && npm run build && cd .. && bash install.sh
```

Always cut a brand-new branch off `main` for each round of work — don't reuse a branch name across unrelated changes, since a previously merged branch name can be silently re-merged as a no-op.

## Deployment rules

- **Never deploy directly from a feature branch** — merge to `main` first
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
