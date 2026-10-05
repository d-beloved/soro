"""NCAIR Whisper-small ASR models, one per language, all kept in GPU memory (~0.5 GB each in fp16)."""

from __future__ import annotations

import threading

import numpy as np

from .audio import ASR_SAMPLE_RATE
from .config import ASR_MODELS, Lang


class ASR:
    def __init__(self, device: str, langs: tuple[Lang, ...] = tuple(ASR_MODELS)):
        import torch
        from transformers import pipeline

        dtype = torch.float16 if device in ("cuda", "mps") else torch.float32
        self._pipes = {
            lang: pipeline("automatic-speech-recognition", model=ASR_MODELS[lang], device=device, torch_dtype=dtype)
            for lang in langs
        }
        self._locks = {lang: threading.Lock() for lang in langs}

    def transcribe(self, audio: np.ndarray, lang: Lang) -> str:
        if audio.size < ASR_SAMPLE_RATE * 0.3:  # under 0.3 s: Whisper only hallucinates on this
            return ""
        pipe = self._pipes.get(lang) or self._pipes["en"]
        with self._locks.get(lang, self._locks["en"]):
            out = pipe({"raw": audio, "sampling_rate": ASR_SAMPLE_RATE}, chunk_length_s=30, batch_size=4)
        return str(out["text"]).strip()
