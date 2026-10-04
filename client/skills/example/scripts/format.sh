#!/usr/bin/env bash
# format.sh — clamps a commit subject line to 50 characters (skill policy #2).
# Usage: format.sh <subject>
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: format.sh <subject>" >&2
  exit 2
fi

printf '%s\n' "${1:0:50}"
