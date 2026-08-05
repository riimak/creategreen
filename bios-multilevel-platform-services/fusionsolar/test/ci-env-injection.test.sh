#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VALUES_SOURCE="$REPO_ROOT/bios-multilevel-platform-services/fusionsolar/.gitlab/auto-deploy-values.yaml"
FORWARD_SCRIPT="$REPO_ROOT/bios-multilevel-platform-services/fusionsolar/.gitlab/forward-env.sh"
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

VALUES_FILE="$TEST_TMP/auto-deploy-values.yaml"
cp "$VALUES_SOURCE" "$VALUES_FILE"

export FUSIONSOLAR_API_BASE_URL='https://region.example/api: v1#literal\path"quote'
export FUSIONSOLAR_REDIRECT_URI
FUSIONSOLAR_REDIRECT_URI="$(printf '%s\n%s' \
  'https://bios-multilevel.barrage.net/oauth/fusionsolar/callback?literal=: # fragment' \
  'second line: "quoted" \backslash # hash')"
export FUSIONSOLAR_CLIENT_SECRET
FUSIONSOLAR_CLIENT_SECRET="$(printf '%s\n%s\n%s' \
  'quote: "double" and backslash: \server\share' \
  '# literal hash at line start' \
  "single quote: ' remains literal")"

bash "$FORWARD_SCRIPT" "$VALUES_FILE" \
  FUSIONSOLAR_API_BASE_URL \
  FUSIONSOLAR_REDIRECT_URI \
  FUSIONSOLAR_CLIENT_SECRET

npm install --silent --prefix "$TEST_TMP/yaml-parser" yaml
NODE_PATH="$TEST_TMP/yaml-parser/node_modules" node - "$VALUES_FILE" <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const YAML = require('yaml');

const valuesFile = process.argv[2];
const values = YAML.parse(fs.readFileSync(valuesFile, 'utf8'));
const entries = values.extraEnv;

for (const name of [
  'FUSIONSOLAR_API_BASE_URL',
  'FUSIONSOLAR_REDIRECT_URI',
  'FUSIONSOLAR_CLIENT_SECRET',
]) {
  const matches = entries.filter((entry) => entry.name === name);
  assert.equal(matches.length, 1, `${name} must occur exactly once`);
  assert.equal(matches[0].value, process.env[name], `${name} must round-trip exactly`);
}

console.log('CI_ENV_ROUND_TRIP_OK');
NODE
