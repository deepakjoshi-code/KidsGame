#!/usr/bin/env python3
"""Offline tests for fetch_assets.py (no network: canned Commons/Openverse fixtures).

Run from mousie-game/:
    python3 -I -m unittest discover -s tools -p "test_fetch_assets.py" -v
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_assets as fa  # noqa: E402

from PIL import Image  # noqa: E402

CHARACTERS = {
    "mousie": {"file": "chars/mousie.png", "w": 765, "h": 900, "facing": "right", "feet": 0.991,
               "credit": {"title": "Mousie walking", "author": "Samar (age 6)",
                          "license": "Family artwork, all rights reserved", "licenseUrl": "",
                          "source": "Mousie, Part 1 (page 1)"}},
}


def jpeg_with_exif(w=2400, h=1350, colour=(60, 140, 60)) -> bytes:
    img = Image.new("RGB", (w, h), colour)
    exif = Image.Exif()
    exif[0x010F] = "SecretCameraMaker"   # Make
    exif[0x0131] = "SecretSoftware"      # Software
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif.tobytes())
    return buf.getvalue()


def commons_page(title, thumb, licence="CC BY-SA 4.0",
                 licence_url="https://creativecommons.org/licenses/by-sa/4.0",
                 artist='<a href="//commons.wikimedia.org/wiki/User:Jane">Jane <b>Doe</b></a> &amp; co',
                 w=4000, h=2250, index=1):
    return {"title": title, "index": index, "imageinfo": [{
        "thumburl": thumb, "url": thumb, "width": w, "height": h, "mime": "image/jpeg",
        "descriptionurl": "https://commons.wikimedia.org/wiki/" + title.replace(" ", "_"),
        "extmetadata": {
            "LicenseShortName": {"value": licence}, "LicenseUrl": {"value": licence_url},
            "Artist": {"value": artist}, "ObjectName": {"value": title[5:-4]},
            "ImageDescription": {"value": "<p>A rainforest path</p>"},
            "Categories": {"value": "Rainforests|Trails"}}}]}


class LicenceTests(unittest.TestCase):
    def test_allowed(self):
        for name, url, want in [
            ("CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0", "CC BY-SA 4.0"),
            ("CC BY 2.0", "https://creativecommons.org/licenses/by/2.0", "CC BY 2.0"),
            ("CC BY-SA 3.0", "", "CC BY-SA 3.0"),
            ("CC0", "", "CC0 1.0"),
            ("Public domain", "", "Public domain"),
            ("", "https://creativecommons.org/publicdomain/mark/1.0/", "Public domain"),
        ]:
            lic = fa.classify_licence(name, url)
            self.assertTrue(lic.ok, f"{name} {url}: {lic.reason}")
            self.assertEqual(lic.name, want)

    def test_rejected(self):
        for name, url in [
            ("CC BY-NC 2.0", "https://creativecommons.org/licenses/by-nc/2.0"),
            ("CC BY-NC-SA 4.0", ""),
            ("CC BY-ND 4.0", ""),
            ("GFDL", "https://www.gnu.org/copyleft/fdl.html"),
            ("", ""),
            ("Some custom licence", ""),
            ("Fair use", ""),
        ]:
            self.assertFalse(fa.classify_licence(name, url).ok, name or url or "empty")
        self.assertFalse(fa.classify_licence("CC BY 4.0", "", non_free="true").ok)

    def test_openverse(self):
        self.assertTrue(fa.classify_openverse("by-sa", "2.0", None).ok)
        self.assertTrue(fa.classify_openverse("cc0", "1.0", None).ok)
        self.assertTrue(fa.classify_openverse("pdm", "", None).ok)
        self.assertFalse(fa.classify_openverse("by-nc", "2.0", None).ok)
        self.assertFalse(fa.classify_openverse("by-nd", "4.0", None).ok)
        self.assertFalse(fa.classify_openverse("", None, None).ok)

    def test_nonfree_candidate_rejected_before_download(self):
        page = commons_page("File:Jungle path.jpg", "https://upload.wikimedia.org/x/a.jpg",
                            licence="CC BY-NC 2.0", licence_url="")
        c = fa.candidate_from_commons(page, "jungle")
        fa.score_candidate(c, {}, fa.DEFAULT_REJECT_TERMS)
        self.assertTrue(c.reject.startswith("licence"))


class TextTests(unittest.TestCase):
    def test_strip_html(self):
        self.assertEqual(fa.strip_html('<a href="x">Jane <b>Doe</b></a> &amp; co'), "Jane Doe & co")
        self.assertEqual(fa.strip_html("<span>A</span><br/>B\n\n C"), "A B C")
        self.assertEqual(fa.strip_html(None), "")

    def test_author_html_stripped_in_candidate(self):
        c = fa.candidate_from_commons(
            commons_page("File:Jungle path.jpg", "https://upload.wikimedia.org/x/a.jpg"), "jungle")
        self.assertEqual(c.author, "Jane Doe & co")
        self.assertNotIn("<", c.author)

    def test_norm_title(self):
        self.assertEqual(fa.norm_title("Foo_bar.jpg"), "File:Foo bar.jpg")
        self.assertEqual(fa.norm_title("https://commons.wikimedia.org/wiki/File:A_b.jpg"),
                         "File:A b.jpg")

    def test_reject_terms_in_title(self):
        page = commons_page("File:Tourists on a jungle path.jpg", "https://upload.wikimedia.org/a.jpg")
        c = fa.candidate_from_commons(page, "jungle")
        fa.score_candidate(c, {}, fa.DEFAULT_REJECT_TERMS)
        self.assertIn("tourist", c.reject)

    def test_user_agent(self):
        req = fa.Fetcher.build_request("https://commons.wikimedia.org/w/api.php")
        self.assertEqual(req.get_header("User-agent"), "MousieFamilyGame/1.0 (personal family project)")

    def test_thumbnail_width_requested(self):
        self.assertIn("iiurlwidth=1920", fa.commons_search_url("jungle"))


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.assets = Path(self.tmp.name) / "assets"
        self.assets.mkdir()
        self.original = {"characters": CHARACTERS, "version": 3, "extra": {"keep": [1, 2]}}
        (self.assets / "manifest.json").write_text(json.dumps(self.original, indent=2))

    def tearDown(self):
        self.tmp.cleanup()

    def entry(self, key="jungle"):
        return {"file": f"bg/{key}.jpg", "w": 1920, "h": 1080, "ground": 0.84,
                "credit": {"title": "t", "author": "a", "license": "CC0 1.0",
                           "licenseUrl": "u", "source": "s"}}

    def test_merge_preserves_other_keys(self):
        fa.merge_backgrounds(self.assets, {"jungle": self.entry()})
        m = json.loads((self.assets / "manifest.json").read_text())
        self.assertEqual(m["characters"], CHARACTERS)
        self.assertEqual(m["version"], 3)
        self.assertEqual(m["extra"], {"keep": [1, 2]})
        self.assertEqual(m["backgrounds"]["jungle"]["ground"], 0.84)

    def test_merge_rereads_disk(self):
        """Another agent edits 'characters' between our runs: their change survives."""
        fa.merge_backgrounds(self.assets, {"jungle": self.entry()})
        m = json.loads((self.assets / "manifest.json").read_text())
        m["characters"]["daddy"] = {"file": "chars/daddy.png"}
        (self.assets / "manifest.json").write_text(json.dumps(m))
        fa.merge_backgrounds(self.assets, {"treehouse": self.entry("treehouse")})
        m2 = json.loads((self.assets / "manifest.json").read_text())
        self.assertIn("daddy", m2["characters"])
        self.assertEqual(list(m2["backgrounds"]), ["jungle", "treehouse"])

    def test_corrupt_manifest_not_clobbered(self):
        (self.assets / "manifest.json").write_text("{not json")
        with self.assertRaises(ValueError):
            fa.merge_backgrounds(self.assets, {"jungle": self.entry()})
        self.assertEqual((self.assets / "manifest.json").read_text(), "{not json")

    def test_atomic_write_uses_replace_and_leaves_no_temp(self):
        target = self.assets / "x.json"
        target.write_text("old")
        with mock.patch.object(fa.os, "replace", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                fa.atomic_write(target, b"new")
        self.assertEqual(target.read_text(), "old")
        self.assertEqual([p.name for p in self.assets.iterdir() if p.name.endswith(".tmp")], [])
        fa.atomic_write(target, b"new")
        self.assertEqual(target.read_text(), "new")

    def test_credits_include_characters(self):
        fa.merge_backgrounds(self.assets, {"jungle": self.entry()})
        fa.write_credits(self.assets)
        text = (self.assets / "CREDITS.md").read_text()
        self.assertIn("Background photographs", text)
        self.assertIn("Samar (age 6)", text)
        self.assertIn("chars/mousie.png", text)

    def test_ground_validation(self):
        self.assertEqual(fa.ground_for({"default_ground": 0.8}, "File:A.jpg"), 0.8)
        self.assertEqual(fa.ground_for({"ground": {"File:A.jpg": 0.9}}, "File:A.jpg"), 0.9)
        self.assertEqual(fa.ground_for({"ground": {"File:A.jpg": 0.9}}, "File:A.jpg", 0.7), 0.7)
        with self.assertRaises(ValueError):
            fa.ground_for({}, "", 1.5)


class PipelineTests(unittest.TestCase):
    """End to end against an offline fixture: search -> licence filter -> download -> write."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.fix = root / "fixture"
        self.assets = root / "assets"
        self.review = root / "review"
        (self.fix / "commons" / "search").mkdir(parents=True)
        (self.fix / "files").mkdir()
        self.assets.mkdir()
        (self.assets / "manifest.json").write_text(json.dumps({"characters": CHARACTERS}))
        pages = [
            commons_page("File:Jungle nc.jpg", "https://upload.wikimedia.org/t/nc.jpg",
                         licence="CC BY-NC 2.0", licence_url="", index=1),
            commons_page("File:Rainforest trail.jpg", "https://upload.wikimedia.org/t/good.jpg",
                         index=2),
            commons_page("File:Rainforest gfdl.jpg", "https://upload.wikimedia.org/t/gfdl.jpg",
                         licence="GFDL", licence_url="", index=3),
        ]
        (self.fix / "commons" / "search" / f"{fa.slug('rainforest trail')}.json").write_text(
            json.dumps({"query": {"pages": pages}}))
        for name in ("nc.jpg", "good.jpg", "gfdl.jpg"):
            (self.fix / "files" / name).write_bytes(jpeg_with_exif())
        self.wanted = root / "wanted.json"
        self.wanted.write_text(json.dumps({"backgrounds": {"jungle": {
            "queries": ["rainforest trail"], "default_ground": 0.83,
            "ground": {"File:Rainforest trail.jpg": 0.81}}}}))

    def tearDown(self):
        self.tmp.cleanup()

    def run_tool(self, *extra):
        logs = []
        rc = fa.main(["--offline-fixture", str(self.fix), "--wanted", str(self.wanted),
                      "--assets-dir", str(self.assets), "--review-dir", str(self.review),
                      "--delay", "0", *extra], log=logs.append)
        return rc, "\n".join(logs)

    def test_end_to_end(self):
        rc, log = self.run_tool()
        self.assertEqual(rc, 0, log)
        m = json.loads((self.assets / "manifest.json").read_text())
        self.assertEqual(m["characters"], CHARACTERS)
        e = m["backgrounds"]["jungle"]
        self.assertEqual(e["file"], "bg/jungle.jpg")
        self.assertEqual((e["w"], e["h"]), (1920, 1080))
        self.assertEqual(e["ground"], 0.81)
        self.assertIsInstance(e["ground"], float)
        self.assertEqual(set(e["credit"]), {"title", "author", "license", "licenseUrl", "source"})
        self.assertEqual(e["credit"]["license"], "CC BY-SA 4.0")
        self.assertEqual(e["credit"]["author"], "Jane Doe & co")
        self.assertTrue(e["credit"]["source"].startswith("https://commons.wikimedia.org/wiki/"))
        with Image.open(self.assets / "bg" / "jungle.jpg") as im:
            self.assertEqual(im.format, "JPEG")
            self.assertLessEqual(max(im.size), 1920)
            self.assertEqual(len(im.getexif()), 0)
            self.assertNotIn("exif", im.info)
        self.assertNotIn(b"SecretCameraMaker", (self.assets / "bg" / "jungle.jpg").read_bytes())
        self.assertTrue((self.assets / "CREDITS.md").exists())

    def test_ground_only_update(self):
        self.run_tool()
        rc, log = self.run_tool("--ground", "jungle=0.9")
        self.assertEqual(rc, 0, log)
        m = json.loads((self.assets / "manifest.json").read_text())
        self.assertEqual(m["backgrounds"]["jungle"]["ground"], 0.9)
        self.assertEqual(m["characters"], CHARACTERS)

    def test_dry_run_writes_nothing(self):
        before = (self.assets / "manifest.json").read_text()
        rc, log = self.run_tool("--dry-run", "--candidates", "3")
        self.assertEqual(rc, 0, log)
        self.assertEqual((self.assets / "manifest.json").read_text(), before)
        self.assertFalse((self.assets / "bg").exists())
        self.assertTrue((self.review / "jungle.png").exists())

    def test_only_nonfree_results_fails(self):
        (self.fix / "commons" / "search" / f"{fa.slug('rainforest trail')}.json").write_text(
            json.dumps({"query": {"pages": [commons_page(
                "File:Jungle nc.jpg", "https://upload.wikimedia.org/t/nc.jpg",
                licence="CC BY-NC-ND 2.0", licence_url="")]}}))
        rc, log = self.run_tool()
        self.assertEqual(rc, 1)
        m = json.loads((self.assets / "manifest.json").read_text())
        self.assertNotIn("jungle", m.get("backgrounds", {}))
        self.assertEqual(m["characters"], CHARACTERS)

    def test_backoff_on_429(self):
        import urllib.error
        f = fa.Fetcher(delay=0, retries=2, log=lambda *a: None)
        err = urllib.error.HTTPError("u", 429, "slow down", {"Retry-After": "0"}, None)
        ok = mock.MagicMock()
        ok.__enter__.return_value.read.return_value = b"{}"
        with mock.patch.object(f.opener, "open", side_effect=[err, ok]) as op, \
                mock.patch.object(fa.time, "sleep"):
            self.assertEqual(f.get_json("https://commons.wikimedia.org/w/api.php"), {})
            self.assertEqual(op.call_count, 2)


if __name__ == "__main__":
    unittest.main()
