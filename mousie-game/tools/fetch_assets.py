#!/usr/bin/env python3
"""Fetch freely licensed real photographs for Mousie's backgrounds.

Reads tools/wanted.json, searches Wikimedia Commons (then Openverse as a fallback),
keeps only Public domain / CC0 / CC BY / CC BY-SA images, and writes:

    assets/bg/<key>.jpg        landscape JPEG, long side <= 1920px, quality 82, no EXIF
    assets/manifest.json       only the "backgrounds" section is touched; every other
                               key (e.g. "characters") is preserved as-is
    assets/CREDITS.md          background + character credits; must ship with the game

Typical use (from mousie-game/):
    python3 -I tools/fetch_assets.py                         # fetch any missing background
    python3 -I tools/fetch_assets.py --candidates 8          # + contact sheets in tools/review/
    python3 -I tools/fetch_assets.py --pick jungle="File:Some forest.jpg" --ground jungle=0.84
    python3 -I tools/fetch_assets.py --ground jungle=0.86    # just change the floor line
    python3 -I tools/fetch_assets.py --refresh all
    python3 -I tools/fetch_assets.py --credits-only          # rewrite CREDITS.md from manifest

Only the Python standard library and Pillow are used. See assets/README.md.
"""
from __future__ import annotations

import argparse
import html
import html.parser
import io
import json
import os
import re
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageStat
except ImportError:  # pragma: no cover
    sys.exit("This tool needs Pillow (python3 -c 'import PIL' must work).")

USER_AGENT = "MousieFamilyGame/1.0 (personal family project)"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
OPENVERSE_API = "https://api.openverse.org/v1/images/"
REQUIRED_HOSTS = [
    ("commons.wikimedia.org", "search + licence metadata (primary source)"),
    ("upload.wikimedia.org", "image downloads"),
    ("api.openverse.org", "fallback search"),
]

TOOLS_DIR = Path(__file__).resolve().parent
GAME_DIR = TOOLS_DIR.parent
DEFAULT_WANTED = TOOLS_DIR / "wanted.json"
DEFAULT_ASSETS = GAME_DIR / "assets"
DEFAULT_REVIEW = TOOLS_DIR / "review"

BG_KEYS = ["jungle", "cave_outside", "cave_inside", "treehouse"]
BG_MAX = 1920
BG_THUMB_WIDTH = 1920          # iiurlwidth: a standard Wikimedia thumb step (non-standard widths get 429s)
JPEG_QUALITY = 82
DEFAULT_GROUND = 0.85
MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024

# Hard rejects on the file title; description/categories only get a penalty.
DEFAULT_REJECT_TERMS = [
    "drawing", "drawn", "cartoon", "clipart", "clip art", "illustration", "logo", "icon",
    "map", "diagram", "sketch", "painting", "comic", "vector", "svg", "chart", "graph",
    "poster", "stamp", "screenshot", "infographic", "sign", "text", "label", "person",
    "people", "man ", "woman", "boy", "girl", "child", "children", "kids", "tourist",
    "hiker", "visitor", "selfie", "portrait", "crowd", "family", "dead", "watermark",
    "render", "3d", "game", "minecraft", "toy", "lego", "model",
]
OK_MIMES = {"image/jpeg", "image/png", "image/webp", "image/tiff"}


# --------------------------------------------------------------------------- errors

class FetchError(Exception):
    """A single request or candidate failed (the run carries on)."""


class HostUnreachable(FetchError):
    def __init__(self, host: str, reason: str):
        super().__init__(f"{host}: {reason}")
        self.host = host
        self.reason = reason


class NetworkUnavailable(Exception):
    """The image sites cannot be reached at all: stop the run with a clear message."""

    def __init__(self, blocked: dict[str, str]):
        self.blocked = dict(blocked)
        super().__init__(network_help(self.blocked))


def network_help(blocked: dict[str, str]) -> str:
    lines = ["Cannot reach the image sites from this machine:"]
    lines += [f"  - {host}: {reason}" for host, reason in blocked.items()]
    lines += ["", "fetch_assets.py needs outbound HTTPS (port 443) to:"]
    lines += [f"  - {host:<24} {why}" for host, why in REQUIRED_HOSTS]
    lines += ["", "Allow those hosts, then re-run from mousie-game/:",
              "  python3 -I tools/fetch_assets.py --candidates 8"]
    return "\n".join(lines)


# --------------------------------------------------------------------------- text helpers

class _TextExtractor(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data):
        self.parts.append(data)

    def handle_starttag(self, tag, attrs):
        if tag in ("br", "p", "div", "li"):
            self.parts.append(" ")


def strip_html(value) -> str:
    """'<a href="..">Jane <b>Doe</b></a> &amp; co' -> 'Jane Doe & co' (whitespace collapsed)."""
    if value is None:
        return ""
    p = _TextExtractor()
    p.feed(str(value))
    p.close()
    text = html.unescape("".join(p.parts))
    return re.sub(r"\s+", " ", text).strip()


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:120] or "_"


def norm_title(title: str) -> str:
    """Accept 'File:X.jpg', 'X.jpg', or a Commons URL; return 'File:X.jpg'."""
    t = title.strip()
    m = re.search(r"commons\.wikimedia\.org/wiki/(File:[^?#]+)", t)
    if m:
        t = urllib.parse.unquote(m.group(1))
    t = t.replace("_", " ")
    if not re.match(r"(?i)^(file|image):", t):
        t = "File:" + t
    return "File:" + t.split(":", 1)[1].strip()


def contains_term(text: str, term: str) -> bool:
    text = " " + re.sub(r"[_\-/.,()\[\]]+", " ", text.lower()) + " "
    term = term.lower()
    if term.endswith(" "):  # trailing space = exact whole word, e.g. "man "
        return re.search(r"\b" + re.escape(term.strip()) + r"\b", text) is not None
    return re.search(r"\b" + re.escape(term) + r"s?\b", text) is not None


# --------------------------------------------------------------------------- licences

@dataclass
class Licence:
    ok: bool
    name: str
    url: str
    reason: str = ""


def _cc_version(s: str) -> str:
    m = re.search(r"(\d\.\d)", s)
    return m.group(1) if m else ""


def classify_licence(short_name: str | None, url: str | None = None,
                     non_free: str | None = None) -> Licence:
    """Whitelist: Public domain / PDM, CC0, CC BY (any version), CC BY-SA (any version).

    Everything else (NC, ND, GFDL-only, unknown, fair use) is rejected.
    """
    short = strip_html(short_name or "")
    url = (url or "").strip()
    s = f"{short} {url}".lower().replace("_", " ")
    if str(non_free or "").lower() in ("true", "1", "yes"):
        return Licence(False, short, url, "marked non-free")
    if not s.strip():
        return Licence(False, "", url, "no licence information")
    if re.search(r"\bnc\b|by-nc|by nc|noncommercial|non-commercial", s):
        return Licence(False, short, url, f"non-commercial licence ({short or url})")
    if re.search(r"\bnd\b|-nd\b|by-nd|noderiv|no derivatives", s):
        return Licence(False, short, url, f"no-derivatives licence ({short or url})")
    if re.search(r"fair use|non-free|nonfree|all rights reserved|copyrighted", s):
        return Licence(False, short, url, f"not free ({short or url})")
    if re.search(r"\bcc0\b|cc-zero|publicdomain/zero", s):
        return Licence(True, "CC0 1.0", url or "https://creativecommons.org/publicdomain/zero/1.0/")
    if re.search(r"public domain|publicdomain/mark|\bpdm\b|^pd\b|\bpd-|\bpd$", s):
        return Licence(True, short if short.lower().startswith("public domain") else "Public domain",
                       url or "https://creativecommons.org/publicdomain/mark/1.0/")
    m_sa = re.search(r"cc[ -]?by[ -]sa[ -]?(\d\.\d)?|licenses/by-sa/(\d\.\d)?", s)
    if m_sa:
        ver = m_sa.group(1) or m_sa.group(2) or _cc_version(s)
        return Licence(True, f"CC BY-SA {ver}".strip(),
                       url or f"https://creativecommons.org/licenses/by-sa/{ver or '4.0'}/")
    m_by = re.search(r"cc[ -]?by(?![ -]?(sa|nc|nd))[ -]?(\d\.\d)?|licenses/by/(\d\.\d)?", s)
    if m_by:
        ver = m_by.group(2) or m_by.group(3) or _cc_version(s)
        return Licence(True, f"CC BY {ver}".strip(),
                       url or f"https://creativecommons.org/licenses/by/{ver or '4.0'}/")
    if "gfdl" in s or "gnu free documentation" in s:
        return Licence(False, short, url, "GFDL-only (not on the whitelist)")
    return Licence(False, short, url, f"licence not on whitelist ({short or url})")


def classify_openverse(code: str, version: str | None, url: str | None) -> Licence:
    code = (code or "").lower()
    version = (version or "").strip()
    if code == "cc0":
        return classify_licence("CC0", url)
    if code == "pdm":
        return classify_licence("Public domain",
                                url or "https://creativecommons.org/publicdomain/mark/1.0/")
    if code in ("by", "by-sa"):
        return classify_licence(f"CC {code.upper()} {version}".strip(), url)
    return Licence(False, code, url or "", f"licence not on whitelist ({code or 'unknown'})")


# --------------------------------------------------------------------------- candidates

@dataclass
class Candidate:
    key: str
    provider: str                  # "commons" | "openverse"
    ident: str                     # File:Title.jpg or openverse id
    title: str                     # human title for the credit
    author: str
    licence: Licence
    source: str                    # description page URL
    url: str                       # sized thumbnail URL to download
    fallback_url: str = ""
    width: int = 0
    height: int = 0
    mime: str = ""
    description: str = ""
    categories: str = ""
    pinned: bool = False
    query_index: int = 0
    rank: int = 0
    score: float = 0.0
    reject: str = ""
    status: str = ""
    image: "Image.Image | None" = None

    @property
    def label(self) -> str:
        return self.ident if self.provider == "commons" else f"openverse:{self.ident}"


def _meta(ext: dict, name: str) -> str:
    v = (ext or {}).get(name) or {}
    return v.get("value", "") if isinstance(v, dict) else str(v)


def commons_pages(data: dict) -> list[dict]:
    pages = (data or {}).get("query", {}).get("pages", [])
    if isinstance(pages, dict):
        pages = list(pages.values())
    return sorted(pages, key=lambda p: p.get("index", 0))


def candidate_from_commons(page: dict, key: str) -> Candidate | None:
    title = page.get("title", "")
    infos = page.get("imageinfo") or []
    if page.get("missing") not in (None, False) or not infos:
        return None
    ii = infos[0]
    ext = ii.get("extmetadata") or {}
    lic = classify_licence(_meta(ext, "LicenseShortName") or _meta(ext, "License"),
                           _meta(ext, "LicenseUrl"), _meta(ext, "NonFree"))
    obj = strip_html(_meta(ext, "ObjectName"))
    base = re.sub(r"\.[A-Za-z0-9]+$", "", title.split(":", 1)[-1])
    author = strip_html(_meta(ext, "Artist")) or strip_html(_meta(ext, "Credit")) \
        or "Unknown (see source page)"
    return Candidate(
        key=key, provider="commons", ident=title, title=obj or base, author=author,
        licence=lic,
        source=ii.get("descriptionurl") or
        "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_")),
        url=ii.get("thumburl") or ii.get("url") or "",
        width=int(ii.get("width") or 0), height=int(ii.get("height") or 0),
        mime=ii.get("mime", ""),
        description=strip_html(_meta(ext, "ImageDescription")),
        categories=_meta(ext, "Categories").replace("|", " | "),
    )


def candidate_from_openverse(item: dict, key: str) -> Candidate:
    lic = classify_openverse(item.get("license", ""), item.get("license_version"),
                             item.get("license_url"))
    ftype = (item.get("filetype") or "").lower()
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
            "webp": "image/webp", "svg": "image/svg+xml", "gif": "image/gif"}.get(ftype, "")
    tags = " ".join(t.get("name", "") for t in item.get("tags") or [] if isinstance(t, dict))
    return Candidate(
        key=key, provider="openverse", ident=str(item.get("id", "")),
        title=strip_html(item.get("title")) or "Untitled",
        author=strip_html(item.get("creator")) or "Unknown (see source page)",
        licence=lic, source=item.get("foreign_landing_url") or item.get("url", ""),
        url=item.get("url", ""), fallback_url=item.get("thumbnail") or "",
        width=int(item.get("width") or 0), height=int(item.get("height") or 0),
        mime=mime, description=tags,
    )


def score_candidate(c: Candidate, spec: dict, reject_terms: list[str]) -> None:
    """Fill c.score and c.reject from metadata only (no download)."""
    if not c.licence.ok:
        c.reject = "licence: " + c.licence.reason
        return
    if not c.url:
        c.reject = "no image URL"
        return
    if c.mime and c.mime not in OK_MIMES:
        c.reject = f"unsupported type {c.mime}"
        return
    name = f"{c.ident} {c.title}"
    soft = f"{c.description} {c.categories}"
    allow = [t.lower() for t in spec.get("allow_terms", [])]
    terms = [t for t in reject_terms if t.lower().strip() not in allow]
    score = 0.0
    if not c.pinned:
        for t in terms:
            if contains_term(name, t):
                c.reject = f"title suggests unwanted content ('{t.strip()}')"
                return
        for t in terms:
            if contains_term(soft, t):
                score -= 20
    for t in spec.get("avoid_terms", []):
        if contains_term(name, t):
            score -= 40
        elif contains_term(soft, t):
            score -= 15
    for t in spec.get("prefer_terms", []):
        if contains_term(name, t):
            score += 25
        elif contains_term(soft, t):
            score += 10
    w, h = c.width, c.height
    if w and h and not c.pinned:
        aspect = w / h
        if aspect < float(spec.get("min_aspect", 1.3)):
            c.reject = f"not landscape enough ({w}x{h})"
            return
        if w < int(spec.get("min_width_hard", 1200)):
            c.reject = f"too small ({w}x{h})"
            return
        score += 30 if 1.45 <= aspect <= 2.4 else 10
        score += 30 if w >= 2000 else 10
    score -= c.query_index * 6 + c.rank * 1.0
    if c.pinned:
        score += 1000
    c.score = score


# --------------------------------------------------------------------------- image processing

def open_image(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img.load()
    try:
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass
    return img


def process_background(data: bytes, spec: dict, pinned: bool = False) -> Image.Image:
    """Decode, sanity-check and resize to long side <= BG_MAX. Returns an RGB image."""
    rgb = open_image(data).convert("RGB")
    w, h = rgb.size
    if w <= h:
        raise FetchError(f"not landscape ({w}x{h})")
    if not pinned and w / h < float(spec.get("min_aspect", 1.3)):
        raise FetchError(f"not landscape enough ({w}x{h})")
    if w < 960:
        raise FetchError(f"downloaded image too small ({w}x{h})")
    mean = ImageStat.Stat(rgb.convert("L").resize((64, 36))).mean[0]
    if not pinned and mean < float(spec.get("min_brightness", 45)):
        raise FetchError(f"too dark (mean brightness {mean:.0f}/255)")
    if max(rgb.size) > BG_MAX:
        rgb.thumbnail((BG_MAX, BG_MAX), Image.Resampling.LANCZOS)
    return rgb


def encode_jpeg(img: Image.Image) -> bytes:
    """Re-encode as a fresh JPEG; no exif=/icc_profile= argument, so all metadata is gone."""
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
    return buf.getvalue()


# --------------------------------------------------------------------------- network

class Fetcher:
    """Polite sequential HTTP client: User-Agent, delay, retries with backoff, timeouts."""

    def __init__(self, delay: float = 1.0, timeout: float = 40.0, retries: int = 4, log=print):
        self.delay = delay
        self.timeout = timeout
        self.retries = retries
        self.log = log
        self.blocked: dict[str, str] = {}
        self.requests: list[str] = []
        self._last = 0.0
        ctx = ssl.create_default_context()
        for var in ("MOUSIE_CA_BUNDLE", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
            path = os.environ.get(var)
            if path and os.path.isfile(path):
                try:
                    ctx.load_verify_locations(path)
                except (ssl.SSLError, OSError):
                    pass
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler(), urllib.request.HTTPSHandler(context=ctx))

    @staticmethod
    def build_request(url: str) -> urllib.request.Request:
        return urllib.request.Request(url, headers={
            "User-Agent": USER_AGENT, "Accept-Encoding": "identity"})

    def _wait(self):
        gap = time.monotonic() - self._last
        if gap < self.delay:
            time.sleep(self.delay - gap)
        self._last = time.monotonic()

    def _http_get(self, url: str) -> bytes:
        host = urllib.parse.urlparse(url).hostname or "?"
        if host in self.blocked:
            raise HostUnreachable(host, self.blocked[host])
        backoff = 2.0
        for attempt in range(self.retries + 1):
            self._wait()
            self.requests.append(url)
            try:
                with self.opener.open(self.build_request(url), timeout=self.timeout) as r:
                    data = r.read(MAX_DOWNLOAD_BYTES + 1)
                if len(data) > MAX_DOWNLOAD_BYTES:
                    raise FetchError(f"download too large: {url}")
                return data
            except urllib.error.HTTPError as e:
                if (e.code == 429 or 500 <= e.code < 600) and attempt < self.retries:
                    ra = e.headers.get("Retry-After") if e.headers else None
                    wait = float(ra) if ra and ra.isdigit() else backoff
                    self.log(f"    HTTP {e.code} from {host}; retrying in {wait:.0f}s")
                    time.sleep(min(wait, 120))
                    backoff *= 2
                    continue
                raise FetchError(f"HTTP {e.code} for {url}") from None
            except urllib.error.URLError as e:
                reason = str(getattr(e, "reason", e))
                if isinstance(getattr(e, "reason", None), TimeoutError) and attempt < self.retries:
                    time.sleep(backoff)
                    backoff *= 2
                    continue
                self.blocked[host] = reason
                raise HostUnreachable(host, reason) from None
            except (TimeoutError, ConnectionError) as e:
                if attempt < self.retries:
                    time.sleep(backoff)
                    backoff *= 2
                    continue
                self.blocked[host] = str(e) or type(e).__name__
                raise HostUnreachable(host, self.blocked[host]) from None
        raise FetchError(f"giving up on {url}")

    def get_json(self, url: str) -> dict:
        data = self._http_get(url)
        try:
            return json.loads(data.decode("utf-8"))
        except ValueError:
            raise FetchError(f"bad JSON from {url}") from None

    def get_bytes(self, url: str) -> bytes:
        return self._http_get(url)


def commons_params(**extra) -> dict:
    p = {
        "action": "query", "format": "json", "formatversion": "2",
        "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata",
        "iiurlwidth": str(BG_THUMB_WIDTH), "iiextmetadatalanguage": "en",
        "iiextmetadatafilter": "LicenseShortName|License|LicenseUrl|Artist|Credit|"
                               "ObjectName|ImageDescription|Categories|NonFree",
    }
    p.update(extra)
    return p


def commons_search_url(query: str, limit: int = 30) -> str:
    return COMMONS_API + "?" + urllib.parse.urlencode(commons_params(
        generator="search", gsrsearch=query, gsrnamespace="6", gsrlimit=str(limit)))


def commons_titles_url(titles: list[str]) -> str:
    return COMMONS_API + "?" + urllib.parse.urlencode(commons_params(
        titles="|".join(titles), redirects="1"))


def openverse_url(query: str, limit: int = 20) -> str:
    q = re.sub(r"\b\w+:(\"[^\"]*\"|\S+)", " ", query)  # drop Commons search keywords
    q = re.sub(r"\s+", " ", q).strip()
    p = {"q": q, "license": "cc0,pdm,by,by-sa", "page_size": str(limit), "mature": "false",
         "category": "photograph", "aspect_ratio": "wide"}
    return OPENVERSE_API + "?" + urllib.parse.urlencode(p)


class OfflineFetcher(Fetcher):
    """Serves canned responses from a fixture directory (used by tests).

    Layout:
      commons/search/<slug(gsrsearch)>.json   generator=search responses
      commons/titles/<slug(File:Title)>.json  one page per pinned/picked title
      openverse/<slug(q)>.json                Openverse search responses
      files/<url basename>                    image bytes
    Missing search files mean "no results"; a missing image file is a 404.
    """

    def __init__(self, root, log=print):
        super().__init__(delay=0, log=log)
        self.root = Path(root)

    def _http_get(self, url: str) -> bytes:
        self.requests.append(url)
        u = urllib.parse.urlparse(url)
        q = dict(urllib.parse.parse_qsl(u.query))
        if u.hostname == "commons.wikimedia.org":
            if "gsrsearch" in q:
                f = self.root / "commons" / "search" / f"{slug(q['gsrsearch'])}.json"
                return f.read_bytes() if f.exists() else b'{"batchcomplete": true}'
            pages = []
            for t in q.get("titles", "").split("|"):
                f = self.root / "commons" / "titles" / f"{slug(norm_title(t))}.json"
                if f.exists():
                    pages.extend(commons_pages(json.loads(f.read_text())))
                else:
                    pages.append({"title": norm_title(t), "missing": True})
            return json.dumps({"query": {"pages": pages}}).encode()
        if u.hostname == "api.openverse.org":
            f = self.root / "openverse" / f"{slug(q.get('q', ''))}.json"
            return f.read_bytes() if f.exists() else b'{"results": []}'
        name = urllib.parse.unquote(u.path.rsplit("/", 1)[-1])
        f = self.root / "files" / name
        if not f.exists():
            raise FetchError(f"HTTP 404 for {url}")
        return f.read_bytes()


# --------------------------------------------------------------------------- manifest + credits

def atomic_write(path: Path, data: bytes) -> None:
    """Write via a temp file in the same folder + os.replace, so readers never see half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_manifest(assets: Path) -> dict:
    """Read manifest.json as-is (all keys kept). Missing -> {}. Corrupt -> error (never clobber)."""
    p = assets / "manifest.json"
    if not p.exists():
        return {}
    m = json.loads(p.read_text())
    if not isinstance(m, dict):
        raise ValueError(f"{p} is not a JSON object")
    return m


def merge_backgrounds(assets: Path, updates: dict, removals=()) -> dict:
    """Read-modify-write: re-read the manifest from disk right now, change only the
    'backgrounds' section, keep every other key untouched, write atomically."""
    m = load_manifest(assets)
    bgs = dict(m.get("backgrounds") or {})
    for k in removals:
        bgs.pop(k, None)
    bgs.update(updates)
    ordered = {k: bgs[k] for k in BG_KEYS if k in bgs}
    ordered.update({k: v for k, v in bgs.items() if k not in ordered})
    m["backgrounds"] = ordered
    atomic_write(assets / "manifest.json", (json.dumps(m, indent=2, ensure_ascii=False) + "\n")
                 .encode("utf-8"))
    return m


BG_LABELS = {"jungle": "Jungle", "cave_outside": "Cave (outside)",
             "cave_inside": "Cave (inside)", "treehouse": "Treehouse"}


def _md(text) -> str:
    return str(text or "").replace("|", "\\|").replace("\n", " ")


def credits_markdown(manifest: dict) -> str:
    lines = [
        "# Credits",
        "",
        "This file must ship with the game (the photo licences require attribution).",
        "",
    ]
    bgs = manifest.get("backgrounds") or {}
    if bgs:
        lines += [
            "## Background photographs",
            "",
            "Real photographs from Wikimedia Commons / Openverse, used under the licences below.",
            "Changes: resized (long side at most 1920px) and re-encoded as JPEG; no other edits.",
            "Photos under CC BY-SA remain under that licence.",
            "",
            "| Scene | File | Title | Author | Licence | Source |",
            "|---|---|---|---|---|---|",
        ]
        for key, e in bgs.items():
            c = e.get("credit") or {}
            lic = f"[{_md(c.get('license'))}]({c['licenseUrl']})" if c.get("licenseUrl") \
                else _md(c.get("license"))
            lines.append(f"| {BG_LABELS.get(key, key)} | `{_md(e.get('file'))}` | "
                         f"{_md(c.get('title'))} | {_md(c.get('author'))} | {lic} | "
                         f"<{c.get('source', '')}> |")
        lines.append("")
    chars = manifest.get("characters") or {}
    if chars:
        lines += ["## Characters", "",
                  "Painted by hand for the original Mousie comic.", "",
                  "| Character | File | Title | Author | Licence | Source |",
                  "|---|---|---|---|---|---|"]
        for key, e in chars.items():
            c = e.get("credit") or {}
            lic = f"[{_md(c.get('license'))}]({c['licenseUrl']})" if c.get("licenseUrl") \
                else _md(c.get("license"))
            lines.append(f"| {_md(key)} | `{_md(e.get('file', ''))}` | {_md(c.get('title'))} | "
                         f"{_md(c.get('author'))} | {lic} | {_md(c.get('source'))} |")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def write_credits(assets: Path) -> None:
    atomic_write(assets / "CREDITS.md", credits_markdown(load_manifest(assets)).encode("utf-8"))


# --------------------------------------------------------------------------- pipeline

def ground_for(spec: dict, ident: str, override: float | None = None) -> float:
    """Floor line (fraction of height): CLI override > per-file value > key default."""
    if override is not None:
        g = override
    else:
        g = (spec.get("ground") or {}).get(ident, spec.get("default_ground", DEFAULT_GROUND))
    g = float(g)
    if not 0.3 <= g <= 1.0:
        raise ValueError(f"ground must be between 0.3 and 1.0, got {g}")
    return round(g, 3)


class Pipeline:
    def __init__(self, wanted: dict, fetcher: Fetcher, assets: Path, review: Path,
                 dry_run=False, candidates=0, max_attempts=10, log=print):
        self.wanted = wanted
        self.f = fetcher
        self.assets = assets
        self.review = review
        self.dry_run = dry_run
        self.n_sheet = candidates
        self.max_attempts = max_attempts
        self.log = log
        self.reject_terms = DEFAULT_REJECT_TERMS + list(wanted.get("reject_terms", []))
        self.downloads = 0

    def spec(self, key) -> dict:
        return self.wanted["backgrounds"][key]

    # ---- search
    def _commons(self, url, key, query_index, pinned=False):
        try:
            data = self.f.get_json(url)
        except HostUnreachable:
            raise
        except FetchError as e:
            self.log(f"    search failed: {e}")
            return []
        out = []
        for rank, page in enumerate(commons_pages(data)):
            c = candidate_from_commons(page, key)
            if c is None:
                if pinned:
                    self.log(f"    pinned file not found on Commons: {page.get('title')}")
                continue
            c.pinned, c.query_index, c.rank = pinned, query_index, rank
            out.append(c)
        return out

    def gather_commons(self, key, spec, forced: str | None):
        if forced:
            return self._commons(commons_titles_url([forced]), key, 0, True)
        cands = []
        pins = [norm_title(t) for t in spec.get("pin", [])]
        if pins:
            cands += self._commons(commons_titles_url(pins), key, 0, True)
        for qi, q in enumerate(spec.get("queries", [])):
            cands += self._commons(commons_search_url(q), key, qi)
        return cands

    def gather_openverse(self, key, spec):
        cands = []
        for qi, q in enumerate(spec.get("openverse_queries") or spec.get("queries", [])[:3]):
            try:
                data = self.f.get_json(openverse_url(q))
            except HostUnreachable:
                raise
            except FetchError as e:
                self.log(f"    openverse search failed: {e}")
                continue
            for rank, item in enumerate(data.get("results") or []):
                c = candidate_from_openverse(item, key)
                c.query_index, c.rank = qi, rank
                cands.append(c)
        return cands

    @staticmethod
    def dedupe(cands):
        seen, out = set(), []
        for c in cands:
            k = c.source or c.url
            if k not in seen:
                seen.add(k)
                out.append(c)
        return out

    # ---- evaluation
    def evaluate(self, c: Candidate, spec: dict) -> bool:
        data = None
        for u in [u for u in (c.url, c.fallback_url) if u]:
            try:
                data = self.f.get_bytes(u)
                self.downloads += 1
                break
            except HostUnreachable as e:
                if e.host == "upload.wikimedia.org":
                    raise NetworkUnavailable(self.f.blocked)
                c.status = f"download blocked ({e.host})"
            except FetchError as e:
                c.status = f"download failed ({e})"
        if data is None:
            return False
        try:
            c.image = process_background(data, spec, c.pinned)
        except FetchError as e:
            c.status = str(e)
            return False
        except Exception as e:  # corrupt / unsupported image
            c.status = f"unreadable image ({type(e).__name__})"
            return False
        c.status = "ok"
        return True

    def choose(self, key, spec, forced=None):
        pool = self.gather_commons(key, spec, forced)
        if forced and not pool:
            return None, [], f"--pick title not found on Commons: {forced}"
        chosen, tried, reasons = None, [], []

        def run(pool):
            nonlocal chosen
            pool = self.dedupe(pool)
            for c in pool:
                score_candidate(c, spec, self.reject_terms)
            ok = sorted([c for c in pool if not c.reject], key=lambda c: -c.score)
            reasons.extend(f"{c.label}: {c.reject}" for c in pool if c.reject)
            attempts = 0
            for c in ok:
                if chosen and len(tried) >= self.n_sheet:
                    break
                if attempts >= max(self.max_attempts, self.n_sheet):
                    break
                attempts += 1
                good = self.evaluate(c, spec)
                tried.append(c)
                if not good:
                    reasons.append(f"{c.label}: {c.status}")
                elif not chosen:
                    chosen = c

        run(pool)
        if not forced and (not chosen or len(tried) < self.n_sheet):
            try:
                run(self.gather_openverse(key, spec))
            except HostUnreachable as e:
                self.log(f"    openverse unreachable: {e.reason}")
        if not pool and not forced and "commons.wikimedia.org" in self.f.blocked \
                and "api.openverse.org" in self.f.blocked:
            raise NetworkUnavailable(self.f.blocked)
        why = ""
        if not chosen:
            why = ("no usable candidate; last reasons: " + "; ".join(reasons[-4:])) \
                if reasons else "no search results"
        return chosen, tried, why

    # ---- outputs
    @staticmethod
    def entry(key, c: Candidate, ground: float) -> dict:
        return {"file": f"bg/{key}.jpg", "w": c.image.width, "h": c.image.height,
                "ground": ground,
                "credit": {"title": c.title, "author": c.author, "license": c.licence.name,
                           "licenseUrl": c.licence.url, "source": c.source}}

    def contact_sheet(self, key, cands: list[Candidate], chosen, spec):
        if not cands:
            return
        cands = cands[:max(self.n_sheet, 1)]
        tw, th, pad, text_h = 480, 270, 10, 62
        cols = min(2, len(cands))
        rows = (len(cands) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * (tw + pad) + pad, rows * (th + text_h + pad) + pad),
                          (40, 40, 48))
        draw = ImageDraw.Draw(sheet)
        try:
            font = ImageFont.load_default(size=13)
        except TypeError:
            font = ImageFont.load_default()
        lines_txt = []
        for i, c in enumerate(cands):
            x = pad + (i % cols) * (tw + pad)
            y = pad + (i // cols) * (th + text_h + pad)
            if c.image is not None:
                im = ImageOps.fit(c.image, (tw, th), Image.Resampling.BILINEAR)  # 16:9 crop
                sheet.paste(im, (x, y))
                gy = y + round(ground_for(spec, c.ident) * th)
                draw.line((x, gy, x + tw, gy), fill=(255, 40, 40), width=1)
            colour = (120, 230, 120) if c is chosen else (240, 240, 240) if c.image \
                else (255, 130, 130)
            if c is chosen:
                draw.rectangle((x - 3, y - 3, x + tw + 2, y + th + 2), outline=colour, width=3)
            label = [f"#{i + 1} {'CHOSEN ' if c is chosen else ''}score {c.score:.0f}  "
                     f"{c.licence.name}  {c.width}x{c.height}", c.label[:70],
                     (c.status or "")[:70]]
            for j, t in enumerate(label):
                draw.text((x, y + th + 4 + j * 18), t, fill=colour, font=font)
            lines_txt.append(f"#{i + 1}\t{'CHOSEN' if c is chosen else ''}\tscore={c.score:.0f}\t"
                             f"{c.licence.name}\t{c.width}x{c.height}\t{c.label}\t{c.author}\t"
                             f"{c.status}\t{c.source}")
        self.review.mkdir(parents=True, exist_ok=True)
        buf = io.BytesIO()
        sheet.save(buf, "PNG")
        atomic_write(self.review / f"{key}.png", buf.getvalue())
        atomic_write(self.review / f"{key}.txt", ("\n".join(lines_txt) + "\n").encode())
        self.log(f"    contact sheet: {self.review / (key + '.png')}")

    def run(self, keys, refresh: set, picks: dict, grounds: dict) -> int:
        manifest = load_manifest(self.assets)
        existing_bgs = manifest.get("backgrounds") or {}
        report, failed = [], []
        for key in keys:
            spec = self.spec(key)
            existing = existing_bgs.get(key)
            have = bool(existing) and (self.assets / existing.get("file", "")).is_file()
            if have and key not in refresh and key not in picks and not self.n_sheet:
                if key in grounds:
                    existing = dict(existing, ground=ground_for(spec, "", grounds[key]))
                    if not self.dry_run:
                        merge_backgrounds(self.assets, {key: existing})
                    report.append(f"{key:<13} kept, ground set to {existing['ground']}")
                else:
                    report.append(f"{key:<13} kept      {existing['credit'].get('license', '')}"
                                  f"  {existing['credit'].get('source', '')}")
                continue
            self.log(f"[{key}] searching...")
            chosen, tried, why = self.choose(key, spec, picks.get(key))
            if self.n_sheet:
                self.contact_sheet(key, tried, chosen, spec)
            if have and key not in refresh and key not in picks:
                report.append(f"{key:<13} kept (review only; use --refresh {key} or --pick)")
                continue
            if not chosen:
                failed.append(f"{key}: {why}")
                report.append(f"{key:<13} FAILED    {why}")
                continue
            entry = self.entry(key, chosen, ground_for(spec, chosen.ident, grounds.get(key)))
            report.append(f"{key:<13} {'would use' if self.dry_run else 'chosen   '} "
                          f"{chosen.licence.name:<14} {chosen.label}  "
                          f"[{entry['w']}x{entry['h']} ground={entry['ground']}]  "
                          f"by {chosen.author}")
            if not self.dry_run:
                atomic_write(self.assets / entry["file"], encode_jpeg(chosen.image))
                merge_backgrounds(self.assets, {key: entry})
        if not self.dry_run:
            write_credits(self.assets)
        self.log("")
        self.log("=" * 72)
        self.log("REPORT" + (" (dry run: nothing written)" if self.dry_run else ""))
        for line in report:
            self.log("  " + line)
        if failed:
            self.log("")
            self.log(f"{len(failed)} key(s) failed. Try --candidates 8 to review options, "
                     "add queries/pins in tools/wanted.json, or force one with --pick.")
        self.log(f"({len(self.f.requests)} HTTP requests, {self.downloads} images downloaded)")
        return 1 if failed else 0


# --------------------------------------------------------------------------- CLI

def parse_kv(values, what):
    out = {}
    for v in values or []:
        if "=" not in v:
            raise SystemExit(f"{what} must look like key=value, got {v!r}")
        k, val = v.split("=", 1)
        out[k.strip()] = val.strip().strip('"').strip("'")
    return out


def split_keys(values):
    out = []
    for v in values or []:
        out += [k.strip() for k in v.split(",") if k.strip()]
    return out


def main(argv=None, log=print) -> int:
    ap = argparse.ArgumentParser(
        description="Fetch freely licensed background photos for Mousie (see assets/README.md).")
    ap.add_argument("--only", action="append", help="comma-separated keys to process")
    ap.add_argument("--refresh", action="append",
                    help="comma-separated keys to re-fetch even if present ('all' for every key)")
    ap.add_argument("--candidates", type=int, default=0, metavar="N",
                    help="evaluate the top N candidates per key and save contact sheets "
                         "(review only for keys that already exist unless --refresh/--pick)")
    ap.add_argument("--pick", action="append", metavar='KEY="File:Title.jpg"',
                    help="force a specific Commons file for a key (licence still checked)")
    ap.add_argument("--ground", action="append", metavar="KEY=0.85",
                    help="set the floor line (fraction of image height) for a key")
    ap.add_argument("--credits-only", action="store_true",
                    help="only regenerate assets/CREDITS.md from manifest.json")
    ap.add_argument("--dry-run", action="store_true",
                    help="search, download and evaluate, but write nothing to assets/")
    ap.add_argument("--offline-fixture", metavar="DIR", help="serve canned responses from DIR")
    ap.add_argument("--wanted", default=str(DEFAULT_WANTED), help="wanted list (JSON)")
    ap.add_argument("--assets-dir", default=str(DEFAULT_ASSETS))
    ap.add_argument("--review-dir", default=str(DEFAULT_REVIEW))
    ap.add_argument("--max-attempts", type=int, default=10,
                    help="max images downloaded per key before giving up (default 10)")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests")
    a = ap.parse_args(argv)

    if a.credits_only:
        write_credits(Path(a.assets_dir))
        log(f"wrote {Path(a.assets_dir) / 'CREDITS.md'}")
        return 0
    try:
        wanted = json.loads(Path(a.wanted).read_text())
    except (OSError, ValueError) as e:
        log(f"ERROR: cannot read wanted list {a.wanted}: {e}")
        return 2
    all_keys = list(wanted.get("backgrounds", {}))
    keys = split_keys(a.only) or list(all_keys)
    refresh = set(split_keys(a.refresh))
    if "all" in refresh:
        refresh = set(all_keys)
    picks = {k: norm_title(v) for k, v in parse_kv(a.pick, "--pick").items()}
    try:
        grounds = {k: float(v) for k, v in parse_kv(a.ground, "--ground").items()}
        for k, v in grounds.items():
            ground_for({}, "", v)
    except ValueError as e:
        log(f"ERROR: --ground: {e}")
        return 2
    for k in list(keys) + list(refresh) + list(picks) + list(grounds):
        if k not in all_keys:
            log(f"ERROR: unknown key {k!r}. Known: {', '.join(all_keys)}")
            return 2
    for k in list(picks) + list(grounds):
        if k not in keys:
            keys.append(k)
    try:
        load_manifest(Path(a.assets_dir))
    except ValueError as e:
        log(f"ERROR: manifest.json is not valid JSON; refusing to overwrite it: {e}")
        return 2

    fetcher = OfflineFetcher(a.offline_fixture, log=log) if a.offline_fixture \
        else Fetcher(delay=a.delay, log=log)
    pipe = Pipeline(wanted, fetcher, Path(a.assets_dir), Path(a.review_dir),
                    dry_run=a.dry_run, candidates=max(0, a.candidates),
                    max_attempts=a.max_attempts, log=log)
    try:
        return pipe.run(keys, refresh, picks, grounds)
    except NetworkUnavailable as e:
        log("")
        log("ERROR: " + str(e))
        return 3


if __name__ == "__main__":
    sys.exit(main())
