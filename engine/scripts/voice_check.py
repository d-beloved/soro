"""Voice check: builds the engine image and runs it end to end on Modal, without deploying anything.

  cd engine
  uv run --no-project --with modal --with jiwer --with numpy modal run scripts/voice_check.py
  open listen/amounts/index.html     # Chrome or Firefox: the clips are OGG/OPUS, like WhatsApp voice notes

Loads the LLM first (as in production, so the CUDA libraries load in the same order), then ASR, then OmniVoice.
Designs the four voices afresh from config.TTS_SEED (try a seed here before setting it live), then voices
amount-heavy replies in every language and transcribes each one back with our ASR, to check the amounts are heard
right. Writes only to a separate "soro-tts-test" volume; the live "soro-models" volume is mounted read-only.
"""

import html
import json
import re
import sys
import unicodedata
from pathlib import Path

import modal

ENGINE = Path(__file__).resolve().parents[1] if modal.is_local() else Path("/root")  # in the container: /root
sys.path.insert(0, str(ENGINE))
from modal_app import image  # noqa: E402

image = image.add_local_python_source("modal_app")  # the container imports this file too

app = modal.App("soroengine-voice-check")
test_vol = modal.Volume.from_name("soro-tts-test", create_if_missing=True)
prod_vol = modal.Volume.from_name("soro-models").read_only()
secret = modal.Secret.from_name("soro-engine")


@app.function(image=image, gpu="T4", volumes={"/models": test_vol, "/prod": prod_vol}, secrets=[secret],
              cpu=4, memory=32768, timeout=3600)
def verify(items: list[dict]) -> dict:
    import logging
    import time

    import llama_cpp
    import omnivoice
    import torch
    import transformers

    logging.basicConfig(level=logging.INFO)
    from soro_engine.setup_models import download_hf_models, make_voices

    download_hf_models()
    make_voices(redo=True)
    test_vol.commit()

    from soro_engine.asr import ASR
    from soro_engine.audio import decode_to_16k, encode_voice_note
    from soro_engine.llm import LLM
    from soro_engine.tts import TTS

    t0 = time.time()
    llm = LLM(Path("/prod/n-atlas-q4_k_m.gguf"))
    asr = ASR("cuda")
    tts = TTS("cuda")
    loaded = time.time() - t0
    route = llm.route("I sell 3 bags of rice for 125k", "en", "2026-10-09")

    clips = []
    for it in items:
        t = time.time()
        ogg = encode_voice_note(tts.speak(it["text"], it["lang"]), tts.sample_rate)
        secs = time.time() - t
        heard, _ = asr.transcribe(decode_to_16k(ogg), it["lang"])
        clips.append({**it, "seconds": round(secs, 2), "ogg": ogg, "heard": heard})
    # language detection still works on the new transformers
    detected = asr.transcribe(decode_to_16k(clips[0]["ogg"]), "yo", detect=True)[1]
    return {
        # str(): torch's version is a torch type, which can't be unpickled on a laptop without torch
        "versions": {"torch": str(torch.__version__), "cuda": str(torch.version.cuda),
                     "transformers": transformers.__version__, "omnivoice": omnivoice.__version__,
                     "llama_cpp": llama_cpp.__version__},
        "gpu_mem_gb": round(torch.cuda.max_memory_allocated() / 1e9, 2),
        "load_seconds": round(loaded, 1),
        "route": json.loads(json.dumps(route, default=str)),
        "detect_en_as": detected,
        "clips": clips,
        "voices": {lang: p.read_bytes() for lang in ("en", "yo", "ha", "ig") if (p := Path(f"/models/voices/{lang}.wav")).exists()},
    }


class Blank(dict):
    def __missing__(self, key):
        return ""


def items() -> list[dict]:
    loc = ENGINE.parent / "gateway" / "src" / "locales"
    out = []
    for lang in ("en", "yo", "ha", "ig"):
        s = json.loads((loc / f"{lang}.json").read_text())
        fill = lambda key, **v: s[key].format_map(Blank(v)).split("\n")[0]  # noqa: E731
        for n, (text, amount) in enumerate([
            (fill("sale_logged", what="", amount="₦125,000"), 125_000),
            (fill("debt_owed_to_me_logged", who="Emeka", amount="₦12,500"), 12_500),
            (fill("sale_logged", what="", amount="₦75,000"), 75_000),
            (fill("summary_spoken_title", period=s["period_today"]) + " "
             + fill("summary_spoken_business", sales="₦1,350,000", costs="₦42,000"), 1_350_000),
        ], 1):
            out.append({"lang": lang, "n": n, "text": text, "amount": amount})
    return out


def norm(s: str) -> str:
    s = unicodedata.normalize("NFC", s.lower())
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s']", " ", s)).strip()


@app.local_entrypoint()
def main():
    import jiwer

    from soro_engine.amounts import extract_amount_ngn
    from soro_engine.text import clean_for_speech

    res = verify.remote(items())
    out = ENGINE / "listen" / "amounts"
    out.mkdir(parents=True, exist_ok=True)
    print(json.dumps({k: res[k] for k in ("versions", "gpu_mem_gb", "load_seconds", "route", "detect_en_as")}, indent=1))
    rows = []
    for lang, wav in res["voices"].items():
        (out / f"voice_{lang}.wav").write_bytes(wav)
    for c in res["clips"]:
        name = f"{c['lang']}_{c['n']}.ogg"
        (out / name).write_bytes(c["ogg"])
        spoken = clean_for_speech(c["text"], c["lang"])
        wer = jiwer.wer(norm(spoken), norm(c["heard"]) or "<empty>")
        got = extract_amount_ngn(c["heard"])
        print(f"{c['lang']} {c['n']} {c['seconds']:5.2f}s WER {wer:4.0%} amount heard {got} (said {c['amount']})\n"
              f"   said: {spoken}\n  heard: {c['heard']}")
        rows.append(f"<tr><td>{c['lang']}</td><td>{html.escape(c['text'])}<br><small>{html.escape(spoken)}</small></td>"
                    f"<td><audio controls preload=none src='{name}'></audio></td><td>{html.escape(c['heard'])}</td>"
                    f"<td>{wer:.0%}</td><td>{got or ''}</td></tr>")
    voices = "".join(f"<p>{l} voice <audio controls preload=none src='voice_{l}.wav'></audio></p>" for l in res["voices"])
    (out / "index.html").write_text(
        "<!doctype html><meta charset=utf-8><title>Amounts check</title>"
        "<style>body{font:15px system-ui;margin:24px}td{border-top:1px solid #ddd;padding:6px;vertical-align:top}"
        "small{color:#666}</style><h1>OmniVoice amounts check</h1>" + voices +
        "<table><tr><th>lang</th><th>text / spoken</th><th>clip</th><th>ASR heard</th><th>WER</th><th>amount parsed</th></tr>"
        + "".join(rows) + "</table>")
    print("wrote", out / "index.html")
