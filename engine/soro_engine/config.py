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

# --- TTS: OmniVoice (Apache-2.0), 24 kHz output. The base model for English, Hausa and Igbo; a Yoruba fine-tune of
# it for Yoruba, whose tones the base model flattens. Round-trip WER in the Oct 2026 listening test (spoken, then
# transcribed by our ASR): en 23%, ha 45%, ig 45%, yo 35%, against YarnGPT2's 56/78/59/82%.
TTS_BASE = ("k2-fsa/OmniVoice", "c5fdb5ccb189668d56333f77ba2629f4cd7535f4")
TTS_YORUBA = ("Sam4rano/omnivoice-yoruba-tts", "921de7d7364c308c83eb3a857370d288deb68427")
TTS_REPOS: dict[Lang, tuple[str, str]] = {"en": TTS_BASE, "yo": TTS_YORUBA, "ha": TTS_BASE, "ig": TTS_BASE}
# Only the model at the repo root: the Yoruba repo also holds training checkpoints and optimizer states.
TTS_FILES = ["config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json", "chat_template.jinja",
             "audio_tokenizer/*"]
# The audio codec, for checkpoints that don't ship it (the Yoruba fine-tune).
TTS_AUDIO_TOKENIZER = "eustlb/higgs-audio-v2-tokenizer"
TTS_SAMPLE_RATE = 24_000

# One fixed voice per language. Without a reference, OmniVoice draws a new speaker on every call, so setup_models
# designs a voice once (TTS_INSTRUCT + the seed), records it saying TTS_VOICE_TEXT, and every reply clones that.
# To change a voice: try seeds with scripts/voice_check.py, then run setup_models with --redo-voices.
# Seed None: no saved voice, the model's own voice on every reply. For Yoruba: the fine-tune sounded clearly better
# that way (as in the listening test) than cloning any designed voice (Oct 2026).
VOICES_DIR = MODELS_DIR / "voices"
# A voice description, or None for OmniVoice's own pick. Describing the voice breaks Hausa: every seed came out as
# noise the Hausa ASR couldn't follow, while its own pick was understood word for word (Oct 2026).
_FEMALE = "female, young adult, moderate pitch"
TTS_INSTRUCT: dict[Lang, str | None] = {"en": _FEMALE, "yo": None, "ha": None, "ig": None}
# Picked by ASR round trip of amount replies (scripts/voice_check.py), Oct 2026.
TTS_SEED: dict[Lang, int | None] = {"en": 1, "yo": None, "ha": 2, "ig": 1}
# No digits: OmniVoice paces replies on this text's length, and digits throw that off.
TTS_VOICE_TEXT: dict[Lang, str] = {
    "en": "Good morning. I am your money helper. Tell me what you sold today, and I will keep the record for you.",
    "yo": "Ẹ káàárọ̀. Èmi ni olùrànlọ́wọ́ owó yín. Ẹ sọ ohun tí ẹ tà lónìí fún mi, màá sì kọ ọ́ sílẹ̀ fún yín.",
    "ha": "Barka da safiya. Ni ce mai taimaka maka a harkar kuɗi. Faɗa mini abin da ka sayar yau, zan rubuta maka.",
    "ig": "Ụtụtụ ọma. Abụ m onye na-enyere gị aka n'ihe gbasara ego. Gwa m ihe i rere taa, m ga-edere gị ya.",
}

LANG_NAMES: dict[Lang, str] = {
    "en": "simple Nigerian English (Pidgin is fine)",
    "yo": "Yoruba",
    "ha": "Hausa",
    "ig": "Igbo",
}
