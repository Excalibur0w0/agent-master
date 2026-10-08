#!/bin/sh
set -eu
docker rm -f "${REMOTE_SIM_NAME:-am-remote-sim}" >/dev/null 2>&1 || true
echo "remote-sim stopped"
