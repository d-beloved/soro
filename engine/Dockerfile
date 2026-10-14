# SoroEngine GPU engine for a plain GPU server (AWS g4dn, see aws/README.md). Same stack and pins as the Modal
# image in modal_app.py. Build it on the GPU server itself: the image is x86-64 and CUDA-only.
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ffmpeg build-essential cmake libportaudio2 libsndfile1 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Python 3.11 from uv: Ubuntu 22.04 ships 3.10. gcc, not the clang that standalone Pythons default to (pesq builds C).
COPY --from=ghcr.io/astral-sh/uv:0.8.22 /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_LINK_MODE=copy UV_NO_CACHE=1 VIRTUAL_ENV=/opt/venv PATH=/opt/venv/bin:$PATH CC=gcc CXX=g++
RUN uv venv --python 3.11 /opt/venv

# torch 2.6 on cu124, matching the CUDA llama.cpp is built against below.
RUN uv pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
RUN uv pip install transformers==5.14.1 omnivoice==0.2.1 accelerate "fastapi[standard]" huggingface_hub
# T4 (75) on g4dn; A10G (86) and L4 (89) in case we move up to g5 or g6. No GPU needed to build, only to import.
RUN CMAKE_ARGS="-DGGML_CUDA=on -DCMAKE_CUDA_ARCHITECTURES=75;86;89" uv pip install llama-cpp-python==0.3.36

# Models live on the host disk, mounted at /models (same layout as Modal's "soro-models" volume).
ENV SORO_MODELS_DIR=/models HF_HOME=/models/hf HF_HUB_OFFLINE=1
WORKDIR /app
COPY soro_engine ./soro_engine
COPY serve_local.py ./

EXPOSE 8000
CMD ["python", "serve_local.py", "--host", "0.0.0.0", "--port", "8000"]
