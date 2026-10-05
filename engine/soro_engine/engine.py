"""Loads the three model families once and exposes the operations the API serves."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from .audio import ASR_SAMPLE_RATE, decode_to_16k, encode_voice_note
from .config import LLM_GGUF, Lang

log = logging.getLogger("soro_engine")


def pick_device() -> str:
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


@dataclass
class Parts:
    asr: bool = True
    llm: bool = True
    tts: bool = True


class SoroEngine:
    def __init__(self, parts: Parts | None = None):
        self.parts = parts or Parts()
        self.asr = None
        self.llm = None
        self.tts = None

    def load(self) -> None:
        device = pick_device()
        t0 = time.time()
        if self.parts.llm:
            from .llm import LLM

            self.llm = LLM(LLM_GGUF)
            log.info("LLM loaded (%.1fs)", time.time() - t0)
        if self.parts.asr:
            from .asr import ASR

            self.asr = ASR(device)
            log.info("ASR loaded on %s (%.1fs)", device, time.time() - t0)
        if self.parts.tts:
            from .tts import TTS

            self.tts = TTS()
            log.info("TTS loaded (%.1fs)", time.time() - t0)

    def status(self) -> dict:
        return {"asr": self.asr is not None, "llm": self.llm is not None, "tts": self.tts is not None}

    # --- operations -------------------------------------------------------

    def transcribe(self, data: bytes, lang: Lang) -> dict:
        if self.asr is None:
            raise RuntimeError("ASR not loaded")
        audio = decode_to_16k(data)
        return {"text": self.asr.transcribe(audio, lang), "seconds": round(audio.size / ASR_SAMPLE_RATE, 2)}

    def route(self, text: str, lang: Lang, today: str) -> dict:
        if self.llm is None:
            raise RuntimeError("LLM not loaded")
        return self.llm.route(text, lang, today)

    def adapt(self, tip: str, question: str, lang: Lang) -> str:
        if self.llm is None:
            raise RuntimeError("LLM not loaded")
        return self.llm.adapt(tip, question, lang)

    def translate(self, text: str, target: Lang) -> str:
        if self.llm is None:
            raise RuntimeError("LLM not loaded")
        return self.llm.translate(text, target)

    def speak(self, text: str, lang: Lang) -> bytes:
        if self.tts is None:
            raise RuntimeError("TTS not loaded")
        samples = self.tts.speak(text, lang)
        return encode_voice_note(samples, self.tts.sample_rate)
