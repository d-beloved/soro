# Engine on AWS

One GPU server running the engine. It stops itself after 15 idle minutes and the gateway starts it again when a message comes in. Modal answers while it boots, and whenever it fails.

```
Render gateway ──▶ https://engine.soro.charavol.com  (EC2 g4dn.xlarge, T4: Caddy ─▶ engine container)
     │         └─▶ Modal (fallback: while AWS is asleep or booting, or when it errors or times out)
     └─ wakes the server (ec2:StartInstances) when it finds it asleep
```

Region is eu-central-1 (Frankfurt), next to Render and Supabase and as the privacy notice says.

## Before you start

In eu-central-1, request a quota increase for *Running On-Demand G and VT instances* (Service Quotas → Amazon EC2) to **4** vCPUs, one g4dn.xlarge. New accounts start at 0. Set a budget alert under Billing → Budgets.

## 1. Launch the server

EC2 → Launch instance, region **eu-central-1**:

- **AMI:** *Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)*. It comes with the NVIDIA driver, Docker and the NVIDIA container toolkit already installed.
- **Type:** `g4dn.xlarge` (T4 16 GB, 4 vCPU, 16 GB RAM). If the models run out of RAM, use `g4dn.2xlarge`, which has 32 GB.
- **Storage:** 150 GB gp3 root volume. The image is about 20 GB and the models about 30 GB.
- **Key pair:** create one and keep the `.pem`.
- **Security group:** SSH (22) from *My IP* only; HTTP (80) and HTTPS (443) from anywhere. Caddy needs 80 open to get its certificate.
- **Advanced details → Shutdown behavior:** **Stop** (the default). Never *Terminate*: the server shuts itself down when idle, and terminate would delete it.
- **Advanced details → Allow tags in metadata:** **Enable**, for the `stay-awake` tag (step 5). On a running instance: Actions → Instance settings → Allow tags in instance metadata.

Then EC2 → Elastic IPs → Allocate, and associate it with the instance, so the address survives stop and start.

## 2. DNS

Add an **A record** `engine.soro.charavol.com` pointing at the Elastic IP. In Cloudflare, set it to **DNS only** (grey cloud): Caddy handles TLS itself, and Cloudflare's proxy would cut off any request longer than 100 seconds.

## 3. Set up the box

```bash
ssh -i soro.pem ubuntu@<elastic-ip>
nvidia-smi                                                     # should show the T4
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi   # the GPU is visible from containers
git clone https://github.com/d-beloved/soro.git && cd soro/engine/aws
sudo mkdir -p /opt/soro/models && sudo chown ubuntu /opt/soro/models
```

### Models: copy them from Modal (recommended)

This gives the same files Modal serves, so the voices are exactly the same as before:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh && source ~/.local/bin/env
uvx modal token new                                  # prints a link: open it on your laptop to approve
uvx modal volume get soro-models / /opt/soro/models
ls /opt/soro/models                                  # n-atlas-q4_k_m.gguf  hf/  voices/
```

### Or build them from scratch

Needs `HF_TOKEN` with the gated model terms accepted. The Yoruba voice is the model's own and the others come from fixed seeds, but the result can still differ slightly from Modal's. Converting N-ATLaS to GGUF took 32 GB of RAM on Modal, so this may need a `g4dn.2xlarge`.

```bash
docker compose build engine
docker compose run --rm -e HF_TOKEN=hf_xxx -e HF_HUB_OFFLINE=0 engine python -m soro_engine.setup_models
```

## 4. Start it

```bash
cp .env.example .env && nano .env      # ENGINE_TOKEN: the same value as on Render and in the Modal secret
docker compose up -d --build            # the first build takes 20-30 min (llama.cpp compiles for CUDA)
docker compose logs -f engine           # wait for "Uvicorn running on http://0.0.0.0:8000"
curl https://engine.soro.charavol.com/health
curl -s -X POST https://engine.soro.charavol.com/route \
  -H "Authorization: Bearer $(grep ENGINE_TOKEN .env | cut -d= -f2)" -H "Content-Type: application/json" \
  -d '{"text":"I sell 3 bags of rice 75k","lang":"en","today":"2026-10-14"}'
```

Both containers restart by themselves after a crash, a reboot, or a stop and start.

## 5. Let it sleep when idle

On the server, install the timer that runs [idle-stop.sh](idle-stop.sh) every minute:

```bash
sudo cp ~/soro/engine/aws/soro-idle.service ~/soro/engine/aws/soro-idle.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now soro-idle.timer
```

It stops the server once the engine has gone 15 minutes without a request from the gateway (`idle_s` in `/health`), or when the engine still isn't answering 30 minutes after boot, so a broken server doesn't run up a bill. It leaves the server on while anyone is logged in over SSH, and while the instance has a `stay-awake` tag (see Day to day). To change the 15 minutes, edit `IDLE_MINUTES` in `soro-idle.service` (at least 10), copy it again and run `sudo systemctl daemon-reload`. Its log: `journalctl -u soro-idle`.

Then let the gateway start the server. In the AWS console:

1. **IAM → Policies → Create policy**, JSON, with your account id and the instance id:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{ "Effect": "Allow", "Action": "ec2:StartInstances", "Resource": "arn:aws:ec2:eu-central-1:<account-id>:instance/<instance-id>" }]
   }
   ```
   Name it `soro-start-engine`.
2. **IAM → Users → Create user** `soro-gateway` (no console access), attach `soro-start-engine`, then **Security credentials → Create access key** (*Application running outside AWS*). Keep the key id and secret for Render.

## 6. Point the gateway at it

In Render → Environment, then redeploy:

- `ENGINE_URL=https://engine.soro.charavol.com`
- `ENGINE_FALLBACK_URL=` the Modal URL
- `ENGINE_AWS_INSTANCE_ID=` the instance id (`i-…`), with `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from the `soro-gateway` user

In the gateway's logs, `engine asleep, starting it and using the fallback` is a wake-up, and `engine failed, using the fallback` means the server was up but errored or timed out.

## Day to day

- **Update the engine:** `cd ~/soro && git pull && cd engine/aws && docker compose up -d --build engine`, while logged in over SSH so the server doesn't stop itself mid-build. Messages fall back to Modal while it restarts. If `soro-idle.service` changed, copy it again and run `sudo systemctl daemon-reload`.
- **Keep it up:** EC2 → the instance → Tags → Manage tags → add `stay-awake` with `on`, or a date (`2026-12-31`) to stay up through that day (UTC). Remove the tag, or let the date pass, and it sleeps after 15 idle minutes again. If it is asleep when you add the tag, start it (Instance state → Start) or send a message.
- **Keep it off:** clear `ENGINE_AWS_INSTANCE_ID` on Render (or the next message starts it), then stop the instance.
