"""Whole numbers as words, so the TTS says "125000" as a number instead of guessing at a run of digits.

Hand-written, one function per language, in the forms traders use for money:
- en: "one hundred and twenty five thousand"
- ha: "dubu ɗari da ashirin da biyar" (the multiplier comes first, groups joined with "da")
- ig: "puku narị na iri abụọ na ise" (multiplier first, joined with "na")
- yo: "ẹgbẹ̀rún lọ́nà ọgọ́rùn-ún ó lé márùndínlọ́gbọ̀n": the modern "thousand times N" form used on radio and in the news,
  with the traditional words below 1000 (21-99 are additive "lé" up to 4 past a ten, subtractive "dín" from 5 below
  the next). "ó lé" joins inside a group and "àti" joins groups, so 125,000 and 100,025 sound different.
amounts.py reads these same forms back from what users say.
"""

from __future__ import annotations

from .config import Lang

_EN_SMALL = (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen "
    "eighteen nineteen"
).split()
_EN_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def _en_below_1000(n: int) -> str:
    h, r = divmod(n, 100)
    words = []
    if h:
        words.append(f"{_EN_SMALL[h]} hundred")
    if r:
        if h:
            words.append("and")
        if r < 20:
            words.append(_EN_SMALL[r])
        else:
            t, u = divmod(r, 10)
            words.append(_EN_TENS[t] + (f" {_EN_SMALL[u]}" if u else ""))
    return " ".join(words)


def _en(n: int) -> str:
    if n == 0:
        return "zero"
    m, rest = divmod(n, 1_000_000)
    t, r = divmod(rest, 1000)
    parts = []
    if m:
        parts.append(f"{_en_below_1000(m)} million")
    if t:
        parts.append(f"{_en_below_1000(t)} thousand")
    if r:
        parts.append(("and " if parts and r < 100 else "") + _en_below_1000(r))  # "one thousand and five"
    return " ".join(parts)


_HA_UNITS = ["", "ɗaya", "biyu", "uku", "huɗu", "biyar", "shida", "bakwai", "takwas", "tara"]
_HA_TENS = ["", "goma", "ashirin", "talatin", "arba'in", "hamsin", "sittin", "saba'in", "tamanin", "casa'in"]


def _ha_below_1000(n: int) -> str:
    h, r = divmod(n, 100)
    parts = []
    if h:
        parts.append("ɗari" if h == 1 else f"ɗari {_HA_UNITS[h]}")
    if r:
        t, u = divmod(r, 10)
        if t == 0:
            parts.append(_HA_UNITS[u])
        elif t == 1:
            parts.append("goma" + (f" sha {_HA_UNITS[u]}" if u else ""))
        else:
            parts.append(_HA_TENS[t] + (f" da {_HA_UNITS[u]}" if u else ""))
    return " da ".join(parts)


def _ha(n: int) -> str:
    if n == 0:
        return "sifili"
    m, rest = divmod(n, 1_000_000)
    t, r = divmod(rest, 1000)
    parts = []
    if m:
        parts.append(f"miliyan {_ha_below_1000(m)}")
    if t:
        parts.append("dubu" if t == 1 else f"dubu {_ha_below_1000(t)}")
    if r:
        parts.append(_ha_below_1000(r))
    return " da ".join(parts)


_IG_UNITS = ["", "otu", "abụọ", "atọ", "anọ", "ise", "isii", "asaa", "asatọ", "itoolu"]


def _ig_below_1000(n: int) -> str:
    h, r = divmod(n, 100)
    parts = []
    if h:
        parts.append("narị" if h == 1 else f"narị {_IG_UNITS[h]}")
    if r:
        t, u = divmod(r, 10)
        if t:
            parts.append("iri" if t == 1 else f"iri {_IG_UNITS[t]}")
        if u:
            parts.append(_IG_UNITS[u])
    return " na ".join(parts)


def _ig(n: int) -> str:
    if n == 0:
        return "efu"
    m, rest = divmod(n, 1_000_000)
    t, r = divmod(rest, 1000)
    parts = []
    if m:
        parts.append("otu nde" if m == 1 else f"nde {_ig_below_1000(m)}")
    if t:
        parts.append("puku" if t == 1 else f"puku {_ig_below_1000(t)}")
    if r:
        parts.append(_ig_below_1000(r))
    return " na ".join(parts)


# The forms used after a noun ("náírà márùn-ún", "ẹgbẹ̀rún méjì").
_YO_UNITS = ["", "kan", "méjì", "mẹ́ta", "mẹ́rin", "márùn-ún", "mẹ́fà", "méje", "mẹ́jọ", "mẹ́sàn-án", "mẹ́wàá"]
_YO_TEENS = {11: "mọ́kànlá", 12: "méjìlá", 13: "mẹ́tàlá", 14: "mẹ́rìnlá"}
# Each ten on its own, and the "l-" form it takes after "lé" (added to) or "dín" (taken from).
_YO_TENS = {
    20: ("ogún", "lógún"),
    30: ("ọgbọ̀n", "lọ́gbọ̀n"),
    40: ("ogójì", "lógójì"),
    50: ("àádọ́ta", "láàádọ́ta"),
    60: ("ọgọ́ta", "lọ́gọ́ta"),
    70: ("àádọ́rin", "láàádọ́rin"),
    80: ("ọgọ́rin", "lọ́gọ́rin"),
    90: ("àádọ́rùn-ún", "láàádọ́rùn-ún"),
    100: ("ọgọ́rùn-ún", "lọ́gọ́rùn-ún"),
}
_YO_STEM = {1: "mọ́kàn", 2: "méjì", 3: "mẹ́tà", 4: "mẹ́rìn", 5: "márùn"}
_YO_HUNDREDS = [
    "", "ọgọ́rùn-ún", "igba", "ọ̀ọ́dúnrún", "irinwó", "ẹ̀ẹ́dẹ́gbẹ̀ta", "ẹgbẹ̀ta", "ẹ̀ẹ́dẹ́gbẹ̀rin", "ẹgbẹ̀rin", "ẹ̀ẹ́dẹ́gbẹ̀rún",
]


def _yo_below_100(n: int) -> str:
    if n <= 10:
        return _YO_UNITS[n]
    if n in _YO_TEENS:
        return _YO_TEENS[n]
    tens, u = divmod(n, 10)
    if u == 0:
        return _YO_TENS[n][0]
    if u <= 4:  # 21 = one added to twenty
        return _YO_STEM[u] + "lé" + _YO_TENS[tens * 10][1]
    return _YO_STEM[10 - u] + "dín" + _YO_TENS[tens * 10 + 10][1]  # 25 = five taken from thirty


def _yo_below_1000(n: int) -> str:
    h, r = divmod(n, 100)
    parts = [p for p in (_YO_HUNDREDS[h], _yo_below_100(r) if r else "") if p]
    return " ó lé ".join(parts)


def _yo(n: int) -> str:
    if n == 0:
        return "òdo"
    m, rest = divmod(n, 1_000_000)
    t, r = divmod(rest, 1000)
    parts = []
    if m:
        parts.append(f"mílíọ̀nù {_yo_below_1000(m)}")
    if t:
        # 2,000-19,000: "ẹgbẹ̀rún méjìlá"; from 20,000: "ẹgbẹ̀rún lọ́nà ogún" (a thousand, twenty times)
        parts.append(f"ẹgbẹ̀rún {_yo_below_1000(t)}" if t < 20 else f"ẹgbẹ̀rún lọ́nà {_yo_below_1000(t)}")
    if r:
        parts.append(_yo_below_1000(r))
    return " àti ".join(parts)


_SAY = {"en": _en, "ha": _ha, "ig": _ig, "yo": _yo}
NAIRA: dict[Lang, str] = {"en": "naira", "ha": "naira", "ig": "naira", "yo": "náírà"}
LIMIT = 1_000_000_000  # bigger than any amount we log; longer digit runs (phone numbers) are left alone


def say_number(n: int, lang: Lang) -> str | None:
    """`n` in words, or None if it is out of range."""
    if not 0 <= n < LIMIT:
        return None
    return _SAY.get(lang, _en)(n)


def say_naira(n: int, lang: Lang) -> str | None:
    """English says the number first ("five thousand naira"); Yoruba, Hausa and Igbo put the noun first."""
    words = say_number(n, lang)
    if words is None:
        return None
    return f"{words} naira" if lang == "en" else f"{NAIRA[lang]} {words}"
