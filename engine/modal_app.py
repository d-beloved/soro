"""SoroEngine GPU engine on Modal (T4).

One-time:
  modal secret create soro-engine HF_TOKEN=hf_xxx ENGINE_TOKEN=<random 32+ chars>
  modal run modal_app.py::setup_models          # downloads + converts models into the "soro-models" volume
Deploy:
  modal deploy modal_app.py                      # prints https://<workspace>--soroengine-engine-web.modal.run
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import modal

APP_NAME = "soroengine"
MODELS = "/models"

# Warm window for the pilot: one container kept up 09:00-21:00 WAT on these dates only
# (T4 ~$0.59/h -> ~$7/day). Outside the window the engine scales to zero and cold-starts on demand.
WARM_FROM = "2026-10-07"
WARM_TO = "2026-10-11"

app = modal.App(APP_NAME)
volume = modal.Volume.from_name("soro-models", create_if_missing=True)
secret = modal.Secret.from_name("soro-engine")
light = modal.Image.debian_slim(python_version="3.11")  # for the cron toggles

image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.11")
    .apt_install("git", "ffmpeg", "build-essential", "cmake", "libportaudio2", "libsndfile1")
    .env({"CC": "gcc", "CXX": "g++"})  # the bundled Python defaults to clang, which isn't installed (pesq needs a compiler)
    .pip_install("torch==2.5.1", "torchaudio==2.5.1", index_url="https://download.pytorch.org/whl/cu124")
    .pip_install(
        "transformers==4.47.1",  # pinned by YarnGPT
        "outetts==0.2.3",  # pinned by YarnGPT
        "uroman",
        "inflect",
        "accelerate",
        "fastapi[standard]",
        "huggingface_hub[hf_transfer]",
        "gdown",
    )
    .run_commands(
        'CMAKE_ARGS="-DGGML_CUDA=on -DCMAKE_CUDA_ARCHITECTURES=75;89" pip install --no-cache-dir llama-cpp-python==0.3.36',
        gpu="T4",
    )
    .env(
        {
            "SORO_MODELS_DIR": MODELS,
            "HF_HOME": f"{MODELS}/hf",
            "YARNGPT_PARENT": f"{MODELS}/vendor",
        }
    )
    .add_local_python_source("soro_engine")
)


# gpu: llama_cpp is built with CUDA and won't even import (for quantizing) without the driver.
@app.function(image=image, gpu="T4", volumes={MODELS: volume}, secrets=[secret], cpu=4, memory=32768, timeout=3 * 3600)
def setup_models(allow_community_gguf: bool = False):
    from soro_engine.setup_models import run

    run(allow_community_gguf=allow_community_gguf)
    volume.commit()


@app.cls(
    image=image,
    gpu="T4",
    volumes={MODELS: volume},
    secrets=[secret],
    scaledown_window=300,  # stay warm 5 min after the last message
    min_containers=0,
    max_containers=1,  # 1,000-user licence cap + budget: one GPU is plenty for the pilot
    timeout=600,
)
@modal.concurrent(max_inputs=8)
class Engine:
    @modal.enter()
    def load(self):
        import logging

        logging.basicConfig(level=logging.INFO)
        os.environ["HF_HUB_OFFLINE"] = "1"  # everything is already on the volume
        from soro_engine.engine import SoroEngine

        self.engine = SoroEngine()
        self.engine.load()

    @modal.asgi_app()
    def web(self):
        from soro_engine.api import create_api

        return create_api(self.engine, os.environ["ENGINE_TOKEN"])


def _in_warm_window() -> bool:
    today = (datetime.now(timezone.utc) + timedelta(hours=1)).date().isoformat()  # WAT
    return WARM_FROM <= today <= WARM_TO


@app.function(image=light, schedule=modal.Cron("0 9 * * *", timezone="Africa/Lagos"))
def warm_up():
    if _in_warm_window():
        Engine().update_autoscaler(min_containers=1)


@app.function(image=light, schedule=modal.Cron("0 21 * * *", timezone="Africa/Lagos"))
def cool_down():
    Engine().update_autoscaler(min_containers=0)


@app.local_entrypoint()
def warm(on: bool = True):
    """Manual override, e.g. before a demo: `modal run modal_app.py::warm --on` / `--no-on`."""
    Engine().update_autoscaler(min_containers=1 if on else 0)
    print("warm" if on else "scale-to-zero")
