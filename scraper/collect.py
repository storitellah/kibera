#!/usr/bin/env python3
"""Collect news about Kibera from across the web into data/news.json.

    python3 scraper/collect.py [--sources scraper/sources.json] [--out data/news.json]

Sources (edit scraper/sources.json):
  * search: news search feeds (Google News, Bing News) and the GDELT API. Every
    result is kept, because the search engine already matched "Kibera".
  * exclude: words or publisher names; matching stories are dropped (also from
    the archive). Use it to silence off-topic results that search engines return.
  * outlets: RSS feeds from Kenyan publishers. Only items whose title or summary
    mention a keyword are kept.

New items are merged into the existing file, deduplicated by URL and headline,
given a category, and anything older than RETENTION_DAYS is dropped. A source
that fails is logged in the output and skipped. Standard library only.
"""
import argparse
import hashlib
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RETENTION_DAYS = 365
MAX_ITEMS = 5000
SUMMARY_LEN = 300
USER_AGENT = "Mozilla/5.0 (compatible; KiberaNewsBot/1.0; +https://github.com/storitellah/kibera)"

# First match wins, so more specific categories come first.
CATEGORIES = [
    ("Fire & Emergencies", r"\bfires?\b|blaze|inferno|flood|floods|flooding|collapse|disaster|tragedy|rescue|demolition victims|electrocut"),
    ("Crime & Security", r"police|crime|criminal|murder|killed|shot dead|shooting|robbery|robbers|theft|arrest|suspect|gang|stabb|assault|court|charged|detectives|dci\b|teargas|tear gas"),
    ("Housing & Land", r"housing|affordable homes?|houses|demolition|demolish|evict|eviction|land|slum upgrad|kensup|resettle|title deeds?|rent\b"),
    ("Health", r"health|hospital|clinic|abortion|pregnan|maternity|infant|cholera|malaria|hiv|aids|tb\b|tuberculosis|vaccin|disease|outbreak|medical|maternal|nutrition|mental health|covid|mpox"),
    ("Water & Sanitation", r"water|sanitation|toilet|sewer|sewage|waste|garbage|dumpsite|nairobi river|clean[- ]?up|drainage"),
    ("Education", r"school|pupils?|students?|teachers?|education|kcse|kcpe|kjsea|cbc\b|bursar|scholarship|university|library|literacy"),
    ("Sports", r"football|soccer|coach|\bfc\b|league|tournament|athlet|boxing|rugby|basketball|marathon|sports?\b|harambee stars|cup\b"),
    ("Politics & Governance", r"\bmp\b|member of parliament|mca\b|governor|sakaja|ruto|raila|odinga|election|campaign|iebc|parliament|senator|politic|ward rep|cdf\b|ng-cdf|county government|protest|demonstrat|maandamano|by-election"),
    ("Business & Jobs", r"business|traders?|market|jobs?\b|employment|unemploy|youth fund|loan|sacco|entrepreneur|economy|prices|hustler|livelihood|kazi mtaani|investment"),
    ("Arts & Culture", r"music|artist|film|movie|documentary|theatre|theater|festival|art\b|arts\b|dance|poet|photograph|mural|culture|ghetto radio"),
    ("Infrastructure & Transport", r"road|railway|\bsgr\b|bypass|electricity|power|kplc|street ?lights?|bridge|construction|matatu|transport|digital|internet|wi-?fi"),
    ("Community & Development", r"community|ngo|charity|donat|youth|women|girls|children|volunteer|initiative|project|empower|shofco|feeding|relief|church|mosque"),
]
CATEGORY_RES = [(name, re.compile(pat, re.I)) for name, pat in CATEGORIES]
DEFAULT_CATEGORY = "General"

TRACKING_PARAMS = re.compile(r"^(utm_|fbclid|gclid|ocid|cmpid|ref$|src$|at_)", re.I)


def log(msg):
    print(msg, file=sys.stderr)


# ---------- helpers ----------

def fetch(url, timeout=25, retries=2):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.read()
        except urllib.error.HTTPError as err:
            # Rate limits (GDELT) and server hiccups are worth one more try.
            if attempt == retries or err.code not in (429, 500, 502, 503, 504):
                raise
            time.sleep(6 * (attempt + 1))


def clean_text(s):
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    return re.sub(r"\s+", " ", s).strip()


def truncate(s, n=SUMMARY_LEN):
    if len(s) <= n:
        return s
    return s[:n].rsplit(" ", 1)[0].rstrip(",.;:") + "…"


def to_utc_iso(dt):
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_date(s):
    if not s:
        return None
    s = s.strip()
    for parser in (parsedate_to_datetime, lambda v: datetime.fromisoformat(v.replace("Z", "+00:00"))):
        try:
            return parser(s)
        except (TypeError, ValueError, IndexError):
            continue
    m = re.match(r"(\d{8})T(\d{6})Z", s)  # GDELT: 20261021T140000Z
    if m:
        return datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    return None


def canonical_url(url):
    try:
        p = urllib.parse.urlsplit(url.strip())
    except ValueError:
        return url
    query = [(k, v) for k, v in urllib.parse.parse_qsl(p.query) if not TRACKING_PARAMS.match(k)]
    host = p.netloc.lower().removeprefix("www.").removeprefix("amp.")
    path = re.sub(r"/amp/?$", "", p.path).rstrip("/")
    return urllib.parse.urlunsplit(("https", host, path, urllib.parse.urlencode(query), ""))


def title_key(title):
    return re.sub(r"[^a-z0-9]+", "", title.lower())[:90]


def item_id(url):
    return hashlib.sha1(canonical_url(url).encode()).hexdigest()[:12]


def categorize(title, summary):
    for text in (title, f"{title} {summary}"):
        for name, rx in CATEGORY_RES:
            if rx.search(text):
                return name
    return DEFAULT_CATEGORY


def local(tag):
    return tag.rsplit("}", 1)[-1].lower()


def child_text(el, *names):
    for c in el:
        if local(c.tag) in names and (c.text or "").strip():
            return c.text.strip()
    return ""


# ---------- parsers ----------

def parse_feed(raw, source_name):
    """Parse RSS 2.0 or Atom into raw item dicts."""
    root = ET.fromstring(raw)
    entries = [el for el in root.iter() if local(el.tag) in ("item", "entry")]
    out = []
    for el in entries:
        title = clean_text(child_text(el, "title"))
        link = child_text(el, "link")
        if not link:
            for c in el:
                if local(c.tag) == "link" and c.get("rel", "alternate") == "alternate" and c.get("href"):
                    link = c.get("href")
                    break
        summary = clean_text(child_text(el, "description", "summary", "content", "encoded"))
        date = parse_date(child_text(el, "pubdate", "published", "updated", "date"))
        publisher = ""
        for c in el:
            if local(c.tag) == "source" and (c.text or "").strip():
                publisher = c.text.strip()
        if title and link:
            out.append({"title": title, "url": link, "summary": summary, "date": date,
                        "publisher": publisher, "via": source_name})
    return out


def fix_google(item):
    # Google News titles end in " - Publisher" and the summary repeats the title.
    pub = item["publisher"]
    if pub and item["title"].endswith(f" - {pub}"):
        item["title"] = item["title"][: -len(pub) - 3].strip()
    if title_key(item["summary"]).startswith(title_key(item["title"])[:40]):
        item["summary"] = ""
    return item


def fix_bing(item):
    # Bing wraps links in apiclick.aspx?url=<real url>
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(item["url"]).query)
    if "url" in q:
        item["url"] = q["url"][0]
    return item


def parse_gdelt(raw, source_name):
    data = json.loads(raw or b"{}")
    out = []
    for a in data.get("articles", []):
        out.append({
            "title": clean_text(a.get("title")),
            "url": a.get("url", ""),
            "summary": "",
            "date": parse_date(a.get("seendate")),
            "publisher": a.get("domain", ""),
            "via": source_name,
            "language": a.get("language", ""),
        })
    return [i for i in out if i["title"] and i["url"]]


# ---------- pipeline ----------

def collect_source(src, keyword_re, is_search, exclude_re=None):
    name = src["name"]
    try:
        raw = fetch(src["url"])
        if src.get("type") == "gdelt":
            items = parse_gdelt(raw, name)
        else:
            items = parse_feed(raw, name)
        if "news.google." in src["url"]:
            items = [fix_google(i) for i in items]
        elif "bing.com" in src["url"]:
            items = [fix_bing(i) for i in items]
        # Outlet feeds and loose search engines (Bing) must mention a keyword.
        if src.get("filter_keywords", not is_search):
            items = [i for i in items if keyword_re.search(f"{i['title']} {i['summary']}")]
        if exclude_re:
            items = [i for i in items if not exclude_re.search(f"{i['title']} {i['publisher']}")]
        if not is_search:
            for i in items:
                i["publisher"] = i["publisher"] or name
        return name, items, None
    except Exception as err:  # one broken feed must not stop the run
        return name, [], f"{type(err).__name__}: {err}"[:200]


def clean_publisher(name):
    return re.sub(r"\s+on MSN$", "", name or "").strip()


def normalise(raw, now):
    date = raw["date"] or now
    if date.tzinfo is None:
        date = date.replace(tzinfo=timezone.utc)
    if date > now + timedelta(hours=1):  # bad feed clocks
        date = now
    summary = truncate(raw["summary"])
    item = {
        "id": item_id(raw["url"]),
        "title": raw["title"],
        "url": raw["url"],
        "source": clean_publisher(raw["publisher"]) or raw["via"],
        "via": raw["via"],
        "published": to_utc_iso(date),
        "date_estimated": raw["date"] is None,
        "summary": summary,
        "category": categorize(raw["title"], summary),
    }
    if raw.get("language"):
        item["language"] = raw["language"]
    return item


def merge(existing, fresh, now):
    by_url, by_title = {}, {}
    merged = []

    def add(item, prefer_new):
        u, t = canonical_url(item["url"]), title_key(item["title"])
        old = by_url.get(u) or (by_title.get(t) if len(t) > 20 else None)
        if old is None:
            merged.append(item)
            by_url[u], by_title[t] = item, item
            return
        # Keep the first-seen time; fill gaps and prefer direct links over aggregator redirects.
        if prefer_new and "news.google.com" in old["url"] and "news.google.com" not in item["url"]:
            old["url"], old["id"] = item["url"], item["id"]
        if not old.get("summary") and item.get("summary"):
            old["summary"] = item["summary"]
        if old.get("date_estimated") and not item.get("date_estimated"):
            old["published"], old["date_estimated"] = item["published"], False

    for it in existing:
        add(it, prefer_new=False)
    for it in fresh:
        it.setdefault("first_seen", to_utc_iso(now))
        add(it, prefer_new=True)

    cutoff = to_utc_iso(now - timedelta(days=RETENTION_DAYS))
    merged = [m for m in merged if m["published"] >= cutoff]
    merged.sort(key=lambda m: m["published"], reverse=True)
    return merged[:MAX_ITEMS]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sources", default=ROOT / "scraper" / "sources.json", type=Path)
    ap.add_argument("--out", default=ROOT / "data" / "news.json", type=Path)
    args = ap.parse_args()

    cfg = json.loads(args.sources.read_text())
    keyword_re = re.compile(r"\b(" + "|".join(map(re.escape, cfg["keywords"])) + r")\b", re.I)
    excludes = cfg.get("exclude", [])
    exclude_re = re.compile("|".join(map(re.escape, excludes)), re.I) if excludes else None
    jobs = [(s, True) for s in cfg.get("search", [])] + [(s, False) for s in cfg.get("outlets", [])]

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda j: collect_source(j[0], keyword_re, j[1], exclude_re), jobs))

    now = datetime.now(timezone.utc)
    # Outlets first so their direct links win over search-engine redirects.
    ordered = [r for r, (s, is_search) in zip(results, jobs) if not is_search] + \
              [r for r, (s, is_search) in zip(results, jobs) if is_search]
    fresh = [normalise(raw, now) for _, items, _ in ordered for raw in items]

    existing = []
    if args.out.exists():
        existing = json.loads(args.out.read_text()).get("items", [])
    items = merge(existing, fresh, now)
    if exclude_re:
        items = [i for i in items if not exclude_re.search(f"{i['title']} {i['source']}")]
    for it in items:
        it["category"] = categorize(it["title"], it.get("summary", ""))
        it["source"] = clean_publisher(it["source"]) or it["source"]

    status = [{"name": n, "ok": e is None, "found": len(i), **({"error": e} if e else {})} for n, i, e in results]
    for s in status:
        log(f"  {'ok ' if s['ok'] else 'ERR'} {s['name']}: {s['found']} item(s){' — ' + s['error'] if not s['ok'] else ''}")

    if not any(s["ok"] for s in status):
        sys.exit("Every source failed; leaving the existing file untouched. Check network access.")

    new_count = len({i["id"] for i in items} - {i["id"] for i in existing})
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({
        "generated_at": to_utc_iso(now),
        "new_in_last_run": new_count,
        "sources": status,
        "items": items,
    }, indent=1, ensure_ascii=False) + "\n")
    log(f"{len(items)} stories ({new_count} new) -> {args.out}")


if __name__ == "__main__":
    main()
