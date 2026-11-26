#!/usr/bin/env bash
# Builds the Lambda bundle and deploys aws/template.yaml. Run from anywhere, with AWS credentials (AWS CloudShell has them):
#   gateway/aws/deploy.sh i-0123456789abcdef0
set -euo pipefail
instance="${1:?usage: deploy.sh <engine EC2 instance id>}"
cd "$(dirname "$0")/.."

npm ci --no-audit --no-fund
npm run build:lambda

sam=(sam)
command -v sam >/dev/null || sam=(uvx --from aws-sam-cli sam)
cd aws
"${sam[@]}" deploy \
  --template-file template.yaml \
  --stack-name soro-gateway \
  --region "${AWS_REGION:-us-east-1}" \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides "EngineInstanceId=$instance"
