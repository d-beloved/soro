#!/usr/bin/env bash
# Points ENGINE_DOMAIN (from .env) at this server's current public IP. The server has no fixed address, so
# soro-dns.service runs this at every boot. ENGINE_DOMAIN is a Route 53 hosted zone of its own, and the
# instance's role may change only that zone's records (see README.md).
set -euo pipefail
cd "$(dirname "$0")"
domain=$(grep -E '^ENGINE_DOMAIN=' .env | cut -d= -f2)
[ -n "$domain" ] || { echo "ENGINE_DOMAIN is not set in .env"; exit 1; }

imds=http://169.254.169.254/latest
ip=""
for _ in $(seq 30); do
  token=$(curl -fsS --max-time 2 -X PUT "$imds/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" || true)
  ip=$(curl -fsS --max-time 2 -H "X-aws-ec2-metadata-token: $token" "$imds/meta-data/public-ipv4" || true)
  [ -n "$ip" ] && break
  sleep 2
done
[ -n "$ip" ] || { echo "no public IP"; exit 1; }

read -r zone_name zone_id < <(aws route53 list-hosted-zones-by-name --dns-name "$domain" --max-items 1 \
  --query 'HostedZones[0].[Name,Id]' --output text)
[ "$zone_name" = "$domain." ] || { echo "no Route 53 zone for $domain"; exit 1; }

aws route53 change-resource-record-sets --hosted-zone-id "${zone_id##*/}" --change-batch "{
  \"Changes\": [{\"Action\": \"UPSERT\", \"ResourceRecordSet\": {
    \"Name\": \"$domain\", \"Type\": \"A\", \"TTL\": 60, \"ResourceRecords\": [{\"Value\": \"$ip\"}]}}]}" >/dev/null
echo "$domain -> $ip"
