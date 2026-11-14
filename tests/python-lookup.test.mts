import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
test('Python lookup loads and returns JSON without a preinstalled database',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'beer-python-'));
 try{
 copyFileSync('.beer-data/lookup.py',path.join(dir,'lookup.py'));
 const result=spawnSync('python3',[path.join(dir,'lookup.py'),'--stats'],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.equal(typeof JSON.parse(result.stdout),'object');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Python brewery batch uses one connection, preserves order and matches the CLI',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'beer-python-brewery-'));
 try{
 const script=path.join(dir,'lookup.py');
 copyFileSync('.beer-data/lookup.py',script);
 const program=[
  'import sqlite3, importlib.util, json, sys',
  'con=sqlite3.connect(sys.argv[2])',
  'con.execute("CREATE TABLE untappd_cache (id TEXT, name TEXT, brewery TEXT, style TEXT, abv REAL, rating REAL, ratings_count INTEGER, untappd_url TEXT, country TEXT, label_image TEXT)")',
  'con.executemany("INSERT INTO untappd_cache VALUES (?,?,?,?,?,?,?,?,?,?)", [',
  ' ("a1", "One", "Alpha Works", "IPA", 6, 4.1, 10, "", "US", None),',
  ' ("a2", "Two", "Alpha Works", "Stout", 8, 4.3, 20, "", "US", None),',
  ' ("b1", "Three", "Beta Works", "Lager", 5, 3.8, 5, "", "GB", None)])',
  'con.commit(); con.close()',
  'spec=importlib.util.spec_from_file_location("lookup", sys.argv[1])',
  'mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
  'connections=[0]; original=mod._connect',
  'def counted():',
  ' connections[0]+=1',
  ' return original()',
  'mod._connect=counted',
  'rows=mod.search_brewery_batch(["Alpha Works", "Beta Works", "Missing"])',
  'print(json.dumps({"connections": connections[0], "results": rows}))',
 ].join('\n');
 const probe=spawnSync('python3',['-c',program,script,path.join(dir,'beer.db')],{encoding:'utf8',timeout:10000});
 assert.equal(probe.status,0,probe.stderr);
 const payload=JSON.parse(probe.stdout);
 assert.equal(payload.connections,1);
 assert.deepEqual(payload.results.map((row:any)=>row.query),['Alpha Works','Beta Works','Missing']);
 assert.equal(payload.results[0].brewery_stats.count,2);
 assert.equal(payload.results[0].brewery_stats.avg_rating,4.2);
 assert.equal(payload.results[1].brewery_stats.count,1);
 assert.equal(payload.results[2].found,false);
 const cli=spawnSync('python3',[script,'--brewery-batch','Alpha Works|Beta Works|Missing'],{encoding:'utf8',timeout:10000});
 assert.equal(cli.status,0,cli.stderr);
 assert.deepEqual(JSON.parse(cli.stdout),payload.results);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
