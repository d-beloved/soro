#!/usr/bin/env bash
# Stops this server once the engine has had no requests for IDLE_MINUTES. soro-idle.timer runs it every minute.
# The gateway starts the server again when the next message comes in, and Modal answers until it is up. See README.md.
set -uo pipefail
IDLE_MINUTES=${IDLE_MINUTES:-15}

[ -n "$(who)" ] && exit 0  # someone is logged in over SSH

# The instance's `stay-awake` tag, set in the EC2 console: `on` keeps the server up, a date (YYYY-MM-DD) keeps
# it up through that day (UTC). Needs "Allow tags in instance metadata" on the instance.
imds=http://169.254.169.254/latest
imds_token=$(curl -fsS --max-time 2 -X PUT "$imds/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
stay=$(curl -fsS --max-time 2 -H "X-aws-ec2-metadata-token: $imds_token" "$imds/meta-data/tags/instance/stay-awake" | tr 'A-Z' 'a-z')
case "$stay" in
  on | yes | true) exit 0 ;;
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) [[ "$(date -u +%F)" > "$stay" ]] || exit 0 ;;
esac

up_s=$(cut -d. -f1 /proc/uptime)
if idle_s=$(curl -fsS --max-time 5 http://127.0.0.1:8000/health | python3 -c 'import json,sys; print(json.load(sys.stdin)["idle_s"])'); then
  if [ "$idle_s" -ge $((IDLE_MINUTES * 60)) ]; then
    echo "engine idle for ${idle_s}s: stopping the server"
    shutdown -h now
  fi
elif [ "$up_s" -ge 1800 ]; then
  # Up half an hour and the engine still isn't answering: stop rather than pay for a broken server.
  echo "engine not answering after ${up_s}s up: stopping the server"
  shutdown -h now
fi
