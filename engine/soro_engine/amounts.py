"""Deterministic naira amounts, used to check the router's amount_ngn (pure Python, no ML imports).

The LLM is good at intents but unreliable with numbers: it has turned "ẹgbẹ̀rún lọ́nà ọgbọ̀n" (30,000) into 200000
and dropped the "5k" from a debt. So for amount-bearing intents we read every amount the message actually contains
and only keep the model's figure if it is one of them.

Understood:
- digits: "10,000", "4500", "5k", "2.5m", "₦5,000", "N5000", "12500 naira", "5 thousand"
- English/Pidgin words: "seventy five thousand", "two thousand five hundred", "five k"
- Hausa / Igbo / Yoruba, where the multiplier comes first: "dubu saba'in da biyar" (75,000),
  "puku iri ise" (50,000), "ẹgbẹ̀rún lọ́nà ọgbọ̀n" / "egberun marun" (30,000 / 5,000), "ẹgbàá mẹ́ta" (6,000).
  Tone marks are ignored, so ASR output with or without diacritics both work.
Not understood (the model's figure is kept): Yoruba subtractive forms like "ẹ̀ẹ́dógún" (15).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

AMOUNT_INTENTS = {"log_sale", "log_expense", "log_income", "log_debt", "debt_paid", "set_budget", "correct_last", "loan_intake"}

_EN_SMALL = {
    w: i
    for i, w in enumerate(
        "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
        "sixteen seventeen eighteen nineteen".split()
    )
}
_EN_TENS = {w: 10 * i for i, w in enumerate("_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()) if w != "_"}
_EN_SCALE = {"thousand": 1000, "k": 1000, "million": 1_000_000, "billion": 1_000_000_000}

# Hausa, Igbo and Yoruba number words (tone marks and dots stripped), all < 1000.
_BASIC = {
    # Hausa
    "daya": 1, "biyu": 2, "uku": 3, "hudu": 4, "biyar": 5, "shida": 6, "bakwai": 7, "takwas": 8, "tara": 9,
    "goma": 10, "ashirin": 20, "talatin": 30, "arba'in": 40, "hamsin": 50, "sittin": 60, "saba'in": 70,
    "tamanin": 80, "casa'in": 90, "arbain": 40, "sabain": 70, "casain": 90,
    # Igbo
    "otu": 1, "abuo": 2, "ato": 3, "ano": 4, "ise": 5, "isii": 6, "asaa": 7, "asato": 8, "itoolu": 9, "iteghete": 9,
    # Yoruba (counting forms, the "m-" forms used after nouns, and doubled-vowel spellings)
    "kan": 1, "okan": 1, "ookan": 1, "meji": 2, "eji": 2, "eeji": 2, "meta": 3, "eta": 3, "eeta": 3,
    "merin": 4, "erin": 4, "eerin": 4, "marun": 5, "arun": 5, "aarun": 5, "mefa": 6, "efa": 6, "eefa": 6,
    "meje": 7, "eje": 7, "eeje": 7, "mejo": 8, "ejo": 8, "eejo": 8, "mesan": 9, "esan": 9, "eesan": 9,
    "mewa": 10, "mewaa": 10, "ewa": 10, "eewa": 10, "mokanla": 11, "mejila": 12,
    "ogun": 20, "ogbon": 30, "ogoji": 40, "aadota": 50, "adota": 50, "ogota": 60, "aadorin": 70, "adorin": 70,
    "ogorin": 80, "aadorun": 90, "adorun": 90, "igba": 200, "oodunrun": 300, "irinwo": 400,
    "eedegbeta": 500, "egbeta": 600, "eedegberin": 700, "egberin": 800, "eedegbesan": 900,
}
_TEN_TIMES = {"iri": 10}  # Igbo: "iri ise" = 50
_HUNDRED = {"dari": 100, "nari": 100, "ogorun": 100}  # "dari biyu" = 200
_BIG = {"dubu": 1000, "puku": 1000, "egberun": 1000, "egbaa": 2000, "miliyan": 1_000_000, "milionu": 1_000_000,
        "oke": 20_000, "nde": 1_000_000}
_BIG_NEEDS_COUNT = {"oke", "nde"}  # also everyday words ("up", "people"): only an amount with a number after them
_TEENS_JOIN = {"sha"}  # Hausa "goma sha biyar" = 15
_JOIN = {"da", "na", "le", "ati", "and"}
_SKIP_AFTER_BIG = {"naira", "lona", "n"}  # "puku naira iri ise", "egberun lona ogbon"
_CURRENCY = {"naira", "₦", "n"}

_TOKEN = re.compile(r"₦|\d+(?:\.\d+)?(?:[km](?![a-z]))?|[a-z']+")


@dataclass(frozen=True)
class Candidate:
    value: int
    strong: bool  # has a currency marker or a thousand-sized multiplier, so it's almost certainly money


def _normalise(text: str) -> str:
    t = text.lower().replace("’", "'").replace("ʼ", "'")
    t = t.translate(str.maketrans({"ɗ": "d", "ƙ": "k", "ɓ": "b", "ƴ": "y", "ŋ": "n"}))
    t = "".join(c for c in unicodedata.normalize("NFD", t) if not unicodedata.combining(c))
    t = re.sub(r"(?<=\d),(?=\d{3}\b)", "", t)  # 10,000 -> 10000
    t = re.sub(r"(?<![a-z])n\s?(?=\d)", "n ", t)  # N5000 -> n 5000
    return t


def _digit(tok: str) -> float | None:
    m = re.fullmatch(r"(\d+(?:\.\d+)?)([km]?)", tok)
    if not m:
        return None
    if len(m.group(1)) >= 10:  # phone numbers, account numbers
        return None
    return float(m.group(1)) * {"": 1, "k": 1000, "m": 1_000_000}[m.group(2)]


def _small(toks: list[str], i: int) -> tuple[int, int]:
    """A Hausa/Igbo/Yoruba number below 1000 starting at i (digits allowed). Returns (value, next index); value 0 = none."""
    total, j, first = 0, i, True
    while j < len(toks):
        t = toks[j]
        if t in _HUNDRED and first:
            n, k = _small(toks, j + 1)
            total, j = 100 * (n or 1), k
        elif t in _TEN_TIMES:
            n = _BASIC.get(toks[j + 1]) if j + 1 < len(toks) else None
            total += 10 * (n if n and n < 10 else 1)
            j += 2 if n and n < 10 else 1
        elif t in _BASIC:
            total += _BASIC[t]
            j += 1
            if j + 1 < len(toks) and toks[j] in _TEENS_JOIN and toks[j + 1] in _BASIC:
                total += _BASIC[toks[j + 1]]
                j += 2
        elif first and (d := _digit(t)) is not None and d == int(d) and d < 1000 and not t[-1].isalpha():
            total, j = int(d), j + 1
        else:
            break
        first = False
        # "saba'in da biyar", "iri abuo na ise", "ogun le marun": keep adding, but not into a new hundreds group
        if j + 1 < len(toks) and toks[j] in _JOIN and (toks[j + 1] in _BASIC or toks[j + 1] in _TEN_TIMES):
            j += 1
            continue
        break
    return total, j


def _multiplier_first(toks: list[str], i: int) -> tuple[int, int]:
    """'dubu biyar da dari biyu' = 5,200; 'egberun lona ogbon' = 30,000. Starts on a _BIG or _HUNDRED word."""
    t = toks[i]
    if t in _HUNDRED:
        n, j = _small(toks, i)
        return n, j
    j = i + 1
    while j < len(toks) and toks[j] in _SKIP_AFTER_BIG:
        j += 1
    n, k = _small(toks, j)
    if not n:
        if t in _BIG_NEEDS_COUNT:
            return 0, i + 1
        n, k = 1, i + 1
    value = _BIG[t] * n
    # "... da dari biyu" / "... na nari ato" / "... da dubu ..." : a lower group added on
    if k + 1 < len(toks) and toks[k] in _JOIN and (toks[k + 1] in _HUNDRED or toks[k + 1] in _BIG):
        extra, k2 = _multiplier_first(toks, k + 1)
        if extra and extra < value:
            value, k = value + extra, k2
    return value, k


def _english(toks: list[str], i: int) -> tuple[float, int, bool]:
    """'seventy five thousand', 'two thousand five hundred', '5 thousand', '2.5 million'. Returns (value, next, has_scale)."""
    total, current, j, last_scale, used, scaled = 0.0, 0.0, i, None, False, False
    while j < len(toks):
        t = toks[j]
        d = _digit(t)
        if d is not None and not used:
            current, j, used = d, j + 1, True
            if t[-1].isalpha():  # "5k" already carries its scale
                scaled = True
            if j < len(toks) and toks[j] in _EN_SCALE and not t[-1].isalpha():
                continue
            break
        if d is not None and last_scale and d < last_scale and current == 0:  # "two thousand 500"
            current, j = d, j + 1
            break
        if t in _EN_SMALL:
            current += _EN_SMALL[t]
        elif t in _EN_TENS:
            current += _EN_TENS[t]
        elif t == "hundred" and used:
            current = (current or 1) * 100
        elif t in _EN_SCALE and used and (last_scale is None or _EN_SCALE[t] < last_scale):
            total += (current or 1) * _EN_SCALE[t]
            current, last_scale, scaled = 0.0, _EN_SCALE[t], True
        elif t == "and" and used and j + 1 < len(toks) and (toks[j + 1] in _EN_SMALL or toks[j + 1] in _EN_TENS):
            pass
        else:
            break
        used = True
        j += 1
    return total + current, j, scaled


def candidates(text: str) -> list[Candidate]:
    toks = _TOKEN.findall(_normalise(text))
    out: list[Candidate] = []
    i = 0
    while i < len(toks):
        t = toks[i]
        before = toks[i - 1] if i else ""
        if t in _BIG or t in _HUNDRED:
            value, j = _multiplier_first(toks, i)
            after = toks[j] if j < len(toks) else ""
            if value and (t in _BIG or before in _CURRENCY or after == "naira"):
                out.append(Candidate(value, strong=True))
            i = max(j, i + 1)
            continue
        if _digit(t) is not None or t in _EN_SMALL or t in _EN_TENS:
            value, j, scaled = _english(toks, i)
            after = toks[j] if j < len(toks) else ""
            marked = before in _CURRENCY or after == "naira"
            # "three bags" is a quantity; a bare "10000" or "five hundred" is probably money but weaker evidence
            if value >= 1 and (scaled or marked or value >= 100):
                out.append(Candidate(int(round(value)), strong=scaled or marked))
            i = max(j, i + 1)
            continue
        i += 1
    return out


def best_amount(cands: list[Candidate]) -> int | None:
    """The largest strong amount, else the largest bare number >= 100 ("10,000" with no "naira")."""
    strong = [c.value for c in cands if c.strong]
    if strong:
        return max(strong)
    weak = [c.value for c in cands if c.value >= 100]
    return max(weak) if weak else None


def extract_amount_ngn(text: str) -> int | None:
    return best_amount(candidates(text))


def reconcile_amount(result: dict, text: str) -> dict:
    """Keep the model's amount_ngn only if it is one the message contains; otherwise use the parsed one."""
    if result.get("intent") not in AMOUNT_INTENTS:
        return result
    qty = result.get("quantity")
    # "I sell 150 pieces": a bare number the model already read as the quantity is not the price
    cands = [c for c in candidates(text) if c.strong or c.value != qty]
    best = best_amount(cands)
    if best is None:
        return result  # nothing we can read (or a number form we don't parse): trust the model
    pool = [c.value for c in cands if c.strong] or [c.value for c in cands]
    llm = result.get("amount_ngn")
    if isinstance(llm, (int, float)) and llm > 0:
        plausible = {*pool, sum(pool)}
        if isinstance(qty, (int, float)) and qty > 1:
            plausible |= {v * qty for v in pool}  # "2 bags at 25k each" -> 50000
        if any(abs(llm - v) < 0.5 for v in plausible):
            return result
    return {**result, "amount_ngn": best}
