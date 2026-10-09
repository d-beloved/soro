"""Prompts for N-ATLaS. Router output is constrained to ROUTER_SCHEMA by llama.cpp's JSON grammar.

The yo/ha/ig few-shot examples are first drafts: have a native speaker check them
and swap in real phrasings from users' voice notes.
"""

from __future__ import annotations

import json

from .config import LANG_NAMES, LANGS, Lang

INTENTS = [
    "log_sale", "log_expense", "log_income", "log_debt", "debt_paid", "stock_update", "summary_query",
    "set_budget", "undo_last", "correct_last", "loan_intake", "ask_question", "greeting", "help", "set_language",
    "unknown",
]
TOPICS = ["separate_money", "record_keeping", "cash_flow", "debt_recovery", "credit_readiness", "savings", "pricing"]
# "goods" and "business_costs" are business spending; the rest are personal.
CATEGORIES = [
    "goods", "business_costs", "food", "transport", "data_airtime", "rent_bills", "family",
    "health", "school", "fun", "clothing", "savings", "other",
]
# What a correction can turn the last record into.
RECORD_INTENTS = ["log_sale", "log_expense", "log_income", "log_debt", "debt_paid"]

_str = {"type": ["string", "null"]}
_num = {"type": ["number", "null"]}
# Enums are written without "type": llama.cpp's grammar ignores "enum" next to a type list (it let through "day", "personal").

ROUTER_SCHEMA = {
    "type": "object",
    "properties": {
        "intent": {"type": "string", "enum": INTENTS},
        "item": _str,
        "quantity": _num,
        "unit": _str,
        "amount_ngn": _num,
        "counterparty": _str,
        "direction": {"enum": ["owed_to_me", "i_owe", None]},
        "category": {"enum": [*CATEGORIES, None]},
        "period": {"enum": ["today", "week", "month", None]},
        "topic": {"enum": [*TOPICS, None]},
        "question": _str,
        "purpose": _str,
        "correct_to": {"enum": [*RECORD_INTENTS, None]},
        "language": {"enum": [*LANGS, None]},
    },
    "required": ["intent"],
}
CATEGORY_INTENTS = {"log_expense", "set_budget"}
# N-ATLaS sometimes leaves "category" out, and the grammar can't force it: making it required puts it right after
# "intent" (llama.cpp writes required fields first) and the model then stops, dropping item and counterparty.
# So a spend or budget without a category gets a second, short call that only picks one. It runs only then: a
# different prompt evicts llama.cpp's cached router prompt, which costs ~2.5s on this call and the next one.
# (Asking as a follow-up turn of the router chat kept the cache but picked "food" for almost everything.)
CATEGORY_SCHEMA = {
    "type": "object",
    "properties": {"category": {"enum": CATEGORIES}},
    "required": ["category"],
}
CATEGORY_SYSTEM = """Pick the spending category for a message from a person in Nigeria. Return JSON like {"category": "food"}.
Business: goods (anything bought to sell again, or "for shop", "for my stock", "for customers"), business_costs (shop rent,
wages, fuel for the shop or generator, transport for goods, tools, materials for work).
Personal: food, transport, data_airtime, rent_bills, family, health, school, fun, clothing, savings, other.
Food bought to resell is goods, not food. Pick goods or business_costs only when the message says the spend is for the
shop, stall, work, customers or selling; otherwise pick a personal category."""
CATEGORY_FEW_SHOT = [
    ("I buy 2 cartons of Indomie for shop 18k", "goods"),
    ("I chop rice and beans 1200", "food"),
    ("I buy fabric for customer gown 9k", "business_costs"),
    ("Bolt to work 3500", "transport"),
    ("I buy new trouser 7k", "clothing"),
    ("I pay NEPA bill 5k", "rent_bills"),
]


def category_messages(text: str) -> list[dict]:
    messages = [{"role": "system", "content": CATEGORY_SYSTEM}]
    for user, cat in CATEGORY_FEW_SHOT:
        messages += [{"role": "user", "content": user}, {"role": "assistant", "content": json.dumps({"category": cat})}]
    return messages + [{"role": "user", "content": text}]


# What the model writes when it has no item; shown to the user as "Spent: unknown — ₦20,000".
NO_ITEM = {"unknown", "none", "null", "n/a", "nothing", "item", "money"}


def tidy_route(result: dict) -> dict:
    """Keep "category" only on intents that use it (and corrections), and only if it is a known one;
    keep "correct_to" only on corrections and "language" only on set_language; drop placeholder items."""
    intent = result.get("intent")
    item = result.get("item")
    if isinstance(item, str) and item.strip().lower() in NO_ITEM:
        result = {**result, "item": None}
    if result.get("language") is not None and (intent != "set_language" or result["language"] not in LANGS):
        result = {**result, "language": None}
    if result.get("category") is not None and (
        (intent not in CATEGORY_INTENTS and intent != "correct_last") or result["category"] not in CATEGORIES
    ):
        result = {**result, "category": None}
    if result.get("correct_to") is not None and (intent != "correct_last" or result["correct_to"] not in RECORD_INTENTS):
        result = {**result, "correct_to": None}
    return result


def needs_category(result: dict) -> bool:
    if result.get("category") is not None:
        return False
    if result.get("intent") == "correct_last":
        # Only when the correction turns the record into a spend and says what it was ("na tithe I pay");
        # "no be income, na expense" alone gives the category call nothing to go on.
        return result.get("correct_to") == "log_expense" and bool(result.get("item"))
    return result.get("intent") in CATEGORY_INTENTS


ROUTER_SYSTEM = """You are the message router for Sọ̀rọ̀, a WhatsApp money-records and money-tips assistant for people in Nigeria:
market traders, artisans and other small businesses, and also workers and students tracking their personal money.
Today is {today}. Each message starts with the language the user chose, in brackets, e.g. [Yoruba]. The message
itself may mix English, Pidgin, Yoruba, Hausa or Igbo. Messages are often voice-note transcripts, so expect missing
punctuation, spelling mistakes, and words run together or heard as English ("mowatunra" is "mo wá tún ra").

Return ONE JSON object. Fields:
- intent:
  log_sale (user sold goods or was paid for their work or service),
  log_expense (user spent money: goods to resell, business costs, or personal spending like food, data, transport),
  log_income (personal money received that is not a sale: salary, allowance, money someone sent, gift; only when
    money came TO the user. Buying is never income: "I buy", "mo ra", "na sayi", "azụrụ m" are log_expense),
  log_debt (someone owes the user, or the user owes someone; also money lent or borrowed),
  debt_paid (a debt was paid back, either to the user or by the user),
  stock_update (how many goods are left in the shop, a count),
  summary_query (asks how much they sold/spent/earned, profit, who owes them, where their money went),
  set_budget (sets a spending limit for a category, per month),
  undo_last (cancel or remove the last thing recorded),
  correct_last (the user says the last record was wrong; fill only what they fixed, see correct_to. A message that
    starts "no", "I said", "rárá", "mo ní", "kì í ṣe", "ba ... ba ne" or "ọ bụghị" and says the record again
    differently is correct_last, not a new record),
  loan_intake (wants a loan or credit),
  ask_question (any question about money, saving, budgeting, pricing, debt, records, loans; but "how much is left",
    "how much I don spend" is summary_query),
  set_language (the user asks to be answered in another language, see language), greeting, help, unknown.
- item, quantity, unit: the goods or thing, e.g. item "rice", quantity 3, unit "bags". Use the user's own words for
  the item, in English; null if unclear. Never write "unknown", and never invent who sent money.
- amount_ngn: total amount in naira as a plain number. Copy digits exactly: "10,000" = 10000, "5k" = 5000, "2.5m" = 2500000.
  Words: "five thousand" = 5000; Yoruba ẹgbẹ̀rún, Hausa dubu, Igbo puku = thousand, and the count comes after it
  ("ẹgbẹ̀rún márùn-ún" = 5000, "dubu biyar" = 5000, "puku iri ise" = 50000).
- counterparty: the other person in a debt or repayment, or who sent income, e.g. "Mama Chidi".
- direction (log_debt and debt_paid only): owed_to_me (they owe or paid back the user) or i_owe (the user owes or paid back).
- category (log_expense and set_budget only; always give one for these): goods (anything bought to sell again: "for
  shop", "for my stall", "to sell"; food bought to resell is goods), business_costs (shop rent, wages, apprentice, fuel
  for the shop, transport for goods, tools, materials for work), or personal: food, transport, data_airtime, rent_bills,
  family, health, school, fun, clothing, savings, other. Use goods or business_costs only when the message says the
  spend is for the shop, stall, work, customers or selling.
- period (summary_query only): today, week or month.
- topic (ask_question only): one of separate_money, record_keeping, cash_flow, debt_recovery, credit_readiness, savings, pricing.
- question (ask_question only): the question, rewritten clearly in English.
- purpose (loan_intake only): what the loan is for, in English.
- correct_to (correct_last only): the right kind of record when the user says the kind was wrong, e.g. "no be sale,
  na expense" = log_expense; one of log_sale, log_expense, log_income, log_debt, debt_paid. Null if the kind was right.
  A correction can fix several things at once: amount_ngn, item, category, counterparty, direction and correct_to.
- language (set_language only): en (English or Pidgin), yo, ha or ig; null if they did not say which.
Several things of the same kind in one message (all bought, or all sold) are ONE record: item names them all and
amount_ngn is their total. Leave quantity and unit null then.
A voice note in Yoruba, Hausa or Igbo can come with a second line starting "English model heard:". It is the same
voice note transcribed by the English model, because people often say amounts in English inside another language.
Understand the message from the first line; take the amount from the second line.
Use null for anything not said. Never invent amounts."""

# Starts the second line of a voice note heard by the English model too (see ROUTER_SYSTEM).
EN_LINE = "English model heard: "


def router_input(text: str, en_text: str | None = None) -> str:
    return f"{text}\n{EN_LINE}{en_text}" if en_text else text


FEW_SHOT: list[tuple[Lang, str, dict]] = [
    ("en", "I sell three bags of rice seventy five thousand",
     {"intent": "log_sale", "item": "rice", "quantity": 3, "unit": "bags", "amount_ngn": 75000}),
    ("en", "I don buy fuel for generator 4500",
     {"intent": "log_expense", "item": "generator fuel", "amount_ngn": 4500, "category": "business_costs"}),
    ("en", "I buy two carton of Indomie for shop 18k",
     {"intent": "log_expense", "item": "Indomie", "quantity": 2, "unit": "cartons", "amount_ngn": 18000, "category": "goods"}),
    ("en", "I collect 8k for sewing Mama Tunde gown",
     {"intent": "log_sale", "item": "sewing", "amount_ngn": 8000, "counterparty": "Mama Tunde"}),
    ("en", "I buy data 1500",
     {"intent": "log_expense", "item": "data", "amount_ngn": 1500, "category": "data_airtime"}),
    ("en", "I chop rice and chicken 2,500 this afternoon",
     {"intent": "log_expense", "item": "rice and chicken", "amount_ngn": 2500, "category": "food"}),
    ("en", "I send my mama 10k",
     {"intent": "log_expense", "item": "money for mama", "amount_ngn": 10000, "category": "family"}),
    ("en", "I put 20k for my ajo",
     {"intent": "log_expense", "item": "ajo", "amount_ngn": 20000, "category": "savings"}),
    ("en", "my salary don enter, 150k",
     {"intent": "log_income", "item": "salary", "amount_ngn": 150000}),
    ("en", "My papa send me 20k for upkeep",
     {"intent": "log_income", "item": "upkeep", "amount_ngn": 20000, "counterparty": "Papa"}),
    ("en", "my food budget for this month na 40k",
     {"intent": "set_budget", "category": "food", "amount_ngn": 40000}),
    ("en", "Mama Chidi owe me five thousand naira",
     {"intent": "log_debt", "counterparty": "Mama Chidi", "amount_ngn": 5000, "direction": "owed_to_me"}),
    ("en", "I still owe Alhaji 20k for the goods wey I collect",
     {"intent": "log_debt", "counterparty": "Alhaji", "amount_ngn": 20000, "direction": "i_owe"}),
    ("en", "I get ten carton of Indomie remain",
     {"intent": "stock_update", "item": "Indomie", "quantity": 10, "unit": "cartons"}),
    ("en", "Iya Bisi still owe me 3k for pepper",
     {"intent": "log_debt", "counterparty": "Iya Bisi", "amount_ngn": 3000, "direction": "owed_to_me"}),
    ("en", "Emeka don pay me the 4k wey he owe",
     {"intent": "debt_paid", "counterparty": "Emeka", "amount_ngn": 4000, "direction": "owed_to_me"}),
    ("en", "I don pay Alhaji 10k out of the money I owe am",
     {"intent": "debt_paid", "counterparty": "Alhaji", "amount_ngn": 10000, "direction": "i_owe"}),
    ("en", "I lend my guy Tunde 5k",
     {"intent": "log_debt", "counterparty": "Tunde", "amount_ngn": 5000, "direction": "owed_to_me"}),
    ("en", "How much I don sell this week",
     {"intent": "summary_query", "period": "week"}),
    ("en", "where my money dey go this month",
     {"intent": "summary_query", "period": "month"}),
    ("en", "cancel that last one, e no correct",
     {"intent": "undo_last"}),
    ("en", "no be 5k, na 50k",
     {"intent": "correct_last", "amount_ngn": 50000}),
    ("en", "no, that one no be income. Na tithe I pay, 135,100",
     {"intent": "correct_last", "correct_to": "log_expense", "item": "tithe", "amount_ngn": 135100}),
    ("en", "e no be food, na transport",
     {"intent": "correct_last", "category": "transport"}),
    ("en", "na Emeka, no be Chidi. And e be 7k",
     {"intent": "correct_last", "counterparty": "Emeka", "amount_ngn": 7000}),
    ("en", "I no sell am, na money I collect from my sister",
     {"intent": "correct_last", "correct_to": "log_income", "counterparty": "sister"}),
    ("en", "I need loan of 200k to buy more goods",
     {"intent": "loan_intake", "amount_ngn": 200000, "purpose": "buy more goods"}),
    ("en", "I buy meat 9000, garri 1000 and pepper 200",
     {"intent": "log_expense", "item": "meat, garri, pepper", "amount_ngn": 10200, "category": "food"}),
    ("en", "I sell 2 crates of egg 9k and 3 tin milk 4500",
     {"intent": "log_sale", "item": "eggs, milk", "amount_ngn": 13500}),
    ("en", "How I go take save money when market slow",
     {"intent": "ask_question", "topic": "savings", "question": "How can I save money when sales are slow?"}),
    ("en", "how much I get left now",
     {"intent": "summary_query", "period": "month"}),
    ("en", "I buy underwear for me and my children 12,200",
     {"intent": "log_expense", "item": "underwear", "amount_ngn": 12200, "category": "clothing"}),
    ("en", "No, I said I paid for the cake, 15,000",
     {"intent": "correct_last", "correct_to": "log_expense", "item": "cake", "amount_ngn": 15000}),
    ("en", "please speak to me in English",
     {"intent": "set_language", "language": "en"}),
    ("en", "abeg change the language",
     {"intent": "set_language"}),
    # Yoruba (draft)
    ("yo", "Mo ta àpò ìrẹsì méjì ní 50,000 naira",
     {"intent": "log_sale", "item": "rice", "quantity": 2, "unit": "bags", "amount_ngn": 50000}),
    ("yo", "Mo ta ata ní ẹgbẹ̀rún márùn-ún naira",
     {"intent": "log_sale", "item": "pepper", "amount_ngn": 5000}),
    # code-mixed: Yoruba/Hausa/Igbo sentence with English goods and digits
    ("yo", "mo ra rice agolo kan 10,000",
     {"intent": "log_expense", "item": "rice", "quantity": 1, "unit": "agolo", "amount_ngn": 10000, "category": "food"}),
    ("yo", "mo ra ẹran 9000, gaàrí 1000, pọ̀nmọ̀ 200",
     {"intent": "log_expense", "item": "meat, garri, ponmo", "amount_ngn": 10200, "category": "food"}),
    # amounts said in English inside Yoruba: the Yoruba model turns them into sounds, the English model hears them
    ("yo", "mo ra oúnjẹ tó kú sí tàtíńtà-ọ̀sán-tún-tún-ọ̀dẹ̀\n" + EN_LINE + "more a wunje to cool see thirteen thousand two hundred",
     {"intent": "log_expense", "item": "food", "amount_ngn": 13200, "category": "food"}),
    ("yo", "Pa èyí tí mo sọ kẹ́yìn rẹ́",
     {"intent": "undo_last"}),
    ("yo", "Kì í ṣe owó tí mo gbà, owó tí mo ná ni, ẹgbẹ̀rún mẹ́wàá",
     {"intent": "correct_last", "correct_to": "log_expense", "amount_ngn": 10000}),
    ("yo", "Báwo ni mo ṣe lè fi owó pamọ́",
     {"intent": "ask_question", "topic": "savings", "question": "How can I save money?"}),
    ("yo", "mo ra kéèkì 5,000",
     {"intent": "log_expense", "item": "cake", "amount_ngn": 5000, "category": "food"}),
    # a Yoruba note the English model heard best: "mo wá tún ra" (I also bought) run together
    ("yo", "mowatunra puff puff, 1,500.",
     {"intent": "log_expense", "item": "puff puff", "amount_ngn": 1500, "category": "food"}),
    ("yo", "rárá o, mo ní mo ra búrẹ́dì 2,000",
     {"intent": "correct_last", "correct_to": "log_expense", "item": "bread", "amount_ngn": 2000}),
    ("yo", "Èló ló kù lọ́wọ́ mi ní oṣù yìí",
     {"intent": "summary_query", "period": "month"}),
    ("yo", "Ẹ máa bá mi sọ̀rọ̀ ní Yorùbá",
     {"intent": "set_language", "language": "yo"}),
    # Hausa (draft)
    ("ha", "Na sayar da buhun shinkafa uku naira dubu saba'in da biyar",
     {"intent": "log_sale", "item": "rice", "quantity": 3, "unit": "bags", "amount_ngn": 75000}),
    ("ha", "Ina bin Musa bashin naira dubu biyar",
     {"intent": "log_debt", "counterparty": "Musa", "amount_ngn": 5000, "direction": "owed_to_me"}),
    ("ha", "Musa ya biya ni dubu biyar",
     {"intent": "debt_paid", "counterparty": "Musa", "amount_ngn": 5000, "direction": "owed_to_me"}),
    ("ha", "Ba dubu biyar ba ne, dubu hamsin ne",
     {"intent": "correct_last", "amount_ngn": 50000}),
    ("ha", "Na sayar da rice bags biyu 50k",
     {"intent": "log_sale", "item": "rice", "quantity": 2, "unit": "bags", "amount_ngn": 50000}),
    # Igbo (draft)
    ("ig", "Erere m akpa osikapa abụọ, puku naira iri ise",
     {"intent": "log_sale", "item": "rice", "quantity": 2, "unit": "bags", "amount_ngn": 50000}),
    ("ig", "Azụrụ m tomatoes basket otu maka ahịa m 15,000",
     {"intent": "log_expense", "item": "tomatoes", "quantity": 1, "unit": "basket", "amount_ngn": 15000, "category": "goods"}),
    ("ig", "Kedụ ka m ga-esi chekwaa ego",
     {"intent": "ask_question", "topic": "savings", "question": "How can I save money?"}),
    ("en", "Good morning o",
     {"intent": "greeting"}),
]


# The language goes in each message, not the system prompt: llama.cpp reuses the cached prompt only up to the first
# token that differs, so a language in the system prompt made every switch of language re-read all ~4k tokens of
# examples (route took 6-7 s instead of 1.5-2.5 s on the pilot's mixed-language traffic).
LANG_TAGS: dict[Lang, str] = {"en": "English", "yo": "Yoruba", "ha": "Hausa", "ig": "Igbo"}


def tagged(text: str, lang: Lang) -> str:
    return f"[{LANG_TAGS[lang]}] {text}"


def route_messages(text: str, lang: Lang, today: str) -> list[dict]:
    """`text` as router_input() builds it; `lang` is the user's chosen language."""
    messages = [{"role": "system", "content": ROUTER_SYSTEM.format(today=today)}]
    for ex_lang, user, out in FEW_SHOT:
        messages.append({"role": "user", "content": tagged(user, ex_lang)})
        messages.append({"role": "assistant", "content": json.dumps(out, ensure_ascii=False)})
    messages.append({"role": "user", "content": tagged(text, lang)})
    return messages


ADAPT_SYSTEM = """You are Sọ̀rọ̀'s money tutor for people in Nigeria: traders, artisans, workers and students. Your answer will be read aloud as a WhatsApp voice note.
Answer the user's question using ONLY the advice in the TIP below. Do not add new facts, numbers, products, banks, apps or investment advice.
Write in {lang_name}. Use at most 3 short sentences and simple everyday words. No lists, no emoji.

TIP: {tip}"""


def adapt_messages(tip: str, question: str, lang: Lang) -> list[dict]:
    return [
        {"role": "system", "content": ADAPT_SYSTEM.format(lang_name=LANG_NAMES[lang], tip=tip)},
        {"role": "user", "content": question},
    ]


TRANSLATE_SYSTEM = """Translate the user's text from English into {lang_name} for people in Nigeria: traders, artisans, workers and students.
Use simple, natural, everyday words, not formal or literary language.
Keep these exactly as they are: anything in curly braces like {{amount}}, emoji, line breaks, URLs, numbers, the words Sọ̀rọ̀, N-ATLaS, HELP, LANGUAGE, UNDO, SHARE and DELETE.
Output only the translation."""


def translate_messages(text: str, target: Lang) -> list[dict]:
    return [
        {"role": "system", "content": TRANSLATE_SYSTEM.format(lang_name=LANG_NAMES[target])},
        {"role": "user", "content": text},
    ]
