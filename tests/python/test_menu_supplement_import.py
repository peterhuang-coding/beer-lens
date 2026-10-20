"""
Tests for scripts/import-menu-supplement.py — stdlib unittest, synthetic DBs.

Never touches the real database or the network. The real 17-entry catalog is
read from data/menus/elnido-2026-10.json; every SQLite database is a temp file.

Run:
    python3 -m unittest discover -s tests/python -p test_menu_supplement_import.py
"""

import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "import-menu-supplement.py"
CATALOG_PATH = ROOT / "data" / "menus" / "elnido-2026-10.json"

spec = importlib.util.spec_from_file_location("import_menu_supplement", SCRIPT_PATH)
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


def make_db(path: str) -> None:
    """Create the minimum real-world schema, including an extra column to prove
    importers never assume an exact column set."""
    conn = sqlite3.connect(path)
    try:
        conn.execute(
            "CREATE TABLE beer_cache ("
            "id INTEGER PRIMARY KEY, name TEXT, brewery TEXT, style TEXT, abv REAL, "
            "rating REAL, ratings_count INTEGER, ibu REAL, source_url TEXT, "
            "source_platform TEXT, verified INTEGER, verified_at TEXT, created_at TEXT, "
            "country TEXT, UNIQUE(name, brewery))"
        )
        conn.execute("CREATE TABLE beers (id INTEGER PRIMARY KEY, name TEXT, brewery TEXT)")
        conn.execute(
            "CREATE TABLE untappd_cache (id INTEGER PRIMARY KEY, name TEXT, brewery TEXT)"
        )
        conn.commit()
    finally:
        conn.close()


class ImportMenuSupplementTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = pathlib.Path(self._tmp.name)
        self.db_path = self.tmp / "beer.db"
        make_db(str(self.db_path))
        with open(CATALOG_PATH, "r", encoding="utf-8") as fh:
            self.catalog = json.load(fh)

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, catalog_path=None, db_path=None):
        catalog_path = str(catalog_path or CATALOG_PATH)
        db_path = str(db_path or self.db_path)
        return importer.main(["--db", db_path, "--catalog", catalog_path])

    def _write_catalog(self, payload):
        path = self.tmp / "catalog.json"
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
        return path

    def _tables(self, conn):
        return {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}

    # ── happy path: 17 menu rows, 14 new cache rows (#13 pre-exists) ──

    def test_imports_all_17_menu_payloads_and_14_new_confirmed_rows(self):
        # #13 Белоглазка/Sergacore Brewery already exists in `beers` — must be preserved.
        conn = sqlite3.connect(str(self.db_path))
        conn.execute("INSERT INTO beers(name, brewery) VALUES (?, ?)",
                     ("Белоглазка", "Sergacore Brewery"))
        # An unrelated pre-existing cache row with its own score must survive.
        conn.execute(
            "INSERT INTO beer_cache(name, brewery, style, abv, rating, ratings_count, "
            "source_url, verified, country) VALUES (?,?,?,?,?,?,?,?,?)",
            ("Heritage Beer", "Old Brew", "Stout", 8.0, 4.2, 99,
             "https://example.com/old", 0, "US"),
        )
        conn.commit()
        conn.close()

        report = self._run()

        self.assertEqual(report["menu_entries"], 17)
        self.assertEqual(report["menu_rows_written"], 17)
        self.assertEqual(report["confirmed_identities"], 15)
        self.assertEqual(len(report["unresolved_menu_only"]), 2)
        self.assertEqual(report["beer_cache_inserted"], 14)
        self.assertEqual(report["beer_cache_preserved"], 1)
        self.assertIn("elnido-2026-10-13", report["beer_cache_preserved_ids"])

        conn = sqlite3.connect(str(self.db_path))
        # menu_supplements holds all 17 full JSON records.
        rows = conn.execute(
            "SELECT entry_id, payload FROM menu_supplements WHERE menu_id=?",
            (importer.MENU_ID,),
        ).fetchall()
        self.assertEqual(len(rows), 17)
        payloads = {eid: json.loads(payload) for eid, payload in rows}
        self.assertEqual({p["menu_index"] for p in payloads.values()}, set(range(2, 19)))
        kphilia = next(p for p in payloads.values() if p["menu_index"] == 11)
        self.assertEqual(kphilia["identity_status"], "version_unresolved")
        self.assertIsNone(kphilia["canonical_name"])
        self.assertEqual(kphilia["observation"]["abv"], 9.5)
        the_cut = next(p for p in payloads.values() if p["menu_index"] == 17)
        self.assertEqual(the_cut["identity_status"], "batch_unresolved")

        # Every new beer_cache row is an identity record, never a score.
        new_rows = conn.execute(
            "SELECT name, brewery, style, abv, rating, ratings_count, source_url, "
            "source_platform, verified, verified_at FROM beer_cache "
            "WHERE source_platform=?", (importer.SOURCE_PLATFORM,),
        ).fetchall()
        self.assertEqual(len(new_rows), 14)
        for name, brewery, style, abv, rating, count, url, platform, verified, vat in new_rows:
            self.assertTrue(name and brewery and style)
            self.assertIsInstance(abv, float)
            self.assertIsNone(rating, "verified identity must not carry a score")
            self.assertIsNone(count)
            self.assertEqual(platform, "curated_public_menu")
            self.assertEqual(verified, 1)
            self.assertEqual(vat, "2026-10-21")
            self.assertTrue(url.startswith("https://"))
        names = {r[0] for r in new_rows}
        self.assertIn("Windy Hill", names)
        self.assertIn("Girls Gone Hazy", names, "canonical name, not short title")

        # Unresolved entries never become canonical cache rows.
        unresolved_rows = conn.execute(
            "SELECT COUNT(*) FROM beer_cache WHERE name IN (?, ?)",
            ("K-philia", "The Cut: Laroda Plum"),
        ).fetchone()[0]
        self.assertEqual(unresolved_rows, 0)

        # The existing unrelated row is byte-for-byte intact.
        old = conn.execute(
            "SELECT rating, ratings_count, country, source_url FROM beer_cache "
            "WHERE name='Heritage Beer'"
        ).fetchone()
        self.assertEqual(old, (4.2, 99, "US", "https://example.com/old"))
        conn.close()

    def test_primary_source_prefers_brewery_page(self):
        self._run()
        conn = sqlite3.connect(str(self.db_path))
        url = conn.execute(
            "SELECT source_url FROM beer_cache WHERE name='Victory Lap'"
        ).fetchone()[0]
        self.assertEqual(url, "https://ologybrewing.com/ology-tampa/")
        # #10 has no brewery-kind URL: first source is used, never invented.
        url_shred = conn.execute(
            "SELECT source_url FROM beer_cache WHERE name='Green Reaper'"
        ).fetchone()[0]
        self.assertEqual(
            url_shred, "https://untappd.com/v/shred-beer-co/12007977/photos")
        conn.close()

    # ── idempotency ──

    def test_repeated_import_is_idempotent(self):
        first = self._run()
        self.assertEqual(first["beer_cache_inserted"], 15)
        second = self._run()
        self.assertEqual(second["beer_cache_inserted"], 0)
        self.assertEqual(second["beer_cache_preserved"], 15)
        self.assertEqual(second["menu_rows_written"], 17)

        conn = sqlite3.connect(str(self.db_path))
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM beer_cache WHERE source_platform=?",
            (importer.SOURCE_PLATFORM,)).fetchone()[0], 15)
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM menu_supplements").fetchone()[0], 17)
        conn.close()

    def test_existing_confirmed_cache_row_is_never_overwritten(self):
        conn = sqlite3.connect(str(self.db_path))
        conn.execute(
            "INSERT INTO beer_cache(name, brewery, style, abv, rating, ratings_count, "
            "source_url, verified) VALUES (?,?,?,?,?,?,?,?)",
            ("Windy Hill", "Mikkeller", "OLD STYLE", 1.2, 3.93, 68496,
             "https://example.com/windy", 0),
        )
        conn.commit()
        conn.close()

        report = self._run()
        self.assertEqual(report["beer_cache_inserted"], 14)
        self.assertIn("elnido-2026-10-02", report["beer_cache_preserved_ids"])

        conn = sqlite3.connect(str(self.db_path))
        rows = conn.execute(
            "SELECT style, abv, rating, ratings_count, source_url, verified "
            "FROM beer_cache WHERE name='Windy Hill'"
        ).fetchall()
        self.assertEqual(len(rows), 1, "no duplicate row inserted")
        self.assertEqual(rows[0], ("OLD STYLE", 1.2, 3.93, 68496,
                                   "https://example.com/windy", 0))
        conn.close()

    def test_casefold_identity_match_blocks_insert_across_tables(self):
        # Different case/table still counts as the exact same identity.
        conn = sqlite3.connect(str(self.db_path))
        conn.execute("INSERT INTO untappd_cache(name, brewery) VALUES (?, ?)",
                     ("FREE LUNCH", "blackstack"))
        conn.commit()
        conn.close()

        report = self._run()
        self.assertEqual(report["beer_cache_inserted"], 14)
        self.assertIn("elnido-2026-10-12", report["beer_cache_preserved_ids"])

    # ── atomicity / failure modes ──

    def test_malformed_catalog_changes_nothing(self):
        conn = sqlite3.connect(str(self.db_path))
        tables_before = self._tables(conn)
        conn.close()

        bad_path = self.tmp / "bad.json"
        with open(bad_path, "w", encoding="utf-8") as fh:
            fh.write("{ not json")

        with self.assertRaises(SystemExit) as cm:
            self._run(catalog_path=bad_path)
        self.assertEqual(cm.exception.code, 2)

        conn = sqlite3.connect(str(self.db_path))
        self.assertEqual(self._tables(conn), tables_before,
                         "no menu_supplements table may be created on failure")
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM beer_cache").fetchone()[0], 0)
        conn.close()

    def test_invalid_catalog_content_changes_nothing(self):
        payload = json.loads(json.dumps(self.catalog))
        payload["entries"][0]["abv"] = None  # confirmed row must keep public abv
        bad_path = self._write_catalog(payload)
        with self.assertRaises(SystemExit):
            self._run(catalog_path=bad_path)
        conn = sqlite3.connect(str(self.db_path))
        self.assertNotIn("menu_supplements", self._tables(conn))
        conn.close()

    def test_missing_required_schema_fails_before_writes(self):
        plain = self.tmp / "plain.db"
        conn = sqlite3.connect(str(plain))
        conn.execute("CREATE TABLE beer_cache (id INTEGER PRIMARY KEY)")
        conn.execute("CREATE TABLE beers (id INTEGER PRIMARY KEY)")
        # untappd_cache missing entirely
        conn.commit()
        conn.close()

        with self.assertRaises(SystemExit):
            self._run(db_path=plain)
        conn = sqlite3.connect(str(plain))
        self.assertNotIn("menu_supplements", self._tables(conn))
        conn.close()

    # ── validation rules ──

    def test_validator_accepts_real_catalog(self):
        entries = importer.validate_catalog(self.catalog)
        self.assertEqual(len(entries), 17)

    def test_validator_rejects_wrong_counts_and_statuses(self):
        payload = json.loads(json.dumps(self.catalog))
        payload["version"] = 2
        with self.assertRaises(importer.CatalogError):
            importer.validate_catalog(payload)

        payload = json.loads(json.dumps(self.catalog))
        payload["entries"].pop()
        with self.assertRaises(importer.CatalogError):
            importer.validate_catalog(payload)

        payload = json.loads(json.dumps(self.catalog))
        k = payload["entries"][9]  # tap 11, K-philia (version_unresolved)
        self.assertEqual(k["menu_index"], 11)
        k["identity_status"] = "confirmed"
        k["canonical_name"] = "K-philia #2"
        with self.assertRaises(importer.CatalogError):
            importer.validate_catalog(payload)

        payload = json.loads(json.dumps(self.catalog))
        payload["entries"][0]["sources"][0]["access"] = "live"
        with self.assertRaises(importer.CatalogError):
            importer.validate_catalog(payload)


if __name__ == "__main__":
    unittest.main()
