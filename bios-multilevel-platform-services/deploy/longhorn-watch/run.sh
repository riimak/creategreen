#!/usr/bin/env sh
# CronJob entrypoint — delegates to run.py (needs check.py on PYTHONPATH / same dir).
set -eu
cd /app
exec python3 run.py
