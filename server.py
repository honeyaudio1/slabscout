"""SlabScout - trading card price guide, scanner and collection tracker.

Run:  .venv/bin/python server.py      then open http://localhost:8765

Optional keys in a .env file next to this script:
  ANTHROPIC_API_KEY=...        enables card scanning (photo -> card + set)
  COMPSAPI_KEY=...             real eBay sold listings for every card, and sports card lookups (compsapi.com)
  PRICECHARTING_TOKEN=...      real graded + ungraded values (paid PriceCharting API subscription)
  EBAY_CLIENT_ID=...           enables real eBay sold listings
  EBAY_CLIENT_SECRET=...       (needs eBay Marketplace Insights API access)
  SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / SMTP_FROM   send password-reset emails
  APP_URL=https://your-site    address used in password-reset links
"""
import base64
import hashlib
import hmac
import json
import os
import random
import re
import smtplib
import secrets
import sqlite3
import statistics
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
DATA = os.environ.get("DATA_DIR") or os.path.join(ROOT, "data")
PORT = int(os.environ.get("PORT", "8765"))
HOST = os.environ.get("HOST", "127.0.0.1")  # set HOST=0.0.0.0 to reach the app from other devices on your network
UA = "SlabScout/1.0"

GRADES = ["Ungraded", "PSA 10", "PSA 9", "PSA 8", "PSA 7", "BGS 10", "BGS 9.5", "BGS 9", "BGS 8.5",
          "CGC 10", "CGC 9.5", "CGC 9", "SGC 10", "SGC 9.5", "SGC 9", "TAG 10"]
COMPANIES = {"PSA": "PSA", "BGS": "Beckett (BGS)", "CGC": "CGC", "SGC": "SGC", "TAG": "TAG", "ACE": "ACE",
             "ANY": "Any company"}
GAME_LABEL = {"pokemon": "Pokemon", "magic": "Magic", "yugioh": "Yu-Gi-Oh", "sports": "Sports"}


def load_env():
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()

# ---------------------------------------------------------------- http + cache

_cache = {}
_cache_lock = threading.Lock()


def cached(key, ttl, fn):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    val = fn()
    with _cache_lock:
        _cache[key] = (now + ttl, val)
    return val


def get_json(url, headers=None, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def fnum(v):
    try:
        f = float(v)
        return f if f > 0 else None
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- card data

TCGDEX = "https://api.tcgdex.net/v2/en"
EUR_USD = 1.08  # rough conversion, only used when a card has no TCGplayer price


def _pokemon_year(set_id):
    try:
        return cached(("pkset", set_id), 86400 * 7,
                      lambda: (get_json("%s/sets/%s" % (TCGDEX, urllib.parse.quote(set_id))).get("releaseDate") or "")[:4])
    except Exception:
        return ""


def _pokemon_card(c):
    pricing = c.get("pricing") or {}
    tcg = pricing.get("tcgplayer") or {}
    price, source = None, "TCGplayer market"
    variants = {k: v for k, v in tcg.items() if isinstance(v, dict)}
    for key in ["holofoil", "1st-edition-holofoil", "unlimited-holofoil", "normal", "reverse-holofoil"] + list(variants):
        price = fnum((variants.get(key) or {}).get("marketPrice")) or fnum((variants.get(key) or {}).get("midPrice"))
        if price:
            break
    if not price:
        eur = fnum((pricing.get("cardmarket") or {}).get("avg30")) or fnum((pricing.get("cardmarket") or {}).get("avg"))
        if eur:
            price, source = round(eur * EUR_USD, 2), "Cardmarket average, converted to USD (approx.)"
    s = c.get("set") or {}
    img = c.get("image")
    return {
        "id": "pokemon:" + c["id"], "game": "pokemon", "name": c.get("name"),
        "set": s.get("name"), "setCode": s.get("id"), "number": c.get("localId"),
        "setTotal": (s.get("cardCount") or {}).get("official"), "rarity": c.get("rarity"),
        "year": _pokemon_year(s["id"]) if s.get("id") else "",
        "image": img + "/low.webp" if img else None, "imageLarge": img + "/high.webp" if img else None,
        "price": price, "priceSource": source,
    }


def _pokemon_fetch(card_id):
    return cached(("pk", card_id), 6 * 3600,
                  lambda: _pokemon_card(get_json("%s/cards/%s" % (TCGDEX, urllib.parse.quote(card_id)))))


def search_pokemon(q, number=None):
    params = {"name": q.strip()}
    if number:
        params["localId"] = "eq:" + str(number)
    brief = get_json(TCGDEX + "/cards?" + urllib.parse.urlencode(params))
    brief = [b for b in brief if b.get("image")] + [b for b in brief if not b.get("image")]

    def one(b):
        try:
            return _pokemon_fetch(b["id"])
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=12) as ex:
        return [c for c in ex.map(one, brief[:48]) if c]


def _magic_card(c):
    imgs = c.get("image_uris") or ((c.get("card_faces") or [{}])[0].get("image_uris")) or {}
    p = c.get("prices") or {}
    return {
        "id": "magic:" + c["id"], "game": "magic", "name": c.get("name"),
        "set": c.get("set_name"), "setCode": (c.get("set") or "").upper(),
        "number": c.get("collector_number"), "setTotal": None, "rarity": (c.get("rarity") or "").title(),
        "year": (c.get("released_at") or "")[:4],
        "image": imgs.get("small"), "imageLarge": imgs.get("normal"),
        "price": fnum(p.get("usd")) or fnum(p.get("usd_foil")) or fnum(p.get("usd_etched")),
        "priceSource": "TCGplayer market (via Scryfall)",
    }


def search_magic(q, number=None):
    url = "https://api.scryfall.com/cards/search?" + urllib.parse.urlencode(
        {"q": q + " game:paper", "unique": "prints", "order": "released"})
    try:
        return [_magic_card(c) for c in get_json(url).get("data", [])[:40]]
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []
        raise


def _yugioh_cards(c):
    img = (c.get("card_images") or [{}])[0]
    fallback = fnum(((c.get("card_prices") or [{}])[0]).get("tcgplayer_price"))
    out = []
    for s in (c.get("card_sets") or [])[:12]:
        code = s.get("set_code") or ""
        out.append({
            "id": "yugioh:%s:%s" % (c["id"], code), "game": "yugioh", "name": c.get("name"),
            "set": s.get("set_name"), "setCode": code, "number": code, "setTotal": None,
            "rarity": s.get("set_rarity"), "year": "",
            "image": img.get("image_url_small"), "imageLarge": img.get("image_url"),
            "price": fnum(s.get("set_price")) or fallback, "priceSource": "TCGplayer",
        })
    return out


def search_yugioh(q, number=None):
    url = "https://db.ygoprodeck.com/api/v7/cardinfo.php?" + urllib.parse.urlencode(
        {"fname": q, "num": 12, "offset": 0})
    try:
        data = get_json(url).get("data", [])
    except urllib.error.HTTPError as e:
        if e.code == 400:
            return []
        raise
    out = []
    for c in data:
        out.extend(_yugioh_cards(c))
    return out[:40]


SEARCHERS = {"pokemon": search_pokemon, "magic": search_magic, "yugioh": search_yugioh}


def search(q, game="all", number=None):
    games = list(SEARCHERS) if game not in SEARCHERS else [game]

    def run(g):
        try:
            return cached(("search", g, q.lower(), number), 900, lambda: SEARCHERS[g](q, number)), None
        except Exception as e:  # one provider failing should not sink the others
            return [], "%s: %s" % (GAME_LABEL[g], e)

    with ThreadPoolExecutor(max_workers=3) as ex:
        results = list(ex.map(run, games))
    cards = [c for r, _ in results for c in r]
    errors = [e for _, e in results if e]
    return cards, errors


def get_card(card_id):
    game, _, rest = card_id.partition(":")

    def fetch():
        if game == "pokemon":
            return _pokemon_fetch(rest)
        if game == "magic":
            return _magic_card(get_json("https://api.scryfall.com/cards/" + urllib.parse.quote(rest)))
        if game == "sports":  # no catalogue for sports cards: the id carries the search text
            q = rest.strip()[:300]
            return {"id": "sports:" + q, "game": "sports", "name": q, "set": "", "setCode": "", "number": "",
                    "rarity": "", "year": "", "image": None, "imageLarge": None, "price": None,
                    "priceSource": "Median of recent eBay sales"} if len(q) >= 3 else None
        if game == "yugioh":
            cid, _, code = rest.partition(":")
            data = get_json("https://db.ygoprodeck.com/api/v7/cardinfo.php?id=" + urllib.parse.quote(cid))["data"][0]
            prints = _yugioh_cards(data)
            return next((p for p in prints if p["setCode"] == code), prints[0] if prints else None)
        return None

    return cached(("card", card_id), 3600, fetch)


# ---------------------------------------------------------------- sold listings

GRADE_RE = re.compile(r"\b(PSA|BGS|BECKETT|BVG|CGC|SGC|TAG|ACE)\b\D{0,24}?\b(10|[1-9](?:\.5)?)(?![\d/.])", re.I)


def parse_grade(title):
    m = GRADE_RE.search(title or "")
    if not m:
        return "Ungraded"
    company = m.group(1).upper().replace("BECKETT", "BGS").replace("BVG", "BGS")
    return "%s %s" % (company, m.group(2))


def sales_query(card):
    parts = [card.get("name") or "", card.get("set") or ""]
    if card.get("number"):
        parts.append(str(card["number"]))
    return " ".join(p for p in parts if p)


def ebay_sold_url(card, grade=None):
    q = sales_query(card) + ((" " + grade) if grade and grade != "Ungraded" else "")
    return "https://www.ebay.com/sch/i.html?" + urllib.parse.urlencode(
        {"_nkw": q, "LH_Sold": 1, "LH_Complete": 1})


def ebay_enabled():
    return bool(os.environ.get("EBAY_CLIENT_ID") and os.environ.get("EBAY_CLIENT_SECRET"))


def ebay_token():
    def fetch():
        creds = "%s:%s" % (os.environ["EBAY_CLIENT_ID"], os.environ["EBAY_CLIENT_SECRET"])
        body = urllib.parse.urlencode({
            "grant_type": "client_credentials",
            "scope": "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights",
        }).encode()
        req = urllib.request.Request("https://api.ebay.com/identity/v1/oauth2/token", data=body, headers={
            "Authorization": "Basic " + base64.b64encode(creds.encode()).decode(),
            "Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())["access_token"]
    return cached("ebay_token", 6000, fetch)


def ebay_sales(card):
    """Real sold listings from eBay's Marketplace Insights API (restricted-access API)."""
    url = "https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search?" + urllib.parse.urlencode(
        {"q": sales_query(card), "limit": 200})
    data = get_json(url, {"Authorization": "Bearer " + ebay_token(), "X-EBAY-C-MARKETPLACE-ID": "EBAY_US"})
    out = []
    for it in data.get("itemSales", []):
        price = fnum((it.get("lastSoldPrice") or {}).get("value"))
        if not price:
            continue
        out.append({"date": (it.get("lastSoldDate") or "")[:10], "title": it.get("title"), "price": price,
                    "grade": parse_grade(it.get("title")), "url": it.get("itemWebUrl"), "source": "eBay"})
    return out


def comps_enabled():
    return bool(os.environ.get("COMPSAPI_KEY"))


def _fmt_grade(g):
    f = fnum(g)
    return None if f is None else ("%g" % f)


def comps_sales(query):
    """Real eBay sold listings from CompsAPI. Results are kept in the database to save the monthly quota."""
    key = query.strip().lower()
    ttl = float(os.environ.get("COMPS_CACHE_HOURS") or 72) * 3600
    rows = sql("SELECT fetched, data FROM comps_cache WHERE q=?", (key,))
    if rows and time.time() - rows[0]["fetched"] < ttl:
        return json.loads(rows[0]["data"])
    url = "https://api.compsapi.com/v1/sold?" + urllib.parse.urlencode(
        {"q": query[:300], "cards": 1, "days": 365, "size": 240, "exclude": "junk,lot"})
    try:
        data = get_json(url, {"X-API-Key": os.environ["COMPSAPI_KEY"]})
    except urllib.error.HTTPError as e:
        if rows:  # out of quota or temporarily down: an older copy beats nothing
            return json.loads(rows[0]["data"])
        raise RuntimeError({401: "the CompsAPI key was rejected", 403: "the CompsAPI key has expired",
                            429: "the CompsAPI quota is used up for now"}.get(e.code, "CompsAPI returned %s" % e.code))
    out = []
    for it in data.get("items") or []:
        price = fnum(it.get("price"))
        if not price:
            continue
        c = it.get("card") or {}
        grade = _fmt_grade(c.get("grade"))
        if c.get("graded") and c.get("grader") and grade:
            label = "%s %s" % (str(c["grader"]).upper().replace("BECKETT", "BGS"), grade)
        else:
            label = parse_grade(it.get("title"))
        out.append({"date": str(it.get("last_sold") or "")[:10], "title": it.get("title"), "price": price,
                    "grade": label, "url": it.get("url"), "image": it.get("image"), "source": "eBay"})
    sql("INSERT OR REPLACE INTO comps_cache VALUES (?,?,?)", (key, time.time(), json.dumps(out)))
    return out


def full_card(card_id):
    """get_card plus, for sports cards, the picture and raw value taken from their sold listings."""
    card = get_card(card_id)
    if card and card["game"] == "sports" and comps_enabled():
        m = card_market(card)
        img = next((s["image"] for s in m["sales"] if s.get("image")), None)
        card = {**card, "image": img, "imageLarge": img, "price": (m["values"].get("Ungraded") or {}).get("value")}
    return card


GRADE_MULT = {"Ungraded": (1.0, 0),
              "PSA 10": (5.0, 28), "PSA 9": (2.1, 14), "PSA 8": (1.5, 9), "PSA 7": (1.15, 6),
              "BGS 10": (9.0, 60), "BGS 9.5": (3.4, 20), "BGS 9": (1.8, 12), "BGS 8.5": (1.4, 9),
              "CGC 10": (4.0, 24), "CGC 9.5": (2.6, 16), "CGC 9": (1.8, 11),
              "SGC 10": (3.6, 22), "SGC 9.5": (2.3, 14), "SGC 9": (1.7, 10), "TAG 10": (3.2, 20)}


def demo_sales(card):
    """Deterministic sample comps anchored to the card's real market price. Not real sales."""
    base = card.get("price")
    if not base:
        return []
    rng = random.Random(card["id"])
    trend = [1.0]
    for _ in range(13):
        trend.append(trend[-1] * (1 + rng.uniform(-0.08, 0.07)))
    today = date.today()
    label = " ".join(str(x) for x in (card.get("year"), GAME_LABEL.get(card["game"], ""), card.get("set"),
                                      card.get("name"), ("#%s" % card["number"]) if card.get("number") else "") if x)
    out = []
    for grade, (mult, floor) in GRADE_MULT.items():
        for _ in range(42 if grade == "Ungraded" else rng.randint(14, 26) if grade.startswith("PSA") else rng.randint(4, 14)):
            ago = rng.randint(1, 365)
            price = (base * mult + floor) * trend[ago // 30] * rng.uniform(0.86, 1.16)
            suffix = rng.choice(["NM", "Near Mint", "LP", "Raw"]) if grade == "Ungraded" else grade
            out.append({"date": (today - timedelta(days=ago)).isoformat(), "title": "%s %s" % (label, suffix),
                        "price": round(max(price, 0.25), 2), "grade": grade,
                        "url": ebay_sold_url(card, grade), "source": "sample"})
    return out


# PriceCharting Prices API: current values per grade (no individual sales, no history).
PC_KEYS = [("loose-price", "Ungraded", "", None), ("manual-only-price", "PSA 10", "PSA", 10),
           ("bgs-10-price", "BGS 10", "BGS", 10), ("condition-20-price", "BGS 10 Black Label", "BGS", 10),
           ("condition-17-price", "CGC 10", "CGC", 10), ("condition-19-price", "CGC 10 Pristine", "CGC", 10),
           ("condition-18-price", "SGC 10", "SGC", 10), ("condition-21-price", "TAG 10", "TAG", 10),
           ("condition-22-price", "ACE 10", "ACE", 10), ("box-only-price", "Grade 9.5", "ANY", 9.5),
           ("graded-price", "Grade 9", "ANY", 9), ("new-price", "Grade 8", "ANY", 8), ("cib-price", "Grade 7", "ANY", 7),
           ("condition-16-price", "Grade 6", "ANY", 6), ("condition-15-price", "Grade 5", "ANY", 5),
           ("condition-14-price", "Grade 4", "ANY", 4), ("condition-13-price", "Grade 3", "ANY", 3),
           ("condition-10-price", "Grade 2", "ANY", 2), ("condition-9-price", "Grade 1", "ANY", 1)]
_pc_lock = threading.Lock()
_pc_last = [0.0]


def pc_token():
    return os.environ.get("PRICECHARTING_TOKEN")


def _alnum(t):
    return re.sub(r"[^a-z0-9]", "", (t or "").lower())


def pc_lookup(card):
    """Best-match PriceCharting product for a card, or None. The API allows 1 call per second."""
    def fetch():
        q = card.get("name") or ""
        if card.get("number"):
            q += " #%s" % card["number"]
        if card.get("set"):
            q += " " + card["set"]
        url = "https://www.pricecharting.com/api/product?" + urllib.parse.urlencode({"t": pc_token(), "q": q})
        with _pc_lock:
            wait = 1.1 - (time.time() - _pc_last[0])
            if wait > 0:
                time.sleep(wait)
            try:
                p = get_json(url)
            finally:
                _pc_last[0] = time.time()
        if p.get("status") != "success" or _alnum(card.get("name")) not in _alnum(p.get("product-name")):
            return None
        values = {}
        for key, label, company, grade in PC_KEYS:
            v = fnum(p.get(key))
            if v:
                values[label] = {"value": round(v / 100, 2), "count": None, "company": company,
                                 "grade": grade, "lastSold": None}
        if not values:
            return None
        return {"values": values, "match": {
            "id": p.get("id"), "name": p.get("product-name"), "set": p.get("console-name"),
            "volume": p.get("sales-volume"), "url": "https://www.pricecharting.com/game/%s" % p.get("id")}}
    return cached(("pc", card["id"]), 12 * 3600, fetch)


def card_market(card):
    """Returns sales, per-grade values and monthly history for a card."""
    errors, sales, sales_source, pc = [], [], "none", None
    if pc_token():
        try:
            pc = pc_lookup(card)
            if not pc:
                errors.append("PriceCharting had no confident match for this card.")
        except Exception as e:
            errors.append("PriceCharting lookup failed (%s)." % e)
    if comps_enabled():
        try:
            sales = [dict(x) for x in comps_sales(sales_query(card))]
            sales_source = "ebay"
        except Exception as e:
            errors.append("Sold-listing lookup failed: %s." % e)
    if sales_source != "ebay" and ebay_enabled():
        try:
            sales = cached(("ebay", card["id"]), 1800, lambda: ebay_sales(card))
            sales_source = "ebay"
        except Exception as e:
            errors.append("eBay lookup failed (%s)." % e)
    if sales_source != "ebay" and not pc:
        sales, sales_source = demo_sales(card), "sample"
    sales.sort(key=lambda s: s["date"], reverse=True)

    cutoff = (date.today() - timedelta(days=90)).isoformat()
    by_grade = {}
    for s in sales:
        by_grade.setdefault(s["grade"], []).append(s)
    values = {}
    for g, rows in by_grade.items():
        recent = [r["price"] for r in rows if r["date"] >= cutoff] or [r["price"] for r in rows[:5]]
        company, _, num = g.partition(" ")
        values[g] = {"value": round(statistics.median(recent), 2), "count": len(rows),
                     "company": company if num else "", "grade": fnum(num),
                     "lastSold": {"price": rows[0]["price"], "date": rows[0]["date"], "url": rows[0]["url"]}}
    if card.get("price") and (sales_source != "ebay" or "Ungraded" not in values):
        values["Ungraded"] = {**values.get("Ungraded", {"company": "", "grade": None, "lastSold": None}),
                              "value": card["price"], "count": len(by_grade.get("Ungraded", []))}
    if pc:  # PriceCharting values win; keep last-sold details from eBay where the grade matches
        for g, v in pc["values"].items():
            old = values.get(g) or {}
            values[g] = {**v, "count": old.get("count"), "lastSold": old.get("lastSold")}

    months = {}
    for s in sales:
        months.setdefault(s["date"][:7], {}).setdefault(s["grade"], []).append(s["price"])
    history = [{"month": m, **{g: round(statistics.median(p), 2) for g, p in grades.items()}}
               for m, grades in sorted(months.items())][-13:]
    return {"sales": sales, "values": values, "history": history, "salesSource": sales_source,
            "valueSource": "pricecharting" if pc else sales_source, "priceGuideMatch": pc["match"] if pc else None,
            "salesError": " ".join(errors) or None, "ebayUrl": ebay_sold_url(card)}


def value_for(card, grade):
    m = card_market(card)["values"]
    v = (m.get(grade) or {}).get("value")
    if v is None and " " in grade:  # e.g. "PSA 9" -> PriceCharting's any-company "Grade 9"
        num = fnum(grade.split(" ")[1])
        key = "Grade %s" % (9.5 if num == 9.5 else int(num)) if num else None
        v = (m.get(key) or {}).get("value")
    return v if v is not None else card.get("price")


# ---------------------------------------------------------------- scanning

SCAN_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["is_card", "game", "name", "set", "number", "year", "grade", "confidence", "notes"],
    "properties": {
        "is_card": {"type": "boolean"},
        "game": {"type": "string", "enum": ["pokemon", "magic", "yugioh", "other"]},
        "name": {"type": "string", "description": "Card name exactly as printed, in English if printed in English"},
        "set": {"type": "string", "description": "Set / expansion name, or empty string if unknown"},
        "number": {"type": "string", "description": "Collector number as printed, e.g. 4/102, 215, LOB-001; empty if not visible"},
        "year": {"type": "string"},
        "grade": {"type": "string", "description": "If the card is in a grading slab, e.g. 'PSA 10'; otherwise 'Ungraded'"},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "notes": {"type": "string", "description": "One short sentence: variant, edition, holo, visible condition issues"},
    },
}

SCAN_PROMPT = (
    "Identify the trading card in this photo. Read the printed card name, the collector number and the set "
    "symbol or set code, and work out which set it is from. If it is sealed in a grading slab, read the "
    "grading company and grade from the label. If the photo does not show a trading card, set is_card to "
    "false. Reply with a single JSON object with the keys: is_card, game (pokemon | magic | yugioh | other), "
    "name, set, number, year, grade, confidence (high | medium | low), notes."
)


def identify_card(media_type, b64):
    import anthropic  # imported lazily so the app runs without the SDK installed
    client = anthropic.Anthropic()
    content = [{"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
               {"type": "text", "text": SCAN_PROMPT}]
    kwargs = dict(model="claude-opus-5-5", max_tokens=4000, messages=[{"role": "user", "content": content}])
    try:
        resp = client.messages.create(
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCAN_SCHEMA}}, **kwargs)
    except TypeError:  # older SDK without output_config
        resp = client.messages.create(**kwargs)
    if resp.stop_reason == "refusal":
        raise RuntimeError("The model declined to analyze this image.")
    text = "".join(b.text for b in resp.content if b.type == "text")
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise RuntimeError("Could not read the card from this photo.")
    return json.loads(m.group(0))


def norm_number(n):
    return re.sub(r"^0+", "", str(n or "").split("/")[0].strip().lower())


def scan(image_data_url):
    m = re.match(r"data:(image/(?:jpeg|png|webp|gif));base64,(.+)", image_data_url or "", re.S)
    if not m:
        raise ValueError("Send the photo as a JPEG, PNG or WebP image.")
    ident = identify_card(m.group(1), m.group(2))
    if not ident.get("is_card") or not ident.get("name"):
        return {"identified": ident, "matches": []}
    game = ident.get("game") if ident.get("game") in SEARCHERS else "all"
    cards, _ = search(ident["name"], game)
    want_num, want_set = norm_number(ident.get("number")), (ident.get("set") or "").lower()

    def score(c):
        s = 0
        if want_num and norm_number(c.get("number")) == want_num:
            s += 3
        cs = (c.get("set") or "").lower()
        if want_set and cs and (want_set in cs or cs in want_set):
            s += 2
        if (c.get("name") or "").lower() == ident["name"].lower():
            s += 1
        return s

    ranked = sorted(cards, key=score, reverse=True)
    return {"identified": ident, "matches": ranked[:12], "exact": bool(ranked and score(ranked[0]) >= 5)}


# ---------------------------------------------------------------- database, accounts

DB_FILE = os.path.join(DATA, "slabscout.db")
SESSION_DAYS = 30
COOKIE = "ss_session"


def sql(query, args=()):
    os.makedirs(DATA, exist_ok=True)
    con = sqlite3.connect(DB_FILE, timeout=15)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(query, args).fetchall()
        con.commit()
        return rows
    finally:
        con.close()


def init_db():
    for stmt in (
        "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,"
        " pw_hash TEXT NOT NULL, salt TEXT NOT NULL, created TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires REAL NOT NULL)",
        "CREATE TABLE IF NOT EXISTS items (entry_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, data TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS history (user_id INTEGER NOT NULL, day TEXT NOT NULL, value REAL, cost REAL,"
        " cards INTEGER, PRIMARY KEY (user_id, day))",
        "CREATE TABLE IF NOT EXISTS scans (user_id INTEGER NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL,"
        " PRIMARY KEY (user_id, day))",
        "CREATE TABLE IF NOT EXISTS comps_cache (q TEXT PRIMARY KEY, fetched REAL NOT NULL, data TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS resets (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires REAL NOT NULL)",
    ):
        sql(stmt)


def hash_password(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 600000).hex()


def count_scan(user_id):
    """Counts one scan for today; False when the user is over the daily limit (scans cost API money)."""
    today, limit = date.today().isoformat(), int(os.environ.get("SCANS_PER_DAY") or 25)
    rows = sql("SELECT n FROM scans WHERE user_id=? AND day=?", (user_id, today))
    if rows and rows[0]["n"] >= limit:
        return False
    sql("INSERT INTO scans VALUES (?,?,1) ON CONFLICT(user_id, day) DO UPDATE SET n = n + 1", (user_id, today))
    return True


def create_user(email, name, password, code=None):
    want = os.environ.get("SIGNUP_CODE")
    if want and not hmac.compare_digest((code or "").strip().encode(), want.encode()):
        raise ValueError("That invite code is not right.")
    email = (email or "").strip().lower()
    name = (name or "").strip()[:60] or email.split("@")[0]
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email) or len(email) > 200:
        raise ValueError("Enter a valid email address.")
    if len(password or "") < 8:
        raise ValueError("Password must be at least 8 characters.")
    salt = secrets.token_hex(16)
    try:
        sql("INSERT INTO users (email, name, pw_hash, salt, created) VALUES (?,?,?,?,?)",
            (email, name, hash_password(password, salt), salt, datetime.now().isoformat(timespec="seconds")))
    except sqlite3.IntegrityError:
        raise ValueError("An account with this email already exists.")
    user = sql("SELECT id FROM users WHERE email=?", (email,))[0]
    # A collection saved before accounts existed goes to the first account created.
    legacy = os.path.join(DATA, "collection.json")
    if user["id"] == 1 and os.path.exists(legacy):
        try:
            with open(legacy) as f:
                for it in json.load(f):
                    sql("INSERT OR IGNORE INTO items VALUES (?,?,?)", (it["entryId"], 1, json.dumps(it)))
        except (OSError, ValueError, KeyError):
            pass
    return user["id"]


_login_fails = {}


def check_login(email, password):
    email = (email or "").strip().lower()
    now = time.time()
    fails = [t for t in _login_fails.get(email, []) if now - t < 900]
    if len(fails) >= 8:
        raise PermissionError("Too many attempts. Try again in 15 minutes.")
    rows = sql("SELECT id, pw_hash, salt FROM users WHERE email=?", (email,))
    # hash even when the account is unknown so timing does not reveal which emails exist
    digest = hash_password(password or "", rows[0]["salt"] if rows else "00" * 16)
    if rows and hmac.compare_digest(digest, rows[0]["pw_hash"]):
        _login_fails.pop(email, None)
        return rows[0]["id"]
    _login_fails[email] = fails + [now]
    raise PermissionError("Wrong email or password.")


_reset_asks = {}
RESET_LOG = os.path.join(DATA, "password-reset-links.txt")


def send_reset_email(to, link):
    """Emails the link when SMTP is configured; otherwise saves it to a local file for the app owner."""
    host = os.environ.get("SMTP_HOST")
    if not host:
        line = "%s  %s  %s\n" % (datetime.now().isoformat(timespec="seconds"), to, link)
        print("Password reset link: " + line, end="", flush=True)
        with open(RESET_LOG, "a") as f:
            f.write(line)
        return
    msg = EmailMessage()
    msg["Subject"] = "Reset your SlabScout password"
    msg["From"] = os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER")
    msg["To"] = to
    msg.set_content("Someone asked to reset the SlabScout password for this email address.\n\n"
                    "Open this link within one hour to choose a new password:\n%s\n\n"
                    "If this was not you, ignore this email and your password stays the same.\n" % link)
    with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT") or 587), timeout=20) as smtp:
        smtp.starttls()
        if os.environ.get("SMTP_USER"):
            smtp.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD") or "")
        smtp.send_message(msg)


def request_reset(email):
    """Creates a one-hour reset link. Says nothing to the caller about whether the account exists."""
    email = (email or "").strip().lower()
    now = time.time()
    asks = [t for t in _reset_asks.get(email, []) if now - t < 3600]
    _reset_asks[email] = asks + [now]
    rows = sql("SELECT id FROM users WHERE email=?", (email,))
    if not rows or len(asks) >= 3:
        return
    token = secrets.token_urlsafe(32)
    sql("DELETE FROM resets WHERE user_id=? OR expires < ?", (rows[0]["id"], now))
    sql("INSERT INTO resets VALUES (?,?,?)", (_token_hash(token), rows[0]["id"], now + 3600))
    base = (os.environ.get("APP_URL") or os.environ.get("RENDER_EXTERNAL_URL") or "http://localhost:%d" % PORT).rstrip("/")
    send_reset_email(email, "%s/#/reset/%s" % (base, token))


def reset_password(token, password):
    if len(password or "") < 8:
        raise ValueError("Password must be at least 8 characters.")
    rows = sql("SELECT user_id FROM resets WHERE token_hash=? AND expires > ?", (_token_hash(token or ""), time.time()))
    if not rows:
        raise ValueError("This reset link is invalid or has expired. Request a new one.")
    uid, salt = rows[0]["user_id"], secrets.token_hex(16)
    sql("UPDATE users SET pw_hash=?, salt=? WHERE id=?", (hash_password(password, salt), salt, uid))
    sql("DELETE FROM resets WHERE user_id=?", (uid,))
    sql("DELETE FROM sessions WHERE user_id=?", (uid,))  # sign out everywhere
    return uid


def _token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def start_session(user_id):
    token = secrets.token_urlsafe(32)
    sql("DELETE FROM sessions WHERE expires < ?", (time.time(),))
    sql("INSERT INTO sessions VALUES (?,?,?)", (_token_hash(token), user_id, time.time() + SESSION_DAYS * 86400))
    secure = "; Secure" if os.environ.get("SECURE_COOKIES") else ""
    return "%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d%s" % (COOKIE, token, SESSION_DAYS * 86400, secure)


def session_token(headers):
    for part in (headers.get("Cookie") or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == COOKIE:
            return v
    return None


def user_from(headers):
    token = session_token(headers)
    if not token:
        return None
    rows = sql("SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id "
               "WHERE s.token_hash=? AND s.expires > ?", (_token_hash(token), time.time()))
    return dict(rows[0]) if rows else None


# ---------------------------------------------------------------- collection

def load_collection(user_id):
    return [json.loads(r["data"]) for r in sql("SELECT data FROM items WHERE user_id=? ORDER BY rowid", (user_id,))]


def collection_view(user_id):
    out = []
    for it in load_collection(user_id):
        try:
            val = value_for(it["card"], it["grade"])
        except Exception:
            val = it["card"].get("price")
        out.append({**it, "value": val})
    return out


def record_snapshot(user_id, items=None):
    """Stores today's collection value (one point per day) and returns the user's full history."""
    items = collection_view(user_id) if items is None else items
    had = sql("SELECT 1 FROM history WHERE user_id=? LIMIT 1", (user_id,))
    if items or had:
        sql("INSERT OR REPLACE INTO history VALUES (?,?,?,?,?)", (
            user_id, date.today().isoformat(),
            round(sum((i.get("value") or 0) * i["qty"] for i in items), 2),
            round(sum(i["paid"] * i["qty"] for i in items if i.get("paid") is not None), 2),
            sum(i["qty"] for i in items)))
    return [{"date": r["day"], "value": r["value"], "cost": r["cost"], "cards": r["cards"]}
            for r in sql("SELECT * FROM history WHERE user_id=? ORDER BY day", (user_id,))]


def snapshot_loop():
    while True:
        try:
            for r in sql("SELECT DISTINCT user_id FROM items"):
                record_snapshot(r["user_id"])
        except Exception:
            pass
        time.sleep(6 * 3600)


# ---------------------------------------------------------------- server

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send_json(self, obj, status=200, cookie=None):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def need_user(self):
        user = user_from(self.headers)
        if not user:
            self.send_json({"error": "Sign in to continue.", "signIn": True}, 401)
        return user

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 15 * 1024 * 1024:
            raise ValueError("Upload too large.")
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        try:
            if u.path == "/api/status":
                has_key = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
                return self.send_json({"scan": has_key, "ebay": ebay_enabled(), "priceGuide": bool(pc_token()),
                                       "email": bool(os.environ.get("SMTP_HOST")), "sports": comps_enabled(),
                                       "inviteOnly": bool(os.environ.get("SIGNUP_CODE"))})
            if u.path == "/api/search":
                q = (qs.get("q") or "").strip()
                if len(q) < 2:
                    return self.send_json({"cards": [], "errors": []})
                if qs.get("game") == "sports":
                    return self.send_json({"cards": [], "errors": []})
                cards, errors = search(q, qs.get("game", "all"))
                return self.send_json({"cards": cards, "errors": errors})
            if u.path == "/api/card":
                card = full_card(qs.get("id", ""))
                if not card:
                    return self.send_json({"error": "Card not found."}, 404)
                if card["game"] == "sports" and not comps_enabled():
                    return self.send_json({"error": "Sports card lookups are not set up yet: add COMPSAPI_KEY to "
                                                    "the .env file and restart."}, 503)
                return self.send_json({"card": card, "grades": GRADES, "companies": COMPANIES, **card_market(card)})
            if u.path == "/api/me":
                return self.send_json({"user": user_from(self.headers)})
            if u.path == "/api/collection":
                user = self.need_user()
                if not user:
                    return
                items = collection_view(user["id"])
                return self.send_json({"items": items, "history": record_snapshot(user["id"], items)})
            if u.path.startswith("/api/"):
                return self.send_json({"error": "Not found."}, 404)
            return self.serve_static(u.path)
        except urllib.error.HTTPError as e:
            self.send_json({"error": "Card data provider returned %s." % e.code}, 404 if e.code == 404 else 502)
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        try:
            body = self.read_body()
            if u.path in ("/api/signup", "/api/login"):
                try:
                    if u.path == "/api/signup":
                        uid = create_user(body.get("email"), body.get("name"), body.get("password"), body.get("code"))
                    else:
                        uid = check_login(body.get("email"), body.get("password"))
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
                except PermissionError as e:
                    return self.send_json({"error": str(e)}, 401)
                row = sql("SELECT id, email, name FROM users WHERE id=?", (uid,))[0]
                return self.send_json({"user": dict(row)}, cookie=start_session(uid))
            if u.path == "/api/forgot":
                try:
                    request_reset(body.get("email"))
                except Exception as e:
                    print("Password reset email failed: %s" % e, flush=True)
                return self.send_json({"ok": True})
            if u.path == "/api/reset":
                try:
                    uid = reset_password(body.get("token"), body.get("password"))
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
                row = sql("SELECT id, email, name FROM users WHERE id=?", (uid,))[0]
                return self.send_json({"user": dict(row)}, cookie=start_session(uid))
            if u.path == "/api/logout":
                token = session_token(self.headers)
                if token:
                    sql("DELETE FROM sessions WHERE token_hash=?", (_token_hash(token),))
                return self.send_json({"ok": True}, cookie="%s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" % COOKIE)
            user = self.need_user()
            if not user:
                return
            if u.path == "/api/scan":
                if not count_scan(user["id"]):
                    return self.send_json({"error": "You have reached today's scan limit. Try again tomorrow."}, 429)
                try:
                    return self.send_json(scan(body.get("image")))
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
                except Exception as e:
                    name = type(e).__name__
                    if name in ("AuthenticationError", "ModuleNotFoundError") or "authentication" in str(e).lower() \
                            or "api_key" in str(e).lower():
                        return self.send_json({"error": "Scanning needs an Anthropic API key. Add "
                                                        "ANTHROPIC_API_KEY to the .env file and restart.",
                                               "needsKey": True}, 503)
                    return self.send_json({"error": "Scan failed: %s" % e}, 502)
            if u.path == "/api/collection":
                card = full_card(body.get("cardId", ""))
                if not card:
                    return self.send_json({"error": "Card not found."}, 404)
                item = {"entryId": uuid.uuid4().hex[:10], "card": card,
                        "grade": body.get("grade") if body.get("grade") in GRADES else "Ungraded",
                        "qty": max(1, int(body.get("qty") or 1)), "paid": fnum(body.get("paid")),
                        "added": datetime.now().isoformat(timespec="seconds")}
                sql("INSERT INTO items VALUES (?,?,?)", (item["entryId"], user["id"], json.dumps(item)))
                hist = record_snapshot(user["id"])
                return self.send_json({"ok": True, "item": item, "total": hist[-1]["value"] if hist else None})
            self.send_json({"error": "Not found."}, 404)
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def do_DELETE(self):
        u = urllib.parse.urlparse(self.path)
        qs = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        if u.path != "/api/collection":
            return self.send_json({"error": "Not found."}, 404)
        user = self.need_user()
        if not user:
            return
        sql("DELETE FROM items WHERE entry_id=? AND user_id=?", (qs.get("entry"), user["id"]))
        try:
            record_snapshot(user["id"])
        except Exception:
            pass
        self.send_json({"ok": True})

    def serve_static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        full = os.path.realpath(os.path.join(STATIC, rel))
        if not full.startswith(os.path.realpath(STATIC) + os.sep) or not os.path.isfile(full):
            return self.send_json({"error": "Not found."}, 404)
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(os.path.splitext(full)[1], "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print("SlabScout running at http://localhost:%d" % PORT)
    init_db()
    threading.Thread(target=snapshot_loop, daemon=True).start()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
