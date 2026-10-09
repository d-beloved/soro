"""NCAIR Whisper-small ASR models, one per language, all kept in GPU memory (~0.5 GB each in fp16).

Spoken-language detection uses the same four models: a voice note in the user's own language is heard by its
model with confidence, so that is the fast path. When that model is unsure, the other three listen too and the
most confident one wins. Whisper's base language-ID can't do this: it has no Igbo.
"""

from __future__ import annotations

import logging
import threading
import zlib
from dataclasses import dataclass

import numpy as np

from .audio import ASR_SAMPLE_RATE
from .config import ASR_MODELS, Lang

log = logging.getLogger("soro_engine")

# Mean log-probability per token at or above which the user's own model is trusted without asking the others.
CONFIDENT = -0.35
# Another language must beat the user's own model by this much: speakers mix languages, and switching the reply
# language on a near tie would be worse than the occasional miss.
SWITCH_MARGIN = 0.25
# Whisper's sign of looping on audio it can't make sense of ("ra ra ra ra ...").
MAX_COMPRESSION = 2.4
WINDOW_S = 30


@dataclass(frozen=True)
class Guess:
    lang: Lang
    text: str
    score: float  # mean log-probability per token, higher is surer; -inf for empty or looping output


def score_tokens(logprobs: list[float], text: str) -> float:
    if not text.strip() or not logprobs:
        return float("-inf")
    raw = text.encode()
    if len(raw) > 40 and len(raw) / len(zlib.compress(raw)) > MAX_COMPRESSION:
        return float("-inf")
    return float(np.mean(logprobs))


def pick(own: Guess, others: list[Guess]) -> Guess:
    """The user's own language unless another one is clearly more confident."""
    best = max(others, key=lambda g: g.score, default=own)
    return best if best.score > own.score + SWITCH_MARGIN else own


class ASR:
    def __init__(self, device: str, langs: tuple[Lang, ...] = tuple(ASR_MODELS)):
        import torch
        from transformers import pipeline

        dtype = torch.float16 if device in ("cuda", "mps") else torch.float32
        self._pipes = {
            lang: pipeline("automatic-speech-recognition", model=ASR_MODELS[lang], device=device, dtype=dtype)
            for lang in langs
        }
        self._locks = {lang: threading.Lock() for lang in langs}

    def transcribe(self, audio: np.ndarray, lang: Lang, detect: bool = False) -> tuple[str, Lang]:
        """Returns (text, language it was heard in). Without `detect`, that is always `lang`."""
        if audio.size < ASR_SAMPLE_RATE * 0.3:  # under 0.3 s: Whisper only hallucinates on this
            return "", lang
        lang = lang if lang in self._pipes else "en"
        if not detect or len(self._pipes) == 1:
            return self._full(audio, lang), lang

        own = self._guess(audio, lang)
        others = [] if own.score >= CONFIDENT else [self._guess(audio, other) for other in self._pipes if other != lang]
        best = pick(own, others)
        log.info(
            "asr detect: own=%s %.2f %s -> %s",
            lang, own.score, " ".join(f"{g.lang}={g.score:.2f}" for g in others) or "(confident)", best.lang,
        )
        if audio.size <= ASR_SAMPLE_RATE * WINDOW_S:
            return best.text, best.lang
        return self._full(audio, best.lang), best.lang  # the guess only heard the first 30 s

    def _full(self, audio: np.ndarray, lang: Lang) -> str:
        with self._locks[lang]:
            out = self._pipes[lang]({"raw": audio, "sampling_rate": ASR_SAMPLE_RATE}, chunk_length_s=30, batch_size=4)
        return str(out["text"]).strip()

    def _guess(self, audio: np.ndarray, lang: Lang) -> Guess:
        """Transcribes the first 30 s with one model and scores how sure it was."""
        import torch

        pipe = self._pipes[lang]
        feats = pipe.feature_extractor(
            audio[: ASR_SAMPLE_RATE * WINDOW_S], sampling_rate=ASR_SAMPLE_RATE, return_tensors="pt"
        ).input_features.to(pipe.model.device, dtype=pipe.model.dtype)
        with self._locks[lang], torch.inference_mode():
            out = pipe.model.generate(feats, return_dict_in_generate=True, output_scores=True, max_new_tokens=220)
        steps = len(out.scores)
        chosen = out.sequences[0, -steps:] if steps else []
        logprobs = [torch.log_softmax(s[0].float(), dim=-1)[int(tok)].item() for s, tok in zip(out.scores, chosen)]
        text = pipe.tokenizer.decode(out.sequences[0], skip_special_tokens=True).strip()
        return Guess(lang, text, score_tokens(logprobs, text))
