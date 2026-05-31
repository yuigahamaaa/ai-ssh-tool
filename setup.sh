#!/bin/bash
# SSH Tool - Quick Setup Script
# Run this on a new machine to install dependencies and build

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "[ssh-tool] Installing dependencies..."
npm install

echo "[ssh-tool] Building..."
npm run build

echo "[ssh-tool] Done! Test with:"
echo "  node dist/cli/ssh-exec.js --help"
