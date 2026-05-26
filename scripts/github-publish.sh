#!/usr/bin/env bash
# One-shot: log into GitHub (if needed), push this repo, publish desktop builds on Releases.
# Run from macOS Terminal:
#   chmod +x scripts/github-publish.sh && ./scripts/github-publish.sh
#
# Requires: gh (brew install gh), plus at least one build in release/:
#   npm run build:mac
#   npm run build:win

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v gh >/dev/null 2>&1; then
  echo "Install GitHub CLI first: brew install gh"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Opening GitHub login in your browser..."
  gh auth login --web --git-protocol https -h github.com
fi

VERSION="$(node -p "require('./package.json').version")"
shopt -s nullglob
ASSETS=("$ROOT"/release/*.exe "$ROOT"/release/*.dmg)

if [[ ${#ASSETS[@]} -eq 0 ]]; then
  echo "No release assets found in: $ROOT/release"
  echo "Run one or both:"
  echo "  npm run build:mac"
  echo "  npm run build:win"
  exit 1
fi

BRANCH="$(git branch --show-current 2>/dev/null || echo main)"

if git remote | grep -q '^origin$'; then
  git push -u origin "$BRANCH"
else
  echo ""
  echo "Creating a new PRIVATE repo on GitHub and pushing..."
  REPO_NAME="${GITHUB_REPO_NAME:-}"
  if [[ -z "$REPO_NAME" ]]; then
    read -rp "Repo name [mnn-clip-namer]: " REPO_NAME
    REPO_NAME=${REPO_NAME:-mnn-clip-namer}
  fi
  gh repo create "$REPO_NAME" --private --source=. --remote=origin --push \
    --description "MNN Clip Namer — AI-powered video clip renaming (Electron)"
fi

TAG="v${VERSION}"
NOTES="## Downloads

- **Windows:** download the \`.exe\`.
- **macOS:** download the \`.dmg\`.

## First-open warnings

- Windows SmartScreen may show a warning for unsigned builds: **More info → Run anyway**.
- macOS unsigned builds may require right-clicking the app and choosing **Open** the first time.

Default build talks to your Cloudflare Worker proxy (shared secret baked into the installer).
"

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Updating assets on existing release $TAG..."
  gh release upload "$TAG" "${ASSETS[@]}" --clobber
else
  gh release create "$TAG" "${ASSETS[@]}" --title "MNN Clip Namer ${VERSION}" --notes "$NOTES"
fi

echo ""
echo "Open Releases in the browser:"
gh browse --releases
