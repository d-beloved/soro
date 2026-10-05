"""Downloads every model into MODELS_DIR / the HF cache and builds the N-ATLaS GGUF.

Runs on Modal (`modal run modal_app.py::setup_models`, recommended: fast network, no 16 GB download to your laptop)
or locally (`uv run python -m soro_engine.setup_models`). Needs HF_TOKEN with the gated model terms accepted.
"""

from __future__ import annotations

import argparse
import ctypes
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from .config import (
    ASR_MODELS,
    LLM_COMMUNITY_GGUF,
    LLM_GGUF,
    LLM_REPO,
    MODELS_DIR,
    TTS_REPO,
    WAV_CKPT,
    WAV_CKPT_GDRIVE_ID,
    WAV_CONFIG,
    WAV_CONFIG_REPO,
    YARNGPT_COMMIT,
    YARNGPT_GIT,
    YARNGPT_PARENT,
)

LLAMA_CPP_GIT = "https://github.com/ggml-org/llama.cpp.git"


def sh(*cmd: str, cwd: Path | None = None) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, cwd=cwd)


def ensure_yarngpt() -> None:
    target = YARNGPT_PARENT / "yarngpt"
    if (target / "audiotokenizer.py").exists():
        return
    YARNGPT_PARENT.mkdir(parents=True, exist_ok=True)
    sh("git", "clone", "-q", YARNGPT_GIT, str(target))
    sh("git", "checkout", "-q", YARNGPT_COMMIT, cwd=target)


def download_hf_models() -> None:
    from huggingface_hub import hf_hub_download, snapshot_download

    for repo in [*ASR_MODELS.values(), TTS_REPO]:
        print(f"downloading {repo}", flush=True)
        # The NCAIR ASR repos only ship pytorch_model.bin (plus optimizer/rng checkpoints we skip).
        snapshot_download(
            repo, allow_patterns=["*.json", "*.safetensors", "pytorch_model.bin", "*.txt", "*.model", "*.py"]
        )

    if not WAV_CONFIG.exists():
        src = hf_hub_download(WAV_CONFIG_REPO, WAV_CONFIG.name)
        shutil.copy(src, WAV_CONFIG)

    if not WAV_CKPT.exists():
        import gdown

        # The YarnGPT2 model card ships this checkpoint via Google Drive.
        gdown.download(id=WAV_CKPT_GDRIVE_ID, output=str(WAV_CKPT), quiet=False)
        if not WAV_CKPT.exists() or WAV_CKPT.stat().st_size < 10_000_000:
            raise RuntimeError("WavTokenizer checkpoint download failed (Google Drive quota?). Retry later.")


def build_gguf(allow_community: bool) -> None:
    if LLM_GGUF.exists():
        print(f"{LLM_GGUF} already present", flush=True)
        return
    try:
        convert_official_weights()
    except Exception as e:  # noqa: BLE001
        if not allow_community:
            raise RuntimeError(
                f"GGUF conversion failed: {e}\nRe-run with --allow-community-gguf to use {LLM_COMMUNITY_GGUF[0]} instead."
            ) from e
        from huggingface_hub import hf_hub_download

        print(f"conversion failed ({e}); using community quant {LLM_COMMUNITY_GGUF}", flush=True)
        src = hf_hub_download(*LLM_COMMUNITY_GGUF)
        shutil.copy(src, LLM_GGUF)


def convert_official_weights() -> None:
    """NCAIR1/N-ATLaS safetensors -> f16 GGUF (llama.cpp converter) -> Q4_K_M (llama.cpp quantizer)."""
    import llama_cpp
    from huggingface_hub import snapshot_download

    with tempfile.TemporaryDirectory(dir=_scratch_dir()) as tmp:
        tmp_path = Path(tmp)
        hf_dir = tmp_path / "n-atlas"
        snapshot_download(LLM_REPO, local_dir=hf_dir)

        llama_cpp_dir = tmp_path / "llama.cpp"
        sh("git", "clone", "-q", "--depth", "1", LLAMA_CPP_GIT, str(llama_cpp_dir))
        sh(sys.executable, "-m", "pip", "install", "-q", str(llama_cpp_dir / "gguf-py"), "sentencepiece", "protobuf")

        f16 = tmp_path / "n-atlas-f16.gguf"
        sh(sys.executable, str(llama_cpp_dir / "convert_hf_to_gguf.py"), str(hf_dir), "--outtype", "f16", "--outfile", str(f16))

        params = llama_cpp.llama_model_quantize_default_params()
        params.ftype = llama_cpp.LLAMA_FTYPE_MOSTLY_Q4_K_M
        out_tmp = tmp_path / LLM_GGUF.name
        rc = llama_cpp.llama_model_quantize(str(f16).encode(), str(out_tmp).encode(), ctypes.byref(params))
        if rc != 0:
            raise RuntimeError(f"llama_model_quantize returned {rc}")
        shutil.copy(out_tmp, LLM_GGUF)
        print(f"wrote {LLM_GGUF} ({LLM_GGUF.stat().st_size / 1e9:.2f} GB)", flush=True)


def _scratch_dir() -> str | None:
    # On Modal use the container's local disk, not the volume, for the ~32 GB of intermediates.
    return "/tmp" if Path("/tmp").exists() else None


def run(allow_community_gguf: bool = False, skip_llm: bool = False) -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    ensure_yarngpt()
    download_hf_models()
    if not skip_llm:
        build_gguf(allow_community_gguf)
    print("models ready in", MODELS_DIR, flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--allow-community-gguf", action="store_true")
    p.add_argument("--skip-llm", action="store_true", help="ASR/TTS only (e.g. copy the GGUF from Modal instead)")
    a = p.parse_args()
    run(a.allow_community_gguf, a.skip_llm)
