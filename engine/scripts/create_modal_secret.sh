#!/usr/bin/env bash
# Creates (or replaces) the "soro-engine" Modal secret.
# Asks for the Hugging Face read token without echoing it; ENGINE_TOKEN comes from gateway/.env
# so the gateway and the engine share it. Nothing is printed or left on disk.
#   cd engine && bash scripts/create_modal_secret.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=../gateway/.env
ENGINE_TOKEN=$(grep -E '^ENGINE_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
if [ -z "$ENGINE_TOKEN" ]; then
  echo "ENGINE_TOKEN is empty in $ENV_FILE" >&2
  exit 1
fi

read -r -s -p "Hugging Face read token (hf_...): " HF_TOKEN
echo
case "$HF_TOKEN" in
  hf_*) ;;
  *) echo "That doesn't look like a Hugging Face token." >&2; exit 1 ;;
esac

TMP=$(mktemp)
chmod 600 "$TMP"
trap 'rm -f "$TMP"' EXIT
printf 'HF_TOKEN=%s\nENGINE_TOKEN=%s\n' "$HF_TOKEN" "$ENGINE_TOKEN" > "$TMP"

uv run --with modal modal secret create soro-engine --from-dotenv "$TMP" --force
