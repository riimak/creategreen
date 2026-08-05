#!/usr/bin/env bash
set -euo pipefail

VALUES_FILE="${1:?values file is required}"
shift

for name in "$@"; do
  value="${!name:-}"
  if [ -n "$value" ]; then
    # Defaults in the committed values file are exactly two lines. CI always
    # starts from a clean checkout, so remove only that known representation.
    sed -i "/^  - name: ${name}$/,+1d" "$VALUES_FILE"
    {
      printf '  - name: %s\n' "$name"
      if [[ "$value" == *$'\n' ]]; then
        printf '    value: |+\n'
        printf '%s' "$value" | sed 's/^/      /'
      else
        printf '    value: |-\n'
        printf '%s\n' "$value" | sed 's/^/      /'
      fi
    } >> "$VALUES_FILE"
    printf 'Forwarded CI variable %s\n' "$name"
  else
    printf 'Skipped CI variable %s: not set\n' "$name"
  fi
done
