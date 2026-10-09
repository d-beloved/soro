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
- Yoruba as numwords.py speaks it: "ẹgbẹ̀rún lọ́nà ọgọ́rùn-ún ó lé márùndínlọ́gbọ̀n" (125,000), "ẹgbẹ̀rún méjìlá àti
  ẹ̀ẹ́dẹ́gbẹ̀ta" (12,500), with the additive/subtractive words for 13-99 ("méjìlélógójì" 42, "márùndínlọ́gọ́rin" 75).
- Yoruba as the ASR mishears it: one letter off ("márùndínlọ́gárin", "mílíọ̀lù", "rẹ̀gbẹ̀rún"), a word split in two
  ("márùndú lọ́gbọ̀n") or two run together ("ẹgbẹ̀rúnlọ́nà"). A near miss is only read when it is closest to a single
  number; one that sits between two ("aadoran": aadorin 70 or aadorun 90?) is left alone.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from itertools import combinations

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
    "mewa": 10, "mewaa": 10, "ewa": 10, "eewa": 10, "mokanla": 11, "mejila": 12, "metala": 13, "merinla": 14,
    "eedogun": 15,
    "ogun": 20, "ogbon": 30, "ogoji": 40, "aadota": 50, "adota": 50, "ogota": 60, "aadorin": 70, "adorin": 70,
    "ogorin": 80, "aadorun": 90, "adorun": 90, "igba": 200, "oodunrun": 300, "irinwo": 400,
    "eedegbeta": 500, "egbeta": 600, "eedegberin": 700, "egberin": 800, "eedegberun": 900,
}
_TEN_TIMES = {"iri": 10}  # Igbo: "iri ise" = 50
_HUNDRED = {"dari": 100, "nari": 100, "ogorun": 100}  # "dari biyu" = 200
_BIG = {"dubu": 1000, "puku": 1000, "egberun": 1000, "igberun": 1000, "egbaa": 2000, "miliyan": 1_000_000,
        "milionu": 1_000_000, "oke": 20_000, "nde": 1_000_000}  # "igberun": how the Yoruba ASR sometimes spells it
_BIG_NEEDS_COUNT = {"oke", "nde"}  # also everyday words ("up", "people"): only an amount with a number after them
_ONE_BEFORE = {"otu"}  # Igbo "otu puku", "otu nde"
_TEENS_JOIN = {"sha"}  # Hausa "goma sha biyar" = 15
_JOIN = {"da", "na", "le", "ati", "and"}
_SKIP_AFTER_BIG = {"naira", "lona", "n"}  # "puku naira iri ise", "egberun lona ogbon"
_CURRENCY = {"naira", "₦", "n"}

# Yoruba 13-99 in one word: a unit added to ("le") or taken from ("din") a ten, which takes an "l-" ("lọ́gbọ̀n").
# The ASR also writes "lí" for "lé" and "dú"/"dí" for "dín", so any "l"/"d" joining syllable is read by its first letter.
_YO_COMPOUND = re.compile(r"(mokan|okan|meji|eji|meta|eta|merin|erin|marun|arun)(l[ei]|d[a-z]{0,2}?)l(\w+)")
_YO_STEM = {"mokan": 1, "okan": 1, "meji": 2, "eji": 2, "meta": 3, "eta": 3, "merin": 4, "erin": 4, "marun": 5, "arun": 5}
_YO_TENS = {w: {**_BASIC, **_HUNDRED}[w] for w in "ogun ogbon ogoji aadota adota ogota aadorin adorin ogorin aadorun adorun ogorun".split()}
# Yoruba number words long enough to tell apart with one letter wrong. Shorter ones ("eta", "efa") are too close to
# each other and to everyday words.
_YO_LONG = {w: v for w, v in {**_BASIC, **_HUNDRED, **_BIG}.items() if len(w) >= 6 and w in (
    "mokanla mejila metala merinla eedogun aadota ogota aadorin ogorin aadorun ogorun oodunrun irinwo eedegbeta "
    "egbeta eedegberin egberin eedegberun egberun milionu").split()}
_YO_BIG_ALONE = {"egberun", "milionu"}  # may be run together with "lọ́nà": "ẹgbẹ̀rúnlọ́nà"

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
    t = re.sub(r"(?<=[a-z])-(?:un|an)\b", "", t)  # Yoruba "ọgọ́rùn-ún", "márùn-ún" -> ogorun, marun
    return t


def _dist(a: str, b: str) -> int:
    """Edit distance: letters inserted, dropped or changed."""
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _near(tok: str, words: dict[str, int]) -> str | None:
    """The one word in `words` that `tok` is one letter away from, if all such closest words mean the same number."""
    best: list[str] = []
    for w in words:
        d = _dist(tok, w)
        if d <= 1 and (not best or d < _dist(tok, best[0])):
            best = [w]
        elif d <= 1 and d == _dist(tok, best[0]):
            best.append(w)
    return best[0] if best and len({words[w] for w in best}) == 1 else None


def _num(tok: str) -> int | None:
    """A Hausa/Igbo/Yoruba number word below 1000."""
    if tok in _BASIC:
        return _BASIC[tok]
    m = _YO_COMPOUND.fullmatch(tok)
    if m:
        tail = m.group(3)  # "lọ́gbọ̀n" -> ogbon; "láàádọ́ta" -> aadota (the "l-" brings its own vowel)
        tails = (tail, tail[1:])
        ten = next((_YO_TENS[w] for w in tails if w in _YO_TENS), None)
        if ten is None:  # "lọ́gárin" for "lọ́gọ́rin"
            ten = next((_YO_TENS[n] for w in tails if len(w) >= 4 and (n := _near(w, _YO_TENS))), None)
        if ten is not None:
            return ten + _YO_STEM[m.group(1)] * (1 if m.group(2)[0] == "l" else -1)
    return None


def _known(tok: str) -> bool:
    return (tok in _BASIC or tok in _BIG or tok in _HUNDRED or tok in _TEN_TIMES or tok in _JOIN or tok in _CURRENCY
            or tok in _SKIP_AFTER_BIG or tok in _EN_SMALL or tok in _EN_TENS or tok in _EN_SCALE
            or _digit(tok) is not None or _num(tok) is not None)


def _mend(toks: list[str]) -> list[str]:
    """Puts Yoruba number words the ASR misheard back together, see the module docstring."""
    out: list[str] = []
    i = 0
    while i < len(toks):
        t = toks[i]
        if _known(t):
            out.append(t)
            i += 1
            continue
        if i + 1 < len(toks) and not _known(toks[i + 1]) and _num(t + toks[i + 1]) is not None:  # "márùndú lọ́gbọ̀n"
            out.append(t + toks[i + 1])
            i += 2
            continue
        if t.endswith("lona") and (head := t[:-4]) and (head in _YO_BIG_ALONE or _near(head, _YO_LONG) in _YO_BIG_ALONE):
            out += [head if head in _YO_BIG_ALONE else _near(head, _YO_LONG), "lona"]  # "ẹgbẹ̀rúnlọ́nà"
            i += 1
            continue
        out.append((len(t) >= 6 and _near(t, _YO_LONG)) or t)  # "mílíọ̀lù", "rẹ̀gbẹ̀rún", "ọ̀dúnrún"
        i += 1
    return out


def _join_at(toks: list[str], j: int) -> int:
    """How many tokens of joining word start at j: "da", "na", "àti", or Yoruba "ó lé" (2). 0 if none."""
    if j < len(toks) and toks[j] in _JOIN:
        return 1
    if j + 1 < len(toks) and toks[j] == "o" and toks[j + 1] == "le":
        return 2
    return 0


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
            # "dari uku" = 300; the count is a single digit, so "dari uku da hamsin" is 350, not 100 x 53
            n = _num(toks[j + 1]) if j + 1 < len(toks) else None
            if n and n < 10:
                total, j = 100 * n, j + 2
            else:
                total, j = 100, j + 1
        elif t in _TEN_TIMES:
            n = _num(toks[j + 1]) if j + 1 < len(toks) else None
            total += 10 * (n if n and n < 10 else 1)
            j += 2 if n and n < 10 else 1
        elif (n := _num(t)) is not None and (first or n < 100):
            total += n
            j += 1
            if j + 1 < len(toks) and toks[j] in _TEENS_JOIN and toks[j + 1] in _BASIC:
                total += _BASIC[toks[j + 1]]
                j += 2
        elif first and (d := _digit(t)) is not None and d == int(d) and d < 1000 and not t[-1].isalpha():
            total, j = int(d), j + 1
        else:
            break
        first = False
        # "saba'in da biyar", "iri abuo na ise", "irinwo o le marun": keep adding, but not into a new hundreds group
        # ("egberun mejila ati eedegbeta" is 12,000 + 500, not 512,000). Yoruba "àti" always starts a new group.
        nxt = j + (_join_at(toks, j) if j < len(toks) and toks[j] != "ati" else 0)
        if nxt > j and nxt < len(toks) and (((n := _num(toks[nxt])) is not None and n < 100) or toks[nxt] in _TEN_TIMES):
            j = nxt
            continue
        break
    return total, j


def _multiplier_first(toks: list[str], i: int, one_before: bool = False) -> tuple[int, int]:
    """'dubu biyar da dari biyu' = 5,200; 'egberun lona ogbon' = 30,000. Starts on a _BIG or _HUNDRED word.
    `one_before`: the count came first, as Igbo does with one ("otu nde" = 1,000,000)."""
    t = toks[i]
    if t in _HUNDRED or (_num(t) or 0) >= 100:  # "dari biyu", Yoruba "ẹ̀ẹ́dẹ́gbẹ̀ta"
        n, j = _small(toks, i)
        return n, j
    j = i + 1
    while j < len(toks) and toks[j] in _SKIP_AFTER_BIG:
        j += 1
    n, k = (1, i + 1) if one_before else _small(toks, j)
    if not n:
        if t in _BIG_NEEDS_COUNT:
            return 0, i + 1
        n, k = 1, i + 1
    value = _BIG[t] * n
    # "... da dari biyu" / "... na nari ato" / "... da dubu ..." : a lower group added on
    nxt = k + _join_at(toks, k)
    lower = nxt > k and nxt < len(toks) and (toks[nxt] in _HUNDRED or toks[nxt] in _BIG or (_num(toks[nxt]) or 0) >= 100)
    if lower:
        extra, k2 = _multiplier_first(toks, nxt)
        if extra and extra < value:
            value, k = value + extra, k2
    elif nxt > k and toks[k] == "ati" and nxt < len(toks) and _num(toks[nxt]):  # "ẹgbẹ̀rún méjì àti márùn-ún" = 2,005
        extra, k2 = _small(toks, nxt)
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
    toks = _mend(_TOKEN.findall(_normalise(text)))
    out: list[Candidate] = []
    i = 0
    while i < len(toks):
        t = toks[i]
        before = toks[i - 1] if i else ""
        one_before = t in _ONE_BEFORE and i + 1 < len(toks) and toks[i + 1] in _BIG
        if t in _BIG or t in _HUNDRED or one_before:
            value, j = _multiplier_first(toks, i + 1, one_before=True) if one_before else _multiplier_first(toks, i)
            t = toks[i + 1] if one_before else t
            after = toks[j] if j < len(toks) else ""
            if value and (t in _BIG or before in _CURRENCY or after == "naira"):
                out.append(Candidate(value, strong=True))
            i = max(j, i + 1)
            continue
        if before in ("naira", "₦") and (_num(t) is not None or t in _TEN_TIMES):  # "náírà ẹ̀ẹ́dẹ́gbẹ̀ta", "naira biyar": below a thousand
            value, j = _small(toks, i)
            if value:
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
    """Keep the model's amount_ngn only if the message accounts for it; otherwise use the parsed one.
    Record intents also get other_amounts: the amounts the record leaves out (see other_amounts())."""
    if result.get("intent") not in AMOUNT_INTENTS:
        return result
    qty = result.get("quantity")
    # "I sell 150 pieces": a bare number the model already read as the quantity is not the price
    cands = [c for c in candidates(text) if c.strong or c.value != qty]
    best = best_amount(cands)
    if best is None:
        return result  # nothing we can read (or a number form we don't parse): trust the model
    every = [c.value for c in cands]
    pool = [c.value for c in cands if c.strong] or every
    llm = result.get("amount_ngn")
    if isinstance(llm, (int, float)) and not _accounted(llm, pool, qty) and _accounted(llm, every, qty):
        pool = every  # a list whose amounts aren't all marked as money: "egg 9k and milk 4500" = 13,500
    if not (isinstance(llm, (int, float)) and llm > 0 and _accounted(llm, pool, qty)):
        result = {**result, "amount_ngn": _list_total(result["intent"], llm, pool) or best}
    if result["intent"] in MULTI_CHECK:
        others = other_amounts(result["amount_ngn"], pool, qty)
        if others:
            result = {**result, "other_amounts": others}
    return result


# Intents that save one record, where a second amount in the message is most likely a second record.
# Corrections ("not 5k, 7k"), repayments ("paid 5k of the 10k") and loans ("200k, 20k a month") name
# several amounts by nature, and budgets are one figure.
MULTI_CHECK = {"log_sale", "log_expense", "log_income", "log_debt"}
_MAX_GROUP = 8  # groups are tried exhaustively; nobody says more amounts than this in one message


def _list_total(intent: str, llm: object, values: list[int]) -> int | None:
    """A list read as one record ("meat 9000, garri 1000, pepper 200"), where the model meant the total but added
    it up wrong (10000): the real total. None if the model's figure isn't close to it."""
    total = sum(values)
    if intent in MULTI_CHECK and len(values) > 1 and isinstance(llm, (int, float)) and abs(llm - total) <= 0.1 * total:
        return total
    return None


def _group(recorded: float, values: list[int]) -> tuple[int, ...] | None:
    """The largest group of `values` (by index) adding up to `recorded`: "rice 5k, beans 3k, fuel 2k" recorded
    as 8k is the rice and the beans."""
    if len(values) > _MAX_GROUP:
        return (*range(len(values)),) if abs(sum(values) - recorded) < 0.5 else None
    for size in range(len(values), 0, -1):
        for group in combinations(range(len(values)), size):
            if abs(sum(values[k] for k in group) - recorded) < 0.5:
                return group
    return None


def _unit_price(v: float, recorded: float, qty: float | None) -> bool:
    """"2 bags at 25k each" recorded as 50k."""
    return isinstance(qty, (int, float)) and qty > 1 and abs(v * qty - recorded) < 0.5


def _accounted(recorded: float, values: list[int], qty: float | None) -> bool:
    return _group(recorded, values) is not None or any(_unit_price(v, recorded, qty) for v in values)


def other_amounts(recorded: float, values: list[int], qty: float | None = None) -> list[int]:
    """The amounts in a message that the recorded one doesn't account for, so the user can be told they weren't saved.

    The router saves one record per message, so "rice 5k, beans 3k, and I bought fuel 2k" saves the 8k of sales
    and the fuel is lost. An amount is accounted for when it is part of the recorded figure: the figure itself, one
    of a group of amounts adding up to it, or a unit price times the quantity.
    """
    if len(values) < 2 or len(values) > _MAX_GROUP:
        return []
    group = _group(recorded, values) or ()
    left = [v for k, v in enumerate(values) if k not in group and not _unit_price(v, recorded, qty)]
    # a repeated figure ("5k, yes 5k") is the record said twice, not a second one
    return sorted({v for v in left if abs(v - recorded) >= 0.5}, key=left.index)
