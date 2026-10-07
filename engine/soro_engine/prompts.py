"""Prompts for N-ATLaS. Router output is constrained to ROUTER_SCHEMA by llama.cpp's JSON grammar.

The yo/ha/ig few-shot examples are first drafts: have a native speaker check them
and swap in real phrasings from users' voice notes.
"""

from __future__ import annotations

import json

from .config import LANG_NAMES, Lang

INTENTS = [
    "log_sale", "log_expense", "log_income", "log_debt", "debt_paid", "stock_update", "summary_query",
    "set_budget", "undo_last", "correct_last", "loan_intake", "ask_question", "greeting", "help", "unknown",
]
TOPICS = ["separate_money", "record_keeping", "cash_flow", "debt_recovery", "credit_readiness", "savings", "pricing"]
# "goods" and "business_costs" are business spending; the rest are personal.
CATEGORIES = [
    "goods", "business_costs", "food", "transport", "data_airtime", "rent_bills", "family",
    "health", "school", "fun", "clothing", "savings", "other",
]

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


def tidy_route(result: dict) -> dict:
    """Keep "category" only on intents that use it, and only if it is a known one."""
    if result.get("category") is not None and (
        result.get("intent") not in CATEGORY_INTENTS or result["category"] not in CATEGORIES
    ):
        return {**result, "category": None}
    return result


def needs_category(result: dict) -> bool:
    return result.get("intent") in CATEGORY_INTENTS and result.get("category") is None


ROUTER_SYSTEM = """You are the message router for SoroEngine, a WhatsApp money-records and money-tips assistant for people in Nigeria:
market traders, artisans and other small businesses, and also workers and students tracking their personal money.
Today is {today}. The user speaks {lang_name}; the message may also mix English, Pidgin, Yoruba, Hausa or Igbo.
Messages are often voice-note transcripts, so expect missing punctuation and spelling mistakes.

Return ONE JSON object. Fields:
- intent:
  log_sale (user sold goods or was paid for their work or service),
  log_expense (user spent money: goods to resell, business costs, or personal spending like food, data, transport),
  log_income (personal money received that is not a sale: salary, allowance, money someone sent, gift),
  log_debt (someone owes the user, or the user owes someone; also money lent or borrowed),
  debt_paid (a debt was paid back, either to the user or by the user),
  stock_update (how many goods are left in the shop, a count),
  summary_query (asks how much they sold/spent/earned, profit, who owes them, where their money went),
  set_budget (sets a spending limit for a category, per month),
  undo_last (cancel or remove the last thing recorded),
  correct_last (the last record had a wrong amount; amount_ngn is the right one),
  loan_intake (wants a loan or credit),
  ask_question (any question about money, saving, budgeting, pricing, debt, records, loans), greeting, help, unknown.
- item, quantity, unit: the goods or thing, e.g. item "rice", quantity 3, unit "bags".
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
Use null for anything not said. Never invent amounts."""

FEW_SHOT: list[tuple[str, dict]] = [
    ("I sell three bags of rice seventy five thousand",
     {"intent": "log_sale", "item": "rice", "quantity": 3, "unit": "bags", "amount_ngn": 75000}),
    ("I don buy fuel for generator 4500",
     {"intent": "log_expense", "item": "generator fuel", "amount_ngn": 4500, "category": "business_costs"}),
    ("I buy two carton of Indomie for shop 18k",
     {"intent": "log_expense", "item": "Indomie", "quantity": 2, "unit": "cartons", "amount_ngn": 18000, "category": "goods"}),
    ("I collect 8k for sewing Mama Tunde gown",
     {"intent": "log_sale", "item": "sewing", "amount_ngn": 8000, "counterparty": "Mama Tunde"}),
    ("I buy data 1500",
     {"intent": "log_expense", "item": "data", "amount_ngn": 1500, "category": "data_airtime"}),
    ("I chop rice and chicken 2,500 this afternoon",
     {"intent": "log_expense", "item": "rice and chicken", "amount_ngn": 2500, "category": "food"}),
    ("I send my mama 10k",
     {"intent": "log_expense", "item": "money for mama", "amount_ngn": 10000, "category": "family"}),
    ("I put 20k for my ajo",
     {"intent": "log_expense", "item": "ajo", "amount_ngn": 20000, "category": "savings"}),
    ("my salary don enter, 150k",
     {"intent": "log_income", "item": "salary", "amount_ngn": 150000}),
    ("My papa send me 20k for upkeep",
     {"intent": "log_income", "item": "upkeep", "amount_ngn": 20000, "counterparty": "Papa"}),
    ("my food budget for this month na 40k",
     {"intent": "set_budget", "category": "food", "amount_ngn": 40000}),
    ("Mama Chidi owe me five thousand naira",
     {"intent": "log_debt", "counterparty": "Mama Chidi", "amount_ngn": 5000, "direction": "owed_to_me"}),
    ("I still owe Alhaji 20k for the goods wey I collect",
     {"intent": "log_debt", "counterparty": "Alhaji", "amount_ngn": 20000, "direction": "i_owe"}),
    ("I get ten carton of Indomie remain",
     {"intent": "stock_update", "item": "Indomie", "quantity": 10, "unit": "cartons"}),
    ("Iya Bisi still owe me 3k for pepper",
     {"intent": "log_debt", "counterparty": "Iya Bisi", "amount_ngn": 3000, "direction": "owed_to_me"}),
    ("Emeka don pay me the 4k wey he owe",
     {"intent": "debt_paid", "counterparty": "Emeka", "amount_ngn": 4000, "direction": "owed_to_me"}),
    ("I don pay Alhaji 10k out of the money I owe am",
     {"intent": "debt_paid", "counterparty": "Alhaji", "amount_ngn": 10000, "direction": "i_owe"}),
    ("I lend my guy Tunde 5k",
     {"intent": "log_debt", "counterparty": "Tunde", "amount_ngn": 5000, "direction": "owed_to_me"}),
    ("How much I don sell this week",
     {"intent": "summary_query", "period": "week"}),
    ("where my money dey go this month",
     {"intent": "summary_query", "period": "month"}),
    ("cancel that last one, e no correct",
     {"intent": "undo_last"}),
    ("no be 5k, na 50k",
     {"intent": "correct_last", "amount_ngn": 50000}),
    ("I need loan of 200k to buy more goods",
     {"intent": "loan_intake", "amount_ngn": 200000, "purpose": "buy more goods"}),
    ("How I go take save money when market slow",
     {"intent": "ask_question", "topic": "savings", "question": "How can I save money when sales are slow?"}),
    # Yoruba (draft)
    ("Mo ta àpò ìrẹsì méjì ní 50,000 naira",
     {"intent": "log_sale", "item": "rice", "quantity": 2, "unit": "bags", "amount_ngn": 50000}),
    ("Mo ta ata ní ẹgbẹ̀rún márùn-ún naira",
     {"intent": "log_sale", "item": "pepper", "amount_ngn": 5000}),
    # code-mixed: Yoruba/Hausa/Igbo sentence with English goods and digits
    ("mo ra rice agolo kan 10,000",
     {"intent": "log_expense", "item": "rice", "quantity": 1, "unit": "agolo", "amount_ngn": 10000, "category": "food"}),
    ("Pa èyí tí mo sọ kẹ́yìn rẹ́",
     {"intent": "undo_last"}),
    ("Báwo ni mo ṣe lè fi owó pamọ́",
     {"intent": "ask_question", "topic": "savings", "question": "How can I save money?"}),
    # Hausa (draft)
    ("Na sayar da buhun shinkafa uku naira dubu saba'in da biyar",
     {"intent": "log_sale", "item": "rice", "quantity": 3, "unit": "bags", "amount_ngn": 75000}),
    ("Ina bin Musa bashin naira dubu biyar",
     {"intent": "log_debt", "counterparty": "Musa", "amount_ngn": 5000, "direction": "owed_to_me"}),
    ("Musa ya biya ni dubu biyar",
     {"intent": "debt_paid", "counterparty": "Musa", "amount_ngn": 5000, "direction": "owed_to_me"}),
    ("Na sayar da rice bags biyu 50k",
     {"intent": "log_sale", "item": "rice", "quantity": 2, "unit": "bags", "amount_ngn": 50000}),
    # Igbo (draft)
    ("Erere m akpa osikapa abụọ, puku naira iri ise",
     {"intent": "log_sale", "item": "rice", "quantity": 2, "unit": "bags", "amount_ngn": 50000}),
    ("Azụrụ m tomatoes basket otu maka ahịa m 15,000",
     {"intent": "log_expense", "item": "tomatoes", "quantity": 1, "unit": "basket", "amount_ngn": 15000, "category": "goods"}),
    ("Kedụ ka m ga-esi chekwaa ego",
     {"intent": "ask_question", "topic": "savings", "question": "How can I save money?"}),
    ("Good morning o",
     {"intent": "greeting"}),
]


def route_messages(text: str, lang: Lang, today: str) -> list[dict]:
    messages = [{"role": "system", "content": ROUTER_SYSTEM.format(today=today, lang_name=LANG_NAMES[lang])}]
    for user, out in FEW_SHOT:
        messages.append({"role": "user", "content": user})
        messages.append({"role": "assistant", "content": json.dumps(out, ensure_ascii=False)})
    messages.append({"role": "user", "content": text})
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
