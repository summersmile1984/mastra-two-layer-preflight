#!/bin/bash
set -euo pipefail
cd /Users/macstudio/mastra-two-layer-preflight/apps/l2-desktop
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
export HTTP_PROXY=http://127.0.0.1:7897
export HTTPS_PROXY=http://127.0.0.1:7897
export ALL_PROXY=http://127.0.0.1:7897
export NODE_USE_ENV_PROXY=1
exec npm run claim:dev
