"""Focused tests for scripts/mbcb-catalog.py.

Tests drive the real CLI against temporary SQLite databases, using four
public menu examples plus synthetic records. No network or shared database.
"""

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "mbcb-catalog.py"
SAMPLE = ROOT / "tests" / "fixtures" / "mbcb-red-sample.json"
EVENT_ID = "mbcb-2026-beijing"


def record(eid, name=None, brewery="Some Brewery", **over):
    """A minimal valid record; per-call overrides mutate only this record."""
    base = {
        "event_id": EVENT_ID,
        "event_beer_id": eid,
        "name": name if name is not None else f"Beer {eid}",
        "name_zh": None,
        "brewery": brewery,
        "brewery_zh": None,
        "sessions": ["red"],
        "style": "Ale",
        "abv": 5.0,
        "description": f"description of beer {eid}",
        "metastyles": [],
        "untappd_id": 1000 + eid,
        "rating_raw": 4.0,
        "rating_count": 10,
        "rating_usable": True,
        "booth": None,
        "price": None,
        "serving_ml": None,
        "live_stock": "unknown",
        "source_url": "https://example.com/latest.json",
        "retrieved_at": "2026-10-12T00:00:00+00:00",
        "issues": [],
        "field_disagreements": {},
        "style_zh_source_raw": None,
        "source_translation_verified": False,
        "description_zh": None,
        "verification_notes": [],
        "verification_sources": [],
        "missing_fields": [],
        "aliases": [],
        "description_zh_review_status": "no_source",
        "extra_field_kept": {"nested": [1, 2, 3]},
    }
    base.update(over)
    return base


class CatalogCliTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.db = self.tmp / "beer.db"
        with open(SAMPLE, encoding="utf-8") as f:
            self.sample = json.load(f)

    def tearDown(self):
        self._tmp.cleanup()

    # -- helpers --

    def write_json(self, data, name="batch.json"):
        p = self.tmp / name
        p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return p

    def cli(self, *args, db=None):
        cmd = [sys.executable, str(SCRIPT), "--db", str(db or self.db), *args]
        return subprocess.run(cmd, capture_output=True, text=True)

    def import_json(self, data, name="batch.json", db=None):
        path = self.write_json(data, name)
        return self.cli("--import", str(path), db=db)

    def import_sample(self):
        return self.cli("--import", str(SAMPLE))

    def query(self, q, page=None, db=None):
        args = ["--query", q]
        if page is not None:
            args += ["--page", str(page)]
        proc = self.cli(*args, db=db)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def import_ok(self, data, **kw):
        proc = self.import_json(data, **kw)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertTrue(out["ok"])
        return out

    def table_names(self, db=None):
        conn = sqlite3.connect(db or self.db)
        try:
            rows = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            ).fetchall()
        finally:
            conn.close()
        return {r[0] for r in rows}

    # -- import / query basics --

    def test_import_sample_and_exact_id_query_preserves_payload(self):
        proc = self.import_sample()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out, {"ok": True, "event_id": EVENT_ID, "imported": 4})

        env = self.query("#424")
        self.assertEqual(env["event_id"], EVENT_ID)
        self.assertEqual(env["session"], "red")
        self.assertEqual(env["page"], 1)
        self.assertEqual(env["page_size"], 20)
        self.assertEqual(env["total"], 1)
        self.assertTrue(env["available"])
        self.assertEqual(env["results"], [self.sample[1]])

        # unknown extra fields on synthetic records survive the round trip
        self.import_ok([record(77, extra_field_kept={"z": [True, None]})])
        got = self.query("#77")["results"][0]
        self.assertEqual(got["extra_field_kept"], {"z": [True, None]})

    def test_import_is_idempotent_snapshot_replace(self):
        self.import_sample()
        self.import_sample()
        env = self.query("")
        self.assertEqual(env["total"], 4)
        ids = sorted(r["event_beer_id"] for r in env["results"])
        self.assertEqual(ids, [96, 424, 498, 599])

        conn = sqlite3.connect(self.db)
        try:
            n = conn.execute(
                "SELECT COUNT(*) FROM event_menu_beers WHERE event_id=?", (EVENT_ID,)
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(n, 4)

        # replacing with a smaller snapshot shrinks the table
        self.import_ok([record(96)])
        self.assertEqual(self.query("")["total"], 1)

    def test_empty_import_does_not_delete_catalog(self):
        self.import_sample()
        proc = self.import_json([])
        self.assertNotEqual(proc.returncode, 0)
        self.assertFalse(json.loads(proc.stdout)["ok"])
        self.assertEqual(self.query("")["total"], 4)

    def test_non_list_import_rejected(self):
        proc = self.import_json({"event_beer_id": 1})
        self.assertNotEqual(proc.returncode, 0)
        self.assertFalse(json.loads(proc.stdout)["ok"])

    # -- atomic rollback / duplicate identity --

    def test_duplicate_identity_batch_fully_rolls_back_including_ddl(self):
        # pre-existing db with only legacy data: rejected import must neither
        # create the event table nor leave a partial snapshot behind
        conn = sqlite3.connect(self.db)
        conn.execute("CREATE TABLE beers (id INTEGER PRIMARY KEY)")
        conn.execute("INSERT INTO beers(id) VALUES (1)")
        conn.commit()
        conn.close()

        bad = [record(1), record(2, event_beer_id=1, untappd_id=9999)]
        proc = self.import_json(bad)
        self.assertNotEqual(proc.returncode, 0)
        err = json.loads(proc.stdout)
        self.assertFalse(err["ok"])
        self.assertIn("duplicate", err["error"].lower())

        env = self.query("")
        self.assertFalse(env["available"])
        self.assertEqual(env["reason"], "catalog_missing")
        self.assertEqual(env["results"], [])
        self.assertEqual(self.table_names(), {"beers"})

    def test_duplicate_untappd_id_rejected(self):
        bad = [record(1), record(2, untappd_id=1001)]
        proc = self.import_json(bad)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("untappd", json.loads(proc.stdout)["error"].lower())

    def test_malformed_batch_is_all_or_nothing(self):
        self.import_sample()
        good = record(77)
        cases = {
            "bool_abv": {**good, "abv": True},
            "nan_abv": {**good, "abv": float("nan")},
            "infinity_rating": {**good, "rating_raw": float("inf")},
            "string_id": {**good, "event_beer_id": "77"},
            "bool_id": {**good, "event_beer_id": True},
            "zero_id": {**good, "event_beer_id": 0},
            "negative_id": {**good, "event_beer_id": -3},
            "string_ut": {**good, "untappd_id": "5504969"},
            "bool_count": {**good, "rating_count": False},
            "mixed_event": {**good, "event_id": "mbcb-2025-beijing"},
            "non_red": {**good, "sessions": ["yellow"]},
            "sessions_not_list": {**good, "sessions": "red"},
            "empty_name": {**good, "name": "   "},
            "missing_brewery": {**good, "brewery": None},
        }
        for label, bad_rec in cases.items():
            with self.subTest(label):
                proc = self.import_json([good, bad_rec], name=f"{label}.json")
                self.assertNotEqual(proc.returncode, 0, label)
                self.assertFalse(json.loads(proc.stdout)["ok"], label)
                # catalog untouched after every rejected batch
                self.assertEqual(self.query("")["total"], 4, label)

    # -- legacy tables --

    def test_legacy_tables_never_modified(self):
        conn = sqlite3.connect(self.db)
        conn.execute("CREATE TABLE beers (id INTEGER PRIMARY KEY, name TEXT)")
        conn.execute("CREATE TABLE untappd_cache (bid INTEGER PRIMARY KEY, data TEXT)")
        conn.execute("CREATE TABLE beer_cache (k TEXT PRIMARY KEY, v TEXT)")
        conn.execute("INSERT INTO beers(id, name) VALUES(1, 'legacy beer')")
        conn.execute("INSERT INTO untappd_cache(bid, data) VALUES(42, '{}')")
        conn.execute("INSERT INTO beer_cache(k, v) VALUES('k', 'v')")
        conn.commit()
        conn.close()

        self.import_sample()
        # failing import must also leave legacy data intact
        self.import_json([record(1), record(1, untappd_id=9999)])

        conn = sqlite3.connect(self.db)
        try:
            self.assertEqual(
                conn.execute("SELECT id, name FROM beers ORDER BY id").fetchall(),
                [(1, "legacy beer")],
            )
            self.assertEqual(
                conn.execute("SELECT bid, data FROM untappd_cache").fetchall(),
                [(42, "{}")],
            )
            self.assertEqual(
                conn.execute("SELECT k, v FROM beer_cache").fetchall(), [("k", "v")]
            )
            tables = {
                r[0]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
        finally:
            conn.close()
        self.assertEqual(
            tables, {"beers", "untappd_cache", "beer_cache", "event_menu_beers"}
        )

    # -- null vs zero --

    def test_null_and_zero_abv_both_preserved(self):
        self.import_ok([
            record(1, name="Null Abv", abv=None),
            record(2, name="Zero Abv", abv=0),
        ])
        rows = {r["event_beer_id"]: r for r in self.query("abv")["results"]}
        self.assertIsNone(rows[1]["abv"])
        self.assertEqual(rows[2]["abv"], 0)
        # null serialises back to JSON null, never to 0
        payload = json.loads(json.dumps(rows[1]))
        self.assertIsNone(payload["abv"])

    # -- missing db / catalog / zero results are distinct --

    def test_missing_db_is_explicit_unavailable(self):
        missing = self.tmp / "nope" / "beer.db"
        proc = self.cli("--query", "Helles", db=missing)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        env = json.loads(proc.stdout)
        self.assertFalse(env["available"])
        self.assertEqual(env["reason"], "db_missing")
        self.assertEqual(env["total"], 0)
        self.assertEqual(env["results"], [])
        self.assertFalse(os.path.exists(missing))  # never created by query

    def test_missing_catalog_is_explicit_unavailable(self):
        empty_db = self.tmp / "empty.db"
        sqlite3.connect(empty_db).close()
        proc = self.cli("--query", "Helles", db=empty_db)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        env = json.loads(proc.stdout)
        self.assertFalse(env["available"])
        self.assertEqual(env["reason"], "catalog_missing")
        # still no tables after a read-only query
        conn = sqlite3.connect(empty_db)
        try:
            n = conn.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'"
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(n, 0)

    def test_zero_hits_is_available_with_empty_results(self):
        self.import_sample()
        env = self.query("definitely-no-such-beer-zzzz")
        self.assertTrue(env["available"])
        self.assertEqual(env["total"], 0)
        self.assertEqual(env["results"], [])

    # -- pagination --

    def test_paging(self):
        self.import_ok([record(i, name=f"Pager {i:02d}") for i in range(1, 26)])
        p1 = self.query("", page=1)
        p2 = self.query("", page=2)
        self.assertEqual(p1["total"], 25)
        self.assertEqual(len(p1["results"]), 20)
        self.assertEqual(len(p2["results"]), 5)
        self.assertEqual(p2["page"], 2)
        p1_ids = [r["event_beer_id"] for r in p1["results"]]
        p2_ids = [r["event_beer_id"] for r in p2["results"]]
        self.assertEqual(len(set(p1_ids + p2_ids)), 25)
        self.assertEqual(p1_ids, sorted(p1_ids))
        beyond = self.query("", page=99)
        self.assertEqual(beyond["results"], [])
        self.assertEqual(beyond["total"], 25)

    def test_bad_page_is_json_error(self):
        self.import_sample()
        for bad in ("0", "-3"):
            proc = self.cli("--query", "Helles", "--page", bad)
            self.assertNotEqual(proc.returncode, 0)
            self.assertFalse(json.loads(proc.stdout)["ok"])

    # -- read-only query --

    def test_query_creates_no_tables_or_rows(self):
        self.import_sample()
        before = self.table_names()
        for q in ["Helles", "#424", "5504969", "", "美奇乐"]:
            self.query(q)
        conn = sqlite3.connect(self.db)
        try:
            n = conn.execute(
                "SELECT COUNT(*) FROM event_menu_beers WHERE event_id=?", (EVENT_ID,)
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(self.table_names(), before)
        self.assertEqual(n, 4)

    # -- search semantics --

    def test_ambiguous_name_returns_both_candidates(self):
        self.import_sample()
        ids = sorted(r["event_beer_id"] for r in self.query("Helles")["results"])
        self.assertEqual(ids, [96, 599])

    def test_combined_brewery_and_name_disambiguates(self):
        self.import_sample()
        self.assertEqual(
            [r["event_beer_id"] for r in self.query("3 Sons Helles")["results"]], [96]
        )
        self.assertEqual(
            [r["event_beer_id"]
             for r in self.query("Wagner Merkendorf Helles")["results"]],
            [599],
        )
        # tokens must never combine across unrelated brewery words
        self.assertEqual(self.query("Wagner Sons Helles")["results"], [])

    def test_numeric_untappd_and_hash_event_lookups(self):
        self.import_sample()
        self.assertEqual(
            [r["event_beer_id"] for r in self.query("5504969")["results"]], [424]
        )
        self.assertEqual(
            [r["event_beer_id"] for r in self.query("5847116")["results"]], [96]
        )
        self.assertEqual(
            [r["event_beer_id"] for r in self.query("#498")["results"]], [498]
        )

    def test_chinese_name_and_brewery_searchable(self):
        self.import_sample()
        self.assertEqual(
            [r["event_beer_id"] for r in self.query("美奇乐")["results"]], [498]
        )
        self.assertEqual(
            [r["event_beer_id"] for r in self.query("智理宝贝")["results"]], [424]
        )

    def test_normalization_case_diacritics_punctuation_space_version(self):
        self.import_ok([
            record(1, name="Café V10", brewery="Brasserie Göß"),
            record(2, name="  Space   Beer  ", brewery="Two-Words"),
            record(3, name="Helles", brewery="Wagner Merkendorf"),
            record(4, name="Helles", brewery="3 Sons", untappd_id=2004),
        ])
        self.assertEqual([r["event_beer_id"] for r in self.query("cafe v10")["results"]], [1])
        self.assertEqual([r["event_beer_id"] for r in self.query("  CAFÉ   V10 ")["results"]], [1])
        self.assertEqual(
            [r["event_beer_id"]
             for r in self.query("brasserie goss cafe v10")["results"]],
            [1],
        )
        self.assertEqual([r["event_beer_id"] for r in self.query("space beer")["results"]], [2])
        self.assertEqual(
            [r["event_beer_id"]
             for r in self.query("two words space beer")["results"]],
            [2],
        )
        # version digits are a real token: v1 must not match V10
        self.assertEqual(self.query("v1")["results"], [])
        # punctuation splitting still keeps numbers
        self.assertEqual(
            [r["event_beer_id"] for r in self.query("3 sons helles")["results"]], [4]
        )

    def test_alias_search(self):
        self.import_sample()
        ids = [r["event_beer_id"] for r in self.query("Rosemary's Baby")["results"]]
        self.assertEqual(ids, [424])

    # -- red-only contract / payload fidelity --

    def test_conflict_and_unknown_fields_surfaced_in_payload(self):
        self.import_sample()
        r = self.query("#424")["results"][0]
        self.assertEqual(r["abv"], 4.5)
        self.assertIn("abv_database_disagreement", r["issues"])
        self.assertEqual(len(r["verification_sources"]), 1)
        ice = self.query("#498")["results"][0]
        self.assertIsNone(ice["abv"])
        self.assertIsNone(ice["style"])
        self.assertIsNone(ice["untappd_id"])
        self.assertIn("red", ice["sessions"])
        self.assertEqual(ice["description_zh_review_status"], "no_source")


if __name__ == "__main__":
    unittest.main()
