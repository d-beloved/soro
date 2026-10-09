"""Pure text helpers (no ML imports, so they are cheap to test)."""

from __future__ import annotations

import re

from .config import Lang
from .numwords import say_naira, say_number

_EMOJI_AND_SYMBOLS = re.compile(
    "[\U0001f300-\U0001faff\U00002600-\U000027bf\U0001f000-\U0001f2ff•✅‼-㊙️]",
)


def _spoken_number(raw: str, scale: str) -> float:
    return float(raw) * {"": 1, "k": 1000, "m": 1_000_000}[scale.lower()]


def clean_for_speech(text: str, lang: Lang = "en") -> str:
    """Make chat text speakable: the TTS guesses at digit runs, emoji and markup.

    - Numbers become words in the reply's language: "₦125,000" -> "náírà ẹgbẹ̀rún lọ́nà ...", "75k" -> "seventy five
      thousand". A number we can't say (a decimal left over, a phone number) stays as digits.
    - Emoji, bullets and quote marks are removed; line breaks become sentence breaks.
    """
    t = re.sub(r"(?<=\d),(?=\d{3}\b)", "", text)

    def money(m: re.Match) -> str:
        n = _spoken_number(m.group(1), m.group(2) or "")
        return (say_naira(int(n), lang) if n == int(n) else None) or m.group(0)

    def number(m: re.Match) -> str:
        n = _spoken_number(m.group(1), m.group(2) or "")
        return (say_number(int(n), lang) if n == int(n) else None) or m.group(0)

    t = re.sub(r"(?:₦\s*|\bN(?=\d))(\d+(?:\.\d+)?)([kKmM]\b)?(?:\s*naira\b)?", money, t)
    t = re.sub(r"\b(\d+(?:\.\d+)?)\s*([kKmM])?\s*naira\b", money, t)
    t = re.sub(r"(?<!\w)(?<!\d\.)(\d+(?:\.\d+)?)([kKmM])?(?!\w|\.\d)", number, t)  # not "20kg" or "3rd"
    t = _EMOJI_AND_SYMBOLS.sub(" ", t)
    t = re.sub(r"[\"“”*_#]", "", t)
    t = re.sub(r"\s*\n+\s*", ". ", t)
    t = re.sub(r"\.\s*\.", ".", t)
    t = re.sub(r"\s+", " ", t).strip(" .")
    return t


def naira_sign(text: str) -> str:
    """The English ASR model writes spoken amounts as dollars ("i barbed my hair for $3000"); in Nigeria they are naira.
    Left as "$", the router read the note as unknown and the "I heard" echo showed dollars."""
    return re.sub(r"\$\s?(?=\d)", "₦", text)


_PLACEHOLDER = re.compile(r"\{\w+\}")


def placeholders(text: str) -> list[str]:
    return sorted(_PLACEHOLDER.findall(text))
