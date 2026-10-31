"""Date normalisation: free text -> DateFact dict (UTC ISO + original text + honesty flags).

Decisions (documented because they are judgement calls):
  * A numeric date such as ``03/04/2026`` that could be day/month or month/day is NEVER guessed when
    ``dayfirst`` is not given: ``value=None, ambiguous=True, status='could_not_verify'`` and the note
    lists both readings. When the caller passes ``dayfirst`` (e.g. from a per-source setting) we use it.
  * Two-digit years (``20-Oct-26``) are read as 20xx but flagged ``ambiguous=True`` with a note.
  * A date with no stated time has ``precision='date'`` and its value is 00:00 in the stated timezone,
    else in ``default_tz``, else UTC. ``timezone`` only ever holds a zone *stated in the text*.
  * Impossible dates (31/02/2026, 25:00) -> ``could_not_verify``. Year-less dates are not guessed.
  * Never raises. ``now`` is accepted for API stability and is deliberately unused: we never infer
    a missing year from the clock.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

_MONTHS = {
    m: i + 1
    for i, names in enumerate(
        [
            ("jan", "january"),
            ("feb", "february"),
            ("mar", "march"),
            ("apr", "april"),
            ("may",),
            ("jun", "june"),
            ("jul", "july"),
            ("aug", "august"),
            ("sep", "sept", "september"),
            ("oct", "october"),
            ("nov", "november"),
            ("dec", "december"),
        ]
    )
    for m in names
}

# Abbreviations that are unambiguous enough for tender notices. IST/CST/BST are deliberately absent.
_TZ_ABBR = {
    "Z": 0, "UTC": 0, "GMT": 0, "WET": 0,
    "CAT": 2, "SAST": 2, "EET": 2, "EAT": 3, "WAT": 1, "CET": 1, "MSK": 3,
}  # fmt: skip

_UNPUBLISHED = re.compile(
    r"^\s*(?:n\s*/\s*a|na|nil|none|null|tbd|tba|to be (?:determined|advised|announced)|"
    r"refer(?:\s+to)?\s+(?:the\s+)?(?:tender\s+)?docs?(?:uments?)?|see\s+(?:tender\s+)?documents?|"
    r"as per (?:the )?(?:tender )?documents?|not (?:available|published|stated|specified)|-+|\.+)\s*$",
    re.IGNORECASE,
)

_TZ_RE = re.compile(
    r"""(?:\(\s*)?\b(?P<name>GMT|UTC)\s*(?P<sign>[+\-−])\s*(?P<h>\d{1,2})(?::?(?P<m>\d{2}))?\b(?:\s*\))?
        |(?:\(\s*)?(?P<abbr>(?<![A-Za-z])(?:UTC|GMT|CAT|SAST|EET|EAT|WAT|CET|WET|MSK)(?![A-Za-z]))(?:\s*\))?""",
    re.VERBOSE,
)
_TRAILING_OFFSET_RE = re.compile(
    r"(?<=\d)\s*(?P<z>Z)\b|(?P<sign>[+\-])(?P<h>\d{2}):?(?P<m>\d{2})\s*$"
)

_TIME_RE = re.compile(
    r"(?<![\d/.\-])(?P<h>\d{1,2})\s*(?:[:.h]\s*(?P<m>\d{2}))?(?:[:.](?P<s>\d{2}))?\s*"
    r"(?P<ap>a\.?m\.?|p\.?m\.?)?(?:\s*hrs?\.?)?(?![\d/])",
    re.IGNORECASE,
)


def _empty(text: str | None, evidence: list[dict[str, Any]] | None) -> dict[str, Any]:
    return {
        "value": None,
        "originalText": text,
        "timezone": None,
        "precision": None,
        "ambiguous": False,
        "status": "not_published",
        "evidence": list(evidence or []),
        "note": None,
    }


def _fail(fact: dict[str, Any], note: str, *, ambiguous: bool = False) -> dict[str, Any]:
    fact["status"] = "could_not_verify"
    fact["ambiguous"] = ambiguous
    fact["value"] = None
    fact["note"] = note
    return fact


def _tz_from_text(text: str) -> tuple[str | None, timezone | None, str]:
    """Return (label as stated, tzinfo, text with the zone removed)."""
    m = _TZ_RE.search(text)
    if m:
        if m.group("abbr"):
            label = m.group("abbr")
            tz = timezone(timedelta(hours=_TZ_ABBR[label.upper()]))
        else:
            sign = -1 if m.group("sign") in "-−" else 1
            h, mi = int(m.group("h")), int(m.group("m") or 0)
            if h > 14 or mi > 59:
                return None, None, text
            tz = timezone(sign * timedelta(hours=h, minutes=mi))
            label = m.group(0).strip("() ").strip()
        return label, tz, (text[: m.start()] + " " + text[m.end() :]).strip()
    m = _TRAILING_OFFSET_RE.search(text)
    if m:
        if m.group("z"):
            return "Z", UTC, (text[: m.start()] + text[m.end() :]).strip()
        sign = -1 if m.group("sign") == "-" else 1
        h, mi = int(m.group("h")), int(m.group("m"))
        if h <= 14 and mi <= 59:
            label = f"{m.group('sign')}{m.group('h')}:{m.group('m')}"
            return label, timezone(sign * timedelta(hours=h, minutes=mi)), text[: m.start()].strip()
    return None, None, text


def _parse_time(rest: str) -> tuple[tuple[int, int, int] | None, bool]:
    """Return ((h, m, s) or None, valid). A time that is present but impossible -> (None, False)."""
    rest = rest.strip(" ,;@-–at")
    if not rest:
        return None, True
    rest = re.sub(r"^(?:at|@|,|;|-|–)\s*", "", rest.strip(), flags=re.IGNORECASE).strip()
    if not rest:
        return None, True
    m = _TIME_RE.fullmatch(rest)
    if not m:
        return None, False
    h = int(m.group("h"))
    mi = int(m.group("m") or 0)
    s = int(m.group("s") or 0)
    ap = (m.group("ap") or "").lower().replace(".", "")
    if m.group("m") is None and not ap and not re.search(r"h", rest, re.IGNORECASE):
        return None, False  # a bare number is not a time
    if ap:
        if not 1 <= h <= 12:
            return None, False
        h = h % 12 + (12 if ap == "pm" else 0)
    if h > 23 or mi > 59 or s > 59:
        return None, False
    return (h, mi, s), True


def _resolve_default(default_tz: str | None) -> Any:
    if not default_tz:
        return UTC
    try:
        return ZoneInfo(default_tz)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return None


_ISO_RE = re.compile(r"^(?P<y>\d{4})-(?P<mo>\d{1,2})-(?P<d>\d{1,2})(?:[T\s]+(?P<rest>.*))?$")
_NUM_RE = re.compile(
    r"^(?P<a>\d{1,2})\s*[/.\-]\s*(?P<b>\d{1,2})\s*[/.\-]\s*(?P<y>\d{4}|\d{2})(?!\d)(?P<rest>.*)$"
)
_DMY_TEXT_RE = re.compile(
    r"^(?P<d>\d{1,2})(?:st|nd|rd|th)?[\s\-/.]*(?:of\s+)?(?P<mon>[A-Za-z]{3,9})\.?[\s\-/.,]*"
    r"(?P<y>\d{4}|\d{2})?(?!\d)(?P<rest>.*)$"
)
_MDY_TEXT_RE = re.compile(
    r"^(?P<mon>[A-Za-z]{3,9})\.?\s+(?P<d>\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(?P<y>\d{4}|\d{2})?(?!\d)(?P<rest>.*)$"
)


def parse_date(
    text: str | None,
    *,
    default_tz: str | None = None,
    dayfirst: bool | None = None,
    now: datetime | None = None,
    evidence: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Parse a published date string into a DateFact dict. Never raises."""
    try:
        return _parse(text, default_tz, dayfirst, evidence)
    except Exception as exc:  # noqa: BLE001 - garbage in must never crash a scan
        fact = _empty(text if isinstance(text, str) else None, evidence)
        return _fail(fact, f"Unparseable date ({type(exc).__name__}).")


def _parse(
    text: str | None,
    default_tz: str | None,
    dayfirst: bool | None,
    evidence: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    fact = _empty(text if isinstance(text, str) else None, evidence)
    if not isinstance(text, str) or not text.strip() or _UNPUBLISHED.match(text):
        return fact
    work = re.sub(r"[\s ]+", " ", text).strip()
    work = re.sub(
        r"^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+",
        "",
        work,
        flags=re.IGNORECASE,
    )

    label, tz, work = _tz_from_text(work)
    fact["timezone"] = label
    work = work.strip(" ,;()")

    day = month = year = None
    rest = ""
    notes: list[str] = []
    ambiguous = False

    if m := _ISO_RE.match(work):
        year, month, day = int(m["y"]), int(m["mo"]), int(m["d"])
        rest = (m["rest"] or "").strip()
        rest = re.sub(r"\.\d+", "", rest)  # fractional seconds
    elif m := _NUM_RE.match(work):
        a, b, ys = int(m["a"]), int(m["b"]), m["y"]
        rest = m["rest"]
        year = int(ys)
        if len(ys) == 2:
            year += 2000
            ambiguous = True
            notes.append(f"Two-digit year '{ys}' read as {year}.")
        if dayfirst is None:
            if a > 12 and b <= 12:
                day, month = a, b
            elif b > 12 and a <= 12:
                month, day = a, b
            elif a == b:
                day, month = a, b
            elif a <= 12 and b <= 12:
                return _fail(
                    fact,
                    f"Ambiguous: could be day {a} month {b} (D/M) or month {a} day {b} (M/D); "
                    "no day-first hint available, so no date was chosen.",
                    ambiguous=True,
                )
            else:
                return _fail(fact, "Impossible date: both parts exceed 12 and 31.")
        elif dayfirst:
            day, month = a, b
        else:
            month, day = a, b
        if dayfirst is not None and a <= 12 and b <= 12 and a != b:
            notes.append(f"Read {'day-first' if dayfirst else 'month-first'} per source setting.")
    elif (
        (m := _DMY_TEXT_RE.match(work))
        and m["mon"].lower() in _MONTHS
        or (m := _MDY_TEXT_RE.match(work))
        and m["mon"].lower() in _MONTHS
    ):
        day, month = int(m["d"]), _MONTHS[m["mon"].lower()]
        rest = m["rest"]
        ys = m["y"]
        if ys is None:
            return _fail(fact, "No year stated; a year was not guessed.", ambiguous=True)
        year = int(ys)
        if len(ys) == 2:
            year += 2000
            ambiguous = True
            notes.append(f"Two-digit year '{ys}' read as {year}.")
    else:
        return _fail(fact, "Date format not recognised.")

    assert year is not None and month is not None and day is not None
    try:
        datetime(year, month, day)
    except ValueError:
        return _fail(fact, f"Impossible calendar date (day {day}, month {month}, year {year}).")

    tparts, ok = _parse_time(rest)
    if not ok:
        return _fail(fact, f"Date found but the time part '{rest.strip()}' could not be read.")

    if tz is None:
        zone = _resolve_default(default_tz)
        if zone is None:
            return _fail(fact, f"Unknown default timezone '{default_tz}'.")
        tz = zone
    h, mi, s = tparts if tparts else (0, 0, 0)
    local = datetime(year, month, day, h, mi, s, tzinfo=tz)
    utc = local.astimezone(UTC)
    fact["value"] = utc.strftime("%Y-%m-%dT%H:%M:%SZ")
    fact["precision"] = "datetime" if tparts else "date"
    fact["status"] = "published"
    fact["ambiguous"] = ambiguous
    if label is None and tparts and default_tz:
        notes.append(f"No timezone stated; assumed {default_tz}.")
    elif label is None and tparts:
        notes.append("No timezone stated; assumed UTC.")
    fact["note"] = " ".join(notes) or None
    return fact


def _epoch(date_fact: dict[str, Any]) -> float | None:
    v = date_fact.get("value") if isinstance(date_fact, dict) else None
    if not isinstance(v, str):
        return None
    try:
        return datetime.fromisoformat(v).timestamp()
    except ValueError:
        return None


def sort_key(date_fact: dict[str, Any], *, descending: bool = False) -> tuple[int, float]:
    """Sort key where unknown dates sort LAST in both directions.

    ``sorted(facts, key=lambda f: sort_key(f))`` -> earliest first, unknown last;
    ``sort_key(f, descending=True)`` -> latest first, unknown still last.
    """
    ts = _epoch(date_fact)
    if ts is None:
        return (1, 0.0)
    return (0, -ts if descending else ts)
