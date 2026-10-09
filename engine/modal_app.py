"""SoroEngine GPU engine on Modal (T4).

One-time:
  modal secret create soro-engine HF_TOKEN=hf_xxx ENGINE_TOKEN=<random 32+ chars>
  modal run modal_app.py::setup_models          # downloads + converts models into the "soro-models" volume
Deploy:
  modal deploy modal_app.py                      # prints https://<workspace>--soroengine-engine-web.modal.run
"""

from __future__ import annotations

import os

import modal

APP_NAME = "soroengine"
MODELS = "/models"

app = modal.App(APP_NAME)
volume = modal.Volume.from_name("soro-models", create_if_missing=True)
secret = modal.Secret.from_name("soro-engine")

image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.11")
    .apt_install("git", "ffmpeg", "build-essential", "cmake", "libportaudio2", "libsndfile1")
    .env({"CC": "gcc", "CXX": "g++"})  # the bundled Python defaults to clang, which isn't installed (pesq needs a compiler)
    # torch 2.6: transformers 5 won't load the NCAIR models' pytorch_model.bin on older torch. cu124 matches the CUDA
    # that llama.cpp is built against below, so both share one set of CUDA libraries.
    .pip_install("torch==2.6.0", "torchaudio==2.6.0", index_url="https://download.pytorch.org/whl/cu124")
    .pip_install(
        "transformers==5.14.1",  # OmniVoice needs >= 5.3; this is the release it shipped against
        "omnivoice==0.2.1",
        "accelerate",
        "fastapi[standard]",
        "huggingface_hub",
    )
    .run_commands(
        'CMAKE_ARGS="-DGGML_CUDA=on -DCMAKE_CUDA_ARCHITECTURES=75;89" pip install --no-cache-dir llama-cpp-python==0.3.36',
        gpu="T4",
    )
    .env(
        {
            "SORO_MODELS_DIR": MODELS,
            "HF_HOME": f"{MODELS}/hf",
        }
    )
    .add_local_python_source("soro_engine")
)


# gpu: llama_cpp is built with CUDA and won't even import (for quantizing) without the driver.
@app.function(image=image, gpu="T4", volumes={MODELS: volume}, secrets=[secret], cpu=4, memory=32768, timeout=3 * 3600)
def setup_models(allow_community_gguf: bool = False, redo_voices: bool = False):
    from soro_engine.setup_models import run

    run(allow_community_gguf=allow_community_gguf, redo_voices=redo_voices)
    volume.commit()


@app.cls(
    image=image,
    # T4 first; L4 when Modal has no T4 (on Oct 9 the container waited ~1 h, 07:55-08:52 WAT, for a T4).
    # llama.cpp above is built for both (CUDA archs 75 and 89).
    gpu=["T4", "L4"],
    volumes={MODELS: volume},
    secrets=[secret],
    scaledown_window=300,
    # Scale to zero: no GPU bill while idle. The first message after 5 quiet minutes waits for a cold start
    # (~45s, up to 1-2 min; the gateway allows 120s per call and sends its one-moment notice at 10s).
    # Before a demo, `modal run modal_app.py::warm --on` keeps one up (T4 ~$0.59/h) until the next deploy.
    min_containers=0,
    max_containers=1,  # 1,000-user licence cap + budget: one GPU is plenty for now
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


@app.local_entrypoint()
def warm(on: bool = True):
    """Manual override until the next deploy, e.g. one warm container for a demo: `modal run modal_app.py::warm --on`."""
    Engine().update_autoscaler(min_containers=1 if on else 0)
    print("warm" if on else "scale-to-zero")
