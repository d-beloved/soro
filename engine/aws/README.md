# Engine on AWS

One always-on GPU server running the engine, with the Modal deployment kept as the gateway's fallback. Modal still scales to zero, so it costs nothing until AWS fails.

```
Render gateway ──▶ https://engine.soro.charavol.com  (EC2 g4dn.xlarge, T4: Caddy ─▶ engine container)
               └─▶ Modal (fallback: used when AWS errors or times out, scales to zero)
```

Region is eu-central-1 (Frankfurt), next to Render and Supabase and as the privacy notice says.

## Before you start (AWS console)

1. **GPU quota.** New accounts can't run any GPU instance. In the **eu-central-1** region, go to Service Quotas → Amazon EC2 → *Running On-Demand G and VT instances* and request **8** (vCPUs). Approval takes anywhere from a few hours to a couple of days.
2. **Budget alert.** Under Billing → Budgets, create a monthly cost budget with an email alert.

## 1. Launch the server

EC2 → Launch instance, region **eu-central-1**:

- **AMI:** *Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)*. It comes with the NVIDIA driver, Docker and the NVIDIA container toolkit already installed.
- **Type:** `g4dn.xlarge` (T4 16 GB, 4 vCPU, 16 GB RAM). If the models run out of RAM, use `g4dn.2xlarge`, which has 32 GB.
- **Storage:** 150 GB gp3 root volume. The image is about 20 GB and the models about 30 GB.
- **Key pair:** create one and keep the `.pem`.
- **Security group:** SSH (22) from *My IP* only; HTTP (80) and HTTPS (443) from anywhere. Caddy needs 80 open to get its certificate.

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

Both containers restart by themselves after a crash or a reboot.

## 5. Point the gateway at it

1. In Supabase, run `supabase/migrations/0008_pending_nudges.sql` first, so the gateway's reminders have a table to write to.
2. In Render → Environment:
   - `ENGINE_URL=https://engine.soro.charavol.com`
   - `ENGINE_FALLBACK_URL=` the Modal URL (the current `ENGINE_URL`)
   - `NUDGE_KEY=` the output of `openssl rand -base64 32`
3. Deploy the gateway. In its logs, an `engine failed, using the fallback` line means AWS didn't answer and Modal served the message.
4. Deploy the site (the privacy notice now lists AWS).

## Day to day

- **Update the engine:** `cd ~/soro && git pull && cd engine/aws && docker compose up -d --build engine`. Messages fall back to Modal while it restarts.
- **Pause it:** EC2 → Stop instance. The disk is kept and the gateway uses Modal in the meantime. Start it again whenever you like: the Elastic IP and the models stay where they are.
- **Leave AWS:** stop or terminate the instance, then set `ENGINE_URL` back to the Modal URL and clear `ENGINE_FALLBACK_URL` on Render.
