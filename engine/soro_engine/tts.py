"""OmniVoice text-to-speech: the Yoruba fine-tune in its own voice, base OmniVoice with a fixed voice for the rest."""

from __future__ import annotations

import logging
import threading

import numpy as np

from .config import (
    LANGS,
    TTS_INSTRUCT,
    TTS_REPOS,
    TTS_SAMPLE_RATE,
    TTS_SEED,
    VOICES_DIR,
    Lang,
)
from .text import clean_for_speech

log = logging.getLogger("soro_engine")


def model_dir(repo: str, revision: str) -> str:
    """The local snapshot setup_models downloaded (no network once HF_HUB_OFFLINE is set)."""
    from huggingface_hub import snapshot_download

    from .config import TTS_FILES

    return snapshot_download(repo, revision=revision, allow_patterns=TTS_FILES)


def load_models(device: str) -> dict[Lang, object]:
    import torch
    from omnivoice import OmniVoice

    dtype = torch.float16 if device == "cuda" else torch.float32  # the T4 has no bfloat16
    loaded: dict[tuple[str, str], object] = {}
    for key in dict.fromkeys(TTS_REPOS.values()):
        loaded[key] = OmniVoice.from_pretrained(model_dir(*key), device_map=device, dtype=dtype)
    return {lang: loaded[TTS_REPOS[lang]] for lang in LANGS}


def voice_path(lang: Lang):
    return VOICES_DIR / f"{lang}.pt"


class TTS:
    def __init__(self, device: str):
        import torch
        from omnivoice import VoiceClonePrompt

        self._torch = torch
        self._models = load_models(device)
        self._voices = {}
        for lang in LANGS:
            if TTS_SEED[lang] is None:  # the model's own voice on every reply
                continue
            if voice_path(lang).exists():
                self._voices[lang] = VoiceClonePrompt.load(str(voice_path(lang)))
            else:  # a designed voice still works, but it changes from reply to reply
                log.warning("no saved %s voice at %s: run setup_models", lang, voice_path(lang))
        self._lock = threading.Lock()  # one GPU, and generate() is not documented as thread-safe

    def speak(self, text: str, lang: Lang) -> np.ndarray:
        spoken = clean_for_speech(text, lang)
        if not spoken:
            raise ValueError("nothing speakable in text")
        voice = self._voices.get(lang)
        with self._lock, self._torch.inference_mode():
            # Long replies are chunked by OmniVoice itself (about 15 s per chunk), all in the same voice.
            audio = self._models[lang].generate(
                text=spoken,
                language=lang,
                voice_clone_prompt=voice,
                instruct=None if voice else TTS_INSTRUCT[lang],
            )[0]
        return np.asarray(audio, dtype=np.float32)

    sample_rate = TTS_SAMPLE_RATE
