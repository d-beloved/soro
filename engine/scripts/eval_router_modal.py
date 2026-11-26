"""Runs scripts/eval_router.py for every LLM profile on a Modal T4, with the engine's own image, without deploying
anything. N-ATLaS comes from the "soro-models" volume (mounted read-only); the other GGUFs are downloaded into the
container.

  cd engine
  uv run --no-project --with modal modal run scripts/eval_router_modal.py       # writes eval/router-<profile>.json
"""

import json
import sys
from dataclasses import replace
from pathlib import Path

import modal

ENGINE = Path(__file__).resolve().parents[1] if modal.is_local() else Path("/root")
sys.path.insert(0, str(ENGINE))
sys.path.insert(0, str(ENGINE / "scripts"))
from modal_app import image  # noqa: E402

image = image.add_local_python_source("modal_app", "eval_router")

app = modal.App("soroengine-router-eval")
prod_vol = modal.Volume.from_name("soro-models").read_only()

# Profiles whose GGUF isn't on the volume: (Hugging Face repo, file, commit).
DOWNLOADS = {"qwen3-8b": ("Qwen/Qwen3-8B-GGUF", "Qwen3-8B-Q4_K_M.gguf", "7c41481f57cb95916b40956ab2f0b139b296d974")}


@app.function(image=image, gpu="T4", volumes={"/models": prod_vol}, cpu=4, memory=32768, timeout=3600)
def evaluate(profile: str, limit: int | None = None) -> dict:
    import gc

    from huggingface_hub import hf_hub_download

    import eval_router
    from soro_engine.config import LLM_PROFILES
    from soro_engine.llm import LLM, LlamaCppChat

    p = LLM_PROFILES[profile]
    if profile in DOWNLOADS:
        repo, name, rev = DOWNLOADS[profile]
        p = replace(p, gguf=Path(hf_hub_download(repo, name, revision=rev, cache_dir="/tmp/hf")))
    llm = LLM(LlamaCppChat(p))
    rows = eval_router.run(llm)
    del llm
    gc.collect()
    return {"profile": profile, "rows": rows}


@app.local_entrypoint()
def main(profiles: str = "n-atlas,qwen3-8b", limit: int = 0):
    import eval_router

    out = ENGINE / "eval"
    out.mkdir(exist_ok=True)
    for res in evaluate.map(profiles.split(","), kwargs={"limit": limit or None}):
        (out / f"router-{res['profile']}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
        print("\n" + eval_router.report(res["profile"], res["rows"]))
