#!/usr/bin/env bash
# Launch the open-art-mcp stdio MCP server. stdout = JSON-RPC only; logs go to stderr.
# Resolves its own directory, so it works from any cwd / install location.
# No secrets or API keys are needed. Optional env (all unset by default):
#   OPEN_ART_CONTACT             contact string appended to the User-Agent (e.g. a project URL)
#   OPEN_ART_DOWNLOAD_ROOT       absolute path; oa_download_image may only write beneath it
#   OPEN_ART_<MUSEUM>_MIN_INTERVAL_MS   slow a museum down further (MET | CLEVELAND | VAM; floor 50)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$ROOT/server"
exec node index.js
