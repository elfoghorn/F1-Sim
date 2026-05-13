#!/bin/bash
# scripts/deploy.sh
# =================
# Push index.html to GitHub Pages.
# Requires git remote 'origin' to be set and GitHub Pages enabled.

set -e

echo "▸ Deploying to GitHub Pages..."

# Check we have index.html
if [ ! -f "index.html" ]; then
    echo "❌ index.html not found. Run 'make build' first."
    exit 1
fi

# Check git is configured
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "❌ Not a git repository. Run 'git init' and add remote origin."
    exit 1
fi

# Get current branch
BRANCH=$(git branch --show-current)

# If deploying from main, push to gh-pages branch
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
    echo "  Deploying from $BRANCH → gh-pages..."
    
    # Stage and commit any changes
    git add index.html
    if ! git diff --cached --quiet; then
        git commit -m "build: update compiled app [skip ci]"
    fi
    
    # Push to gh-pages (creates it if needed)
    git push origin HEAD:gh-pages --force
    
    echo "✅ Deployed to GitHub Pages"
    echo "   Your app will be live at:"
    REMOTE=$(git remote get-url origin 2>/dev/null || echo "")
    if [[ "$REMOTE" == *"github.com"* ]]; then
        REPO=$(echo "$REMOTE" | sed 's/.*github.com[:/]\(.*\)\.git/\1/' | sed 's/.*github.com[:/]\(.*\)/\1/')
        USER=$(echo "$REPO" | cut -d'/' -f1)
        NAME=$(echo "$REPO" | cut -d'/' -f2)
        echo "   https://$USER.github.io/$NAME"
    fi
else
    echo "  Current branch: $BRANCH (not main/master)"
    echo "  Push to main first, or GitHub Actions will deploy automatically."
fi
