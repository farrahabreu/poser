#!/bin/bash

# POSER — push latest changes to GitHub
# Run this after any Claude session: ./push.sh

cd "$(dirname "$0")"

echo "📦 Staging changes..."
git add .

# Use provided message or default with timestamp
MSG="${1:-update $(date '+%Y-%m-%d %H:%M')}"

git commit -m "$MSG" 2>/dev/null || { echo "✓ Nothing new to commit."; exit 0; }

echo "🚀 Pushing to GitHub..."
git push origin main

echo "✅ Done. Pull in Ona with: git pull origin main"
