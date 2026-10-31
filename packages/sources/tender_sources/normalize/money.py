"""Money normalisation: text -> MoneyFact dict, plus value-label classification.

Decisions:
  * ``amount`` is ``None`` whenever it cannot be known. It is never ``0`` unless the text literally
    publishes a zero amount (then the note says so). "Free" is NOT converted to 0.
  * ``currency`` is set only from an unambiguous ISO 4217 code (``ZMW``, ``USD``, ``US$``) or an
    unambiguous symbol (euro, pound). ``$``, ``K``, ``ZK``, ``Rs``, ``kr`` and yen/yuan signs are
    ambiguous: the symbol stays in ``originalText`` and ``currency`` stays ``None``. A caller-supplied
    ``currency_hint`` (e.g. from a separate "Currency" column) is used only if the text itself names
    no currency, and the note says where it came from.
  * Ranges ("USD 100-200"), several different amounts, and negative numbers give ``amount=None``.
  * ``1.200`` (one dot, exactly three digits) is ambiguous between 1.2 and 1200 and is not guessed.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any

_ISO = frozenset(
    [
        "USD",
        "EUR",
        "GBP",
        "JPY",
        "CNY",
        "INR",
        "AED",
        "SAR",
        "CHF",
        "CAD",
        "AUD",
        "NZD",
        "SEK",
        "NOK",
        "DKK",
        "PLN",
        "CZK",
        "TRY",
        "RUB",
        "BRL",
        "MXN",
        "KRW",
        "SGD",
        "HKD",
        "THB",
        "MYR",
        "IDR",
        "PHP",
        "VND",
        "PKR",
        "BDT",
        "LKR",
        "NPR",
        "ZMW",
        "ZAR",
        "KES",
        "UGX",
        "TZS",
        "RWF",
        "ETB",
        "NGN",
        "GHS",
        "MWK",
        "BWP",
        "NAD",
        "MZN",
        "AOA",
        "XOF",
        "XAF",
        "EGP",
        "MAD",
        "DZD",
        "TND",
        "SDG",
        "SSP",
        "SOS",
        "DJF",
        "ERN",
        "LSL",
        "SZL",
        "MUR",
        "SCR",
        "ZWL",
        "ZWG",
        "CDF",
        "BIF",
        "GMD",
        "GNF",
        "LRD",
        "SLE",
        "SLL",
        "CVE",
        "MGA",
        "KMF",
        "MRU",
        "LYD",
        "STN",
    ]
)
_SYMBOLS = {"€": "EUR", "£": "GBP"}
_AMBIGUOUS_SYMBOLS = ("$", "K", "ZK", "Rs", "Rs.", "kr", "¥", "₹", "R")

_UNKNOWN = re.compile(
    r"^\s*(?:n\s*/\s*a|na|nil|none|tbd|tba|free(?:\s+of\s+charge)?|no\s+(?:fee|charge|cost)|"
    r"refer(?:\s+to)?\s+(?:the\s+)?(?:tender\s+|bidding\s+|bid\s+)?docs?(?:uments?)?|"
    r"see\s+(?:the\s+)?(?:tender\s+|bidding\s+)?documents?|as\s+per\s+(?:the\s+)?(?:tender\s+|bidding\s+)?documents?|"
    r"as\s+(?:stated|specified|indicated)\s+in\s+.*|not\s+(?:available|published|stated|specified|disclosed)|"
    r"confidential|undisclosed|-+|\.+)\s*$",
    re.IGNORECASE,
)
_NUM = re.compile(r"(?<![\w.,])\d[\d,.  ']*")
_MULT = re.compile(r"^\s*(million|mln|mn|billion|bn|thousand)\b", re.IGNORECASE)
_MULTIPLIER = {
    "million": 10**6,
    "mln": 10**6,
    "mn": 10**6,
    "billion": 10**9,
    "bn": 10**9,
    "thousand": 10**3,
}
_RANGE_SEP = re.compile(r"^\s*(?:-|–|—|to|and|/)\s*$", re.IGNORECASE)


def _blank(text: str | None, evidence: list[dict[str, Any]] | None) -> dict[str, Any]:
    return {
        "amount": None,
        "currency": None,
        "originalText": text if isinstance(text, str) else None,
        "status": "not_published",
        "evidence": list(evidence or []),
        "note": None,
    }


def _to_decimal(token: str) -> tuple[Decimal | None, str | None]:
    """Parse one numeric token with locale-agnostic separators. Returns (value, problem)."""
    tok = token.strip(".,'   ").replace(" ", "").replace(" ", "").replace("'", "")
    if not tok:
        return None, "no digits"
    has_c, has_d = "," in tok, "." in tok
    try:
        if has_c and has_d:
            dec_sep = "," if tok.rfind(",") > tok.rfind(".") else "."
            grp = "." if dec_sep == "," else ","
            if tok.count(dec_sep) > 1:
                return None, "malformed number"
            norm = tok.replace(grp, "").replace(dec_sep, ".")
        elif has_c:
            if re.fullmatch(r"\d{1,3}(?:,\d{3})+", tok):
                norm = tok.replace(",", "")
            elif re.fullmatch(r"\d+,\d{1,2}", tok):
                norm = tok.replace(",", ".")
            else:
                return None, "malformed number"
        elif has_d:
            if tok.count(".") > 1:
                if re.fullmatch(r"\d{1,3}(?:\.\d{3})+", tok):
                    norm = tok.replace(".", "")
                else:
                    return None, "malformed number"
            elif re.fullmatch(r"\d{1,3}\.\d{3}", tok):
                return None, f"'{tok}' is ambiguous (decimal {tok} or thousands separator)"
            else:
                norm = tok
        else:
            norm = tok
        return Decimal(norm), None
    except InvalidOperation:
        return None, "malformed number"


def _find_currency(text: str, hint: str | None) -> tuple[str | None, str | None]:
    codes: list[str] = []
    for m in re.finditer(r"(?<![A-Za-z])([A-Z]{3})(?![A-Za-z])", text):
        if m.group(1) in _ISO:
            codes.append(m.group(1))
    if re.search(r"US\s?\$", text):
        codes.append("USD")
    for sym, code in _SYMBOLS.items():
        if sym in text:
            codes.append(code)
    uniq = list(dict.fromkeys(codes))
    if len(uniq) > 1:
        return None, f"Several currencies named ({', '.join(uniq)}); not chosen."
    if uniq:
        return uniq[0], None
    if hint:
        return (
            hint.upper(),
            "Currency taken from a separate source field, not from the amount text.",
        )
    return None, None


def parse_money(
    text: str | None,
    *,
    currency_hint: str | None = None,
    evidence: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Parse a published money string into a MoneyFact dict. Never raises."""
    try:
        return _parse(text, currency_hint, evidence)
    except Exception as exc:  # noqa: BLE001
        fact = _blank(text, evidence)
        fact.update(status="could_not_verify", note=f"Unparseable amount ({type(exc).__name__}).")
        return fact


def _parse(
    text: str | None, hint: str | None, evidence: list[dict[str, Any]] | None
) -> dict[str, Any]:
    fact = _blank(text, evidence)
    if not isinstance(text, str) or not text.strip():
        return fact
    if _UNKNOWN.match(text):
        if re.match(r"^\s*(free|no\s+(fee|charge|cost))", text, re.IGNORECASE):
            fact["note"] = "Source says free / no charge; recorded as unknown amount, NOT as 0."
        return fact

    def fail(note: str) -> dict[str, Any]:
        fact["status"] = "could_not_verify"
        fact["note"] = note
        return fact

    currency, cnote = _find_currency(text, hint)
    if cnote and currency is None:
        return fail(cnote)
    nums = list(_NUM.finditer(text))
    if not nums:
        return fail("No number found in the amount text.")
    neg = re.search(r"(?:^|[\s:A-Za-z$€£])[-−]\s*\d|\(\s*[A-Z$€£ ]*\d[\d,.]*\s*\)", text)
    first = nums[0]
    if len(nums) == 2 and _RANGE_SEP.match(text[first.end() : nums[1].start()].replace(" ", " ")):
        return fail("Amount is a range; no single value recorded.")
    if len(nums) > 1:
        return fail("Several amounts in one text; no single value recorded.")
    if neg:
        return fail("Negative amount is not a valid tender value; not recorded.")
    value, problem = _to_decimal(first.group(0))
    if value is None:
        return fail(f"Could not read the number: {problem}.")
    mm = _MULT.match(text[first.end() :])
    if mm:
        value = value * _MULTIPLIER[mm.group(1).lower()]
    note_parts: list[str] = []
    if cnote:
        note_parts.append(cnote)
    if currency is None:
        sym = next(
            (
                s
                for s in _AMBIGUOUS_SYMBOLS
                if re.search(rf"(?<![A-Za-z]){re.escape(s)}\s*\d", text)
            ),
            None,
        )
        if sym:
            note_parts.append(f"Symbol '{sym}' is ambiguous; currency not assumed.")
    if value == 0:
        note_parts.append("Source literally publishes a zero amount.")
    fact["amount"] = float(value)
    fact["currency"] = currency
    fact["status"] = "published"
    fact["note"] = " ".join(note_parts) or None
    return fact


_LABEL_RULES: list[tuple[str, re.Pattern[str]]] = [
    (
        "bid_security",
        re.compile(
            r"\b(bid|tender|bidding|proposal)\s+(security|bond|guarantee|surety|securing)\b|"
            r"\bemd\b|\bearnest\s+money\b|\bbid\s+bond\b"
        ),
    ),
    (
        "tender_fee",
        re.compile(
            r"\b(tender|document|bidding\s+document|bid\s+document|tender\s+document|participation)s?\s+(fee|price|charge)s?\b|"
            r"\bcost\s+of\s+(the\s+)?(bidding|bid|tender|rfp|rfq)\s+documents?\b|"
            r"\b(purchase|price)\s+of\s+(the\s+)?(bidding|bid|tender)\s+documents?\b|\bfee\s+for\s+(bidding|tender)\s+documents?\b"
        ),
    ),
    (
        "award",
        re.compile(
            r"\bcontract\s+(price|value|amount|sum)\b|\bsigned\s+contract\b|\baward(ed)?\s+(value|amount|price|sum)?\b|"
            r"\bawarded\b|\bevaluated\s+(bid\s+)?price\b|\bwinning\s+(bid|price)\b|\bsuccessful\s+bid"
        ),
    ),
    (
        "estimated",
        re.compile(
            r"\bestimate[ds]?\b|\bengineers?\s+estimate\b|\bbudget(ed)?\b|\bindicative\s+(value|price)\b|"
            r"\bapproximate\s+(value|cost)\b"
        ),
    ),
]


def classify_value_label(label: str) -> str | None:
    """Map a label ("Tender fee", "Bid security", ...) to one of four separate value categories."""
    if not isinstance(label, str):
        return None
    norm = re.sub(r"['’`]", "", label.lower())
    norm = re.sub(r"[^a-z0-9 ]+", " ", norm)
    norm = re.sub(r"\s+", " ", norm).strip()
    for kind, pat in _LABEL_RULES:
        if pat.search(norm):
            return kind
    return None
