# Engine on AWS

One GPU server running the engine. It stops itself after 15 idle minutes and the gateway starts it again when a message comes in. If the gateway also has a fallback engine (`ENGINE_FALLBACK_URL`, for example the Modal deployment), that one answers while the server boots or when it fails.

```
gateway ──▶ https://engine.example.com  (EC2 g4dn.xlarge, T4: Caddy ─▶ engine container)
     │   └─▶ fallback engine, optional (while the server is asleep or booting, or when it errors or times out)
     └─ wakes the server (ec2:StartInstances) when it finds it asleep
```

Any region with g4dn instances works; the steps below use us-east-1. The server is an On-Demand instance: it runs only when started and stops only when it stops itself or you stop it.

## Before you start

In us-east-1, Service Quotas → Amazon EC2 → *Running On-Demand G and VT instances* must be at least **4** vCPUs (one g4dn.xlarge). New accounts start at 0, so request an increase. (Not the *Spot* quota: a Spot server can be taken back by AWS and then may not start again for hours.) Set a budget alert under Billing → Budgets.

## 1. Launch the server

EC2 → Launch instance, region **us-east-1**:

- **AMI:** *Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04)* (Browse more AMIs, then search `Deep Learning Base OSS`). It comes with the NVIDIA driver, Docker and the NVIDIA container toolkit already installed.
- **Type:** `g4dn.xlarge` (T4 16 GB, 4 vCPU, 16 GB RAM). If the models run out of RAM, use `g4dn.2xlarge`, which has 32 GB.
- **Storage:** 80 GB gp3 root volume (the AMI's own minimum is 75 GB). The engine image is about 26 GB and the models about 16 GB, once step 3 has deleted the AMI's CUDA toolkits.
- **Key pair:** create one and keep the `.pem`.
- **Security group:** SSH (22) from *My IP* only; HTTP (80) and HTTPS (443) from anywhere. Caddy needs 80 open to get its certificate.
- **Advanced details → Shutdown behavior:** **Stop** (the default). Never *Terminate*: that deletes the server and its models.
- **Advanced details → Allow tags in metadata:** **Enable**, for the `stay-awake` tag (step 5). On a running instance: Actions → Instance settings → Allow tags in instance metadata.
- **Advanced details → IAM instance profile:** `soro-engine-dns` (step 2). On a running instance: Actions → Security → Modify IAM role.

No Elastic IP: the server gets a new public address each time it starts, and updates its own DNS record (step 2). An Elastic IP is billed even while the server is stopped; the automatic address only while it runs.

## 2. DNS

The engine's name gets a Route 53 hosted zone of its own, so the server may change that one record and nothing else in the domain.

1. **Route 53 → Hosted zones → Create hosted zone:** `engine.example.com` (your engine's name), public. Note its four name servers (the NS record).
2. **In the parent domain's DNS** add four **NS** records named `engine`, one per name server. Remove any A record with that name first.
3. **IAM → Roles → Create role:** trusted entity *AWS service → EC2*, no managed policies, name `soro-engine-dns`. Then add this inline policy, with the hosted zone's ID:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "route53:ListHostedZonesByName", "Resource": "*" },
    {
      "Effect": "Allow",
      "Action": "route53:ChangeResourceRecordSets",
      "Resource": "arn:aws:route53:::hostedzone/<zone-id>",
      "Condition": {
        "ForAllValues:StringEquals": {
          "route53:ChangeResourceRecordSetsNormalizedRecordNames": ["engine.example.com"],
          "route53:ChangeResourceRecordSetsRecordTypes": ["A"]
        }
      }
    }
  ]
}
```

At every boot, [soro-dns.service](soro-dns.service) runs [update-dns.sh](update-dns.sh), which sets the zone's A record to the server's current address with a 60-second TTL (step 4). The record isn't proxied, so Caddy handles TLS itself (a proxy such as Cloudflare's would also cut off any request longer than 100 seconds).

## 3. Set up the box

```bash
ssh -i soro.pem ubuntu@<public-ip>                             # EC2 → the instance → Public IPv4 address
nvidia-smi                                                     # should show the T4
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi   # the GPU is visible from containers
sudo rm -rf /usr/local/cuda-*                                  # ~40 GB the engine doesn't use: its image brings its own CUDA
sudo jq '.features["containerd-snapshotter"] = false' /etc/docker/daemon.json > /tmp/daemon.json \
  && sudo mv /tmp/daemon.json /etc/docker/daemon.json && sudo systemctl restart docker   # store images once, not also compressed
git clone https://github.com/d-beloved/soro.git && cd soro/engine/aws
sudo mkdir -p /opt/soro/models && sudo chown ubuntu /opt/soro/models
```

### Models: copy them from Modal

If the engine is already deployed on Modal, this gives the server the same files, so the voices match:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh && source ~/.local/bin/env
uvx modal token new                                  # prints a link: open it on your laptop to approve
uvx modal run pack_models.py                         # packs the volume into one tar, on a "soro-transfer" volume
uvx modal volume get soro-transfer models.tar /opt/soro/models/models.tar
tar -xf /opt/soro/models/models.tar -C /opt/soro/models && rm /opt/soro/models/models.tar
uvx modal volume delete soro-transfer --yes
ls /opt/soro/models                                  # n-atlas-q4_k_m.gguf  hf/  voices/
```

Don't copy the volume with `modal volume get soro-models /` directly: it drops the symlinks inside the Hugging Face cache, and the speech models then fail to load.

### Or build them from scratch

Needs `HF_TOKEN` with the gated model terms accepted. The Yoruba voice is the model's own and the others come from fixed seeds, but the result can still differ slightly from a Modal deployment's. Converting N-ATLaS to GGUF needs about 32 GB of RAM, so this may need a `g4dn.2xlarge`.

```bash
docker compose build engine
docker compose run --rm -e HF_TOKEN=hf_xxx -e HF_HUB_OFFLINE=0 engine python -m soro_engine.setup_models
```

## 4. Start it

```bash
cp .env.example .env && nano .env      # ENGINE_TOKEN: the same value as in the gateway's settings (and the Modal secret, if you use one)
sudo cp soro-dns.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now soro-dns
journalctl -u soro-dns                  # "engine.example.com -> <public-ip>"
docker compose up -d --build            # the first build takes 20-30 min (llama.cpp compiles for CUDA)
docker builder prune -af                # the build cache is about as big as the image
docker compose logs -f engine           # wait for "Uvicorn running on http://0.0.0.0:8000"
curl https://engine.example.com/health
curl -s -X POST https://engine.example.com/route \
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

It shuts the server down (which stops it) once the engine has gone 15 minutes without a request from the gateway (`idle_s` in `/health`), or when the engine still isn't answering 30 minutes after boot, so a broken server doesn't run up a bill. It leaves the server on while anyone is logged in over SSH, and while the instance has a `stay-awake` tag (see Day to day). To change the 15 minutes, edit `IDLE_MINUTES` in `soro-idle.service` (at least 10), copy it again and run `sudo systemctl daemon-reload`. Its log: `journalctl -u soro-idle`.

## 6. Point the gateway at it

On Lambda ([gateway/aws/README.md](../../gateway/aws/README.md)), set these in the `/soro/gateway` parameter:

- `ENGINE_URL=https://engine.example.com`
- `ENGINE_FALLBACK_URL=` the fallback engine's URL, if you have one

and deploy with the instance id (`gateway/aws/deploy.sh i-…`). The worker's own role is allowed to start this one server and nothing else, so there is no access key to create.

If the gateway runs somewhere else, give it `ENGINE_AWS_INSTANCE_ID` too, and the key of an IAM user whose only permission is `ec2:StartInstances` on `arn:aws:ec2:us-east-1:<account-id>:instance/<instance-id>` (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`).

In the gateway's logs, `engine asleep, starting it and using the fallback` is a wake-up, and `engine failed, using the fallback` means the server was up but errored or timed out.

## Day to day

- **Update the engine:** `cd ~/soro && git pull && cd engine/aws && docker compose up -d --build engine && docker image prune -f && docker builder prune -af`, while logged in over SSH so the server doesn't stop itself mid-build. Messages go to the fallback engine, if there is one, while it restarts. If `soro-idle.service` changed, copy it again and run `sudo systemctl daemon-reload`.
- **Keep it up:** EC2 → the instance → Tags → Manage tags → add `stay-awake` with `on`, or a date (`2026-12-31`) to stay up through that day (UTC). Remove the tag, or let the date pass, and it sleeps after 15 idle minutes again. If it is asleep when you add the tag, start it (Instance state → Start) or send a message.
- **Keep it off:** in the `/soro/gateway` parameter, set `ENGINE_URL` to another engine (such as the Modal URL) and remove `ENGINE_FALLBACK_URL` (without a fallback the gateway never starts the server), wait 5 minutes for the gateway to pick it up, then stop the instance.
