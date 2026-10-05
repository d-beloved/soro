"""Model IDs, paths and per-language settings. All models are gated on Hugging Face:
accept the terms on each model page with the account whose HF_TOKEN you use."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

Lang = Literal["en", "yo", "ha", "ig"]
LANGS: tuple[Lang, ...] = ("en", "yo", "ha", "ig")

# Local dev: engine/models. On Modal: the "soro-models" volume mounted at /models.
MODELS_DIR = Path(os.environ.get("SORO_MODELS_DIR", Path(__file__).resolve().parents[1] / "models"))

# --- ASR: NCAIR Whisper-small fine-tunes (16 kHz, 30 s windows). Pidgin goes through the English model.
ASR_MODELS: dict[Lang, str] = {
    "en": "NCAIR1/NigerianAccentedEnglish",
    "yo": "NCAIR1/Yoruba-ASR",
    "ha": "NCAIR1/Hausa-ASR",
    "ig": "NCAIR1/Igbo-ASR",
}

# --- LLM: N-ATLaS (Llama-3 8B), converted by us from the official weights to GGUF Q4_K_M.
LLM_REPO = "NCAIR1/N-ATLaS"
LLM_GGUF = MODELS_DIR / "n-atlas-q4_k_m.gguf"
# Community quant of the same weights; only used if our own conversion fails and you opt in.
LLM_COMMUNITY_GGUF = ("QuantFactory/N-ATLaS-GGUF", "N-ATLaS.Q4_K_M.gguf")
LLM_CTX = 4096
LLM_TEMPERATURE = 0.1  # model card recommendation
LLM_REPEAT_PENALTY = 1.12  # model card recommendation

# --- TTS: YarnGPT2 (Apache-2.0), 24 kHz output.
TTS_REPO = "saheedniyi/YarnGPT2"
YARNGPT_GIT = "https://github.com/saheedniyi02/yarngpt.git"
YARNGPT_COMMIT = "8bb0eb27d307f4b5903149e24ecc1bd3caa4af2d"
# Directory that CONTAINS the cloned "yarngpt" package directory.
YARNGPT_PARENT = Path(os.environ.get("YARNGPT_PARENT", Path(__file__).resolve().parents[1] / "vendor"))
WAV_CONFIG_REPO = "novateur/WavTokenizer-medium-speech-75token"
WAV_CONFIG = MODELS_DIR / "wavtokenizer_mediumdata_frame75_3s_nq1_code4096_dim512_kmeans200_attn.yaml"
WAV_CKPT = MODELS_DIR / "wavtokenizer_large_speech_320_24k.ckpt"
WAV_CKPT_GDRIVE_ID = "1-ASeEkrn4HY49yZWHTASgfGFNXdVnLTt"  # from the YarnGPT2 model card
TTS_SAMPLE_RATE = 24_000

TTS_LANG: dict[Lang, str] = {"en": "english", "yo": "yoruba", "ha": "hausa", "ig": "igbo"}
TTS_VOICE: dict[Lang, str] = {"en": "idera", "yo": "yoruba_female2", "ha": "hausa_female1", "ig": "igbo_female2"}

LANG_NAMES: dict[Lang, str] = {
    "en": "simple Nigerian English (Pidgin is fine)",
    "yo": "Yoruba",
    "ha": "Hausa",
    "ig": "Igbo",
}
