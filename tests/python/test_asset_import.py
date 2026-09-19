import unittest, tempfile, sqlite3, importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('asset',Path(__file__).parents[2]/'scripts/beer-data-assets.py')
mod=importlib.util.module_from_spec(spec)
if spec.loader: spec.loader.exec_module(mod)

class ImportTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  self.source=self.root/'source.db';self.target=self.root/'target.db'
  for p in [self.source,self.target]:
   with sqlite3.connect(p) as c:c.execute('CREATE TABLE untappd_cache(id TEXT PRIMARY KEY,name TEXT NOT NULL,brewery TEXT,style TEXT,abv REAL,rating REAL,ratings_count INTEGER,untappd_url TEXT,updated_at INTEGER)')
  with sqlite3.connect(self.source) as c:
   c.execute("INSERT INTO untappd_cache VALUES ('1','One','B','Lager',5,4,10,'https://untappd.com/b/b-one/1',1700000000)")
   c.execute("INSERT INTO untappd_cache VALUES ('2','Two','B','This beer is no longer being produced',6,4,20,'https://untappd.com/b/b-two/2',1700000000)")
   c.execute('CREATE TABLE venue_prices(beer_id TEXT,venue_id TEXT,price_type TEXT,container TEXT,volume_ml REAL,price REAL,currency TEXT,source_url TEXT,scraped_at INTEGER)')
   c.execute("INSERT INTO venue_prices VALUES ('99','v','draft','Glass',300,0,'USD','https://untappd.com/v/test/1',1700000000)")
  with sqlite3.connect(self.target) as c:
   c.execute("INSERT INTO untappd_cache VALUES ('1','Original','B',NULL,5,4,10,'https://untappd.com/b/b-one/1',1690000000)")
   c.execute("INSERT INTO untappd_cache VALUES ('old','Keep','B','Stout',7,4,1,NULL,1)")
   c.execute('CREATE INDEX keep_index ON untappd_cache(name)')
 def test_dry_run_source_and_target_unchanged(self):
  before=[p.read_bytes() for p in [self.source,self.target]]
  r=mod.process(self.source,self.target,apply=False)
  self.assertEqual(r['cache_inserted'],1);self.assertEqual(before,[p.read_bytes() for p in [self.source,self.target]])
 def test_idempotence_conflicts_and_source_immutable(self):
  source=self.source.read_bytes();a=mod.process(self.source,self.target,apply=True);b=mod.process(self.source,self.target,apply=True)
  self.assertEqual(a['cache_inserted'],1);self.assertEqual(b['cache_inserted'],0);self.assertEqual(b['observations_inserted'],0)
  self.assertEqual(source,self.source.read_bytes());self.assertTrue(Path(a['backup']).exists())
  with sqlite3.connect(self.target) as c:
   self.assertEqual(c.execute("select name,style from untappd_cache where id='1'").fetchone(),('Original','Lager'))
   self.assertIsNone(c.execute("select style from untappd_cache where id='2'").fetchone()[0])
   self.assertEqual(c.execute("select count(*) from untappd_cache where id='old'").fetchone()[0],1)
   self.assertEqual(c.execute("select count(*) from sqlite_master where name='keep_index'").fetchone()[0],1)
   self.assertEqual(c.execute('select comparable from venue_observations').fetchone()[0],0)
   self.assertGreater(c.execute('select count(*) from data_conflicts').fetchone()[0],0)
   self.assertEqual(c.execute("select count(*) from crawl_jobs where target='99'").fetchone()[0],1)
 def test_reject_same_file(self):
  with self.assertRaises(ValueError):mod.process(self.source,self.source,apply=True)
 def test_transaction_rolls_back(self):
  with sqlite3.connect(self.target) as c:c.execute("CREATE TRIGGER stop BEFORE INSERT ON untappd_cache BEGIN SELECT RAISE(ABORT,'stop'); END")
  before=self.target.read_bytes()
  with self.assertRaises(sqlite3.IntegrityError):mod.process(self.source,self.target,apply=True)
  self.assertEqual(before,self.target.read_bytes())
 def test_invalid_values_never_enter_cache(self):
  with sqlite3.connect(self.source) as c:c.execute("UPDATE untappd_cache SET rating=9,abv=-1,ratings_count=-5 WHERE id='2'")
  mod.process(self.source,self.target,apply=True)
  with sqlite3.connect(self.target) as c:self.assertEqual(c.execute("select rating,abv,ratings_count from untappd_cache where id='2'").fetchone(),(None,None,None))
 def test_valid_offer_and_changed_price_keep_history(self):
  with sqlite3.connect(self.source) as c:c.execute("UPDATE venue_prices SET beer_id='1',price=8")
  mod.process(self.source,self.target,apply=True)
  with sqlite3.connect(self.source) as c:c.execute('UPDATE venue_prices SET price=9')
  mod.process(self.source,self.target,apply=True)
  with sqlite3.connect(self.target) as c:self.assertEqual(c.execute('select count(*) from venue_observations where comparable=1').fetchone()[0],2)
if __name__=='__main__':unittest.main()
