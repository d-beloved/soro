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
    LANGS,
    LLM_COMMUNITY_GGUF,
    LLM_GGUF,
    LLM_REPO,
    MODELS_DIR,
    TTS_AUDIO_TOKENIZER,
    TTS_FILES,
    TTS_INSTRUCT,
    TTS_REPOS,
    TTS_SEED,
    TTS_VOICE_TEXT,
    VOICES_DIR,
)

LLAMA_CPP_GIT = "https://github.com/ggml-org/llama.cpp.git"


def sh(*cmd: str, cwd: Path | None = None) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, cwd=cwd)


def download_hf_models() -> None:
    from huggingface_hub import snapshot_download

    for repo in ASR_MODELS.values():
        print(f"downloading {repo}", flush=True)
        # The NCAIR ASR repos only ship pytorch_model.bin (plus optimizer/rng checkpoints we skip).
        snapshot_download(
            repo, allow_patterns=["*.json", "*.safetensors", "pytorch_model.bin", "*.txt", "*.model", "*.py"]
        )
    for repo, revision in dict.fromkeys(TTS_REPOS.values()):
        print(f"downloading {repo}@{revision[:7]}", flush=True)
        snapshot_download(repo, revision=revision, allow_patterns=TTS_FILES)
    snapshot_download(TTS_AUDIO_TOKENIZER)


def make_voices(redo: bool = False) -> None:
    """Designs each language's voice once and saves it, so every reply is in the same voice. Needs a GPU."""
    import torch
    from omnivoice import OmniVoice

    from .engine import pick_device
    from .tts import load_models, voice_path

    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    for lang in LANGS:
        if TTS_SEED[lang] is None:  # no saved voice for this language: drop any left from before
            voice_path(lang).unlink(missing_ok=True)
            (VOICES_DIR / f"{lang}.wav").unlink(missing_ok=True)
    todo = [lang for lang in LANGS if TTS_SEED[lang] is not None and (redo or not voice_path(lang).exists())]
    if not todo:
        return
    models = load_models(pick_device())
    for lang in todo:
        model: OmniVoice = models[lang]
        torch.manual_seed(TTS_SEED[lang])
        audio = model.generate(text=TTS_VOICE_TEXT[lang], language=lang, instruct=TTS_INSTRUCT[lang])[0]
        prompt = model.create_voice_clone_prompt(
            (torch.from_numpy(audio).float(), model.sampling_rate), ref_text=TTS_VOICE_TEXT[lang]
        )
        prompt.save(str(voice_path(lang)))
        _save_wav(VOICES_DIR / f"{lang}.wav", audio, model.sampling_rate)  # to listen to
        print(f"voice {lang}: seed {TTS_SEED[lang]}, {audio.size / model.sampling_rate:.1f}s", flush=True)


def _save_wav(path: Path, audio, rate: int) -> None:
    import wave

    import numpy as np

    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


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


def run(allow_community_gguf: bool = False, skip_llm: bool = False, redo_voices: bool = False) -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    download_hf_models()
    make_voices(redo=redo_voices)
    if not skip_llm:
        build_gguf(allow_community_gguf)
    print("models ready in", MODELS_DIR, flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--allow-community-gguf", action="store_true")
    p.add_argument("--skip-llm", action="store_true", help="ASR/TTS only (e.g. copy the GGUF from Modal instead)")
    p.add_argument("--redo-voices", action="store_true", help="design the TTS voices again (after changing TTS_SEED)")
    a = p.parse_args()
    run(a.allow_community_gguf, a.skip_llm, a.redo_voices)
