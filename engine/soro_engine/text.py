"""Pure text helpers (no ML imports, so they are cheap to test)."""

from __future__ import annotations

import re

_EMOJI_AND_SYMBOLS = re.compile(
    "[\U0001f300-\U0001faff\U00002600-\U000027bf\U0001f000-\U0001f2ff•✅‼-㊙️]",
)


def clean_for_speech(text: str) -> str:
    """Make chat text speakable for YarnGPT, whose own normaliser drops anything that is not a letter or digit.

    - "₦75,000" -> "75000 naira", "75k" -> "75000": otherwise "75,000" is read as "seventy five zero".
    - Emoji, bullets and quote marks are removed; line breaks become sentence breaks.
    """
    t = text
    t = re.sub(r"(?<=\d),(?=\d{3}\b)", "", t)
    t = re.sub(r"\b(\d+(?:\.\d+)?)\s*[kK]\b", lambda m: str(int(float(m.group(1)) * 1000)), t)
    t = re.sub(r"[₦]\s*(\d+(?:\.\d+)?)", r"\1 naira", t)
    t = re.sub(r"\bN(\d+(?:\.\d+)?)", r"\1 naira", t)
    t = _EMOJI_AND_SYMBOLS.sub(" ", t)
    t = re.sub(r"[\"“”*_#]", "", t)
    t = re.sub(r"\s*\n+\s*", ". ", t)
    t = re.sub(r"\.\s*\.", ".", t)
    t = re.sub(r"\s+", " ", t).strip(" .")
    return t


def split_sentences(text: str, max_chars: int = 220) -> list[str]:
    """Split into chunks YarnGPT can voice in one generate() call (~15 s of audio each)."""
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    chunks: list[str] = []
    current = ""
    for s in sentences:
        while len(s) > max_chars:  # very long sentence: cut on a word boundary
            cut = s.rfind(" ", 0, max_chars)
            cut = cut if cut > 0 else max_chars
            if current:
                chunks.append(current)
                current = ""
            chunks.append(s[:cut].strip())
            s = s[cut:].strip()
        if current and len(current) + 1 + len(s) > max_chars:
            chunks.append(current)
            current = s
        else:
            current = f"{current} {s}".strip()
    if current:
        chunks.append(current)
    return chunks


_PLACEHOLDER = re.compile(r"\{\w+\}")


def placeholders(text: str) -> list[str]:
    return sorted(_PLACEHOLDER.findall(text))
