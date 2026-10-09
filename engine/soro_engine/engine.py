"""Loads the three model families once and exposes the operations the API serves."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from .amounts import extract_amount_ngn
from .audio import ASR_SAMPLE_RATE, decode_to_16k, encode_voice_note
from .config import LLM_GGUF, Lang
from .text import naira_sign

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

            self.tts = TTS(device)
            log.info("TTS loaded on %s (%.1fs)", device, time.time() - t0)

    def status(self) -> dict:
        return {"asr": self.asr is not None, "llm": self.llm is not None, "tts": self.tts is not None}

    # --- operations -------------------------------------------------------

    def transcribe(self, data: bytes, lang: Lang, detect: bool = False) -> dict:
        """`lang` is the user's chosen language. With `detect`, a voice note in another of the four is heard by
        that language's model instead, and "lang" in the result says which one.

        People often say amounts in English inside a Yoruba, Hausa or Igbo sentence, and those models can't write
        English number words ("thirteen thousand" comes out as "tàtíńtà-ọ̀sán"). So when such a transcript has no
        amount in it, the English model listens too, and "en_text" carries its version if that one has an amount.
        """
        if self.asr is None:
            raise RuntimeError("ASR not loaded")
        audio = decode_to_16k(data)
        text, heard = self.asr.transcribe(audio, lang, detect=detect)
        text = naira_sign(text)
        out = {"text": text, "lang": heard, "seconds": round(audio.size / ASR_SAMPLE_RATE, 2)}
        if text and heard != "en" and extract_amount_ngn(text) is None:
            en_text = naira_sign(self.asr.transcribe(audio, "en")[0])
            if extract_amount_ngn(en_text) is not None:
                log.info("asr: amount heard only by the English model: %r", en_text)
                out["en_text"] = en_text
        return out

    def route(self, text: str, lang: Lang, today: str, en_text: str | None = None) -> dict:
        if self.llm is None:
            raise RuntimeError("LLM not loaded")
        return self.llm.route(text, lang, today, en_text)

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
