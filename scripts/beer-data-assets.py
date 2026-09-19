#!/usr/bin/env python3
"""Read-only audit by default; incremental import with backup and one transaction.
No HTTP requests. Crawl jobs are a persistent review/work queue, not crawl successes.
"""
import argparse, hashlib, json, math, re, sqlite3, time
from pathlib import Path

NOTICE = re.compile(r'no longer being produced|discontinued|停产', re.I)
CURRENCIES = {'USD','EUR','GBP','CNY','JPY','HKD','AUD','CAD','DKK','HUF','PLN','RUB','SEK','NOK','NZD','SGD','TWD','CHF','BRL','MXN'}
def digest(obj):
    return hashlib.sha256(json.dumps(obj,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def ro(path):
    return sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro',uri=True,timeout=10)
def columns(db,table):
    return {r[1] for r in db.execute('PRAGMA table_info('+table+')')}
def number(x,lo=0,hi=float('inf')):
    return isinstance(x,(int,float)) and not isinstance(x,bool) and math.isfinite(x) and lo<=x<=hi
def url_id(url):
    m=re.fullmatch(r'https://(?:www\.)?untappd\.com/b/[^/?#]+/(\d+)/?(?:\?[^#]*)?',str(url or ''))
    return m[1] if m else None
def process(source,target,apply=False):
    source,target=Path(source).resolve(),Path(target).resolve()
    if source==target or (target.exists() and source.samefile(target)):raise ValueError('Source and target must differ')
    if not source.is_file() or not target.is_file():raise ValueError('Both databases must exist')
    source_hash=hashlib.sha256(source.read_bytes()).hexdigest()
    s=ro(source);s.row_factory=sqlite3.Row
    t=sqlite3.connect(target) if apply else sqlite3.connect(':memory:')
    if not apply:
        with ro(target) as existing:existing.backup(t)
    report={'source_sha256':source_hash,'apply':apply,'cache_inserted':0,'fields_filled':0,'styles_quarantined':0,'conflicts':0,'observations_inserted':0,'invalid_observations':0,'jobs_inserted':0}
    try:
        if s.execute('PRAGMA quick_check').fetchone()[0]!='ok' or t.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('Database integrity failed')
        required={'id','name','style','abv','rating','ratings_count','untappd_url'}
        shared=columns(s,'untappd_cache')&columns(t,'untappd_cache')
        if not required<=shared:raise ValueError('Missing required cache schema')
        if not {'beer_id','venue_id','price','volume_ml','currency','source_url','scraped_at'}<=columns(s,'venue_prices'):raise ValueError('Missing required venue schema')
        if apply:
            backup=target.with_name(target.name+'.backup-'+str(time.time_ns()))
            with sqlite3.connect(backup) as b:t.backup(b)
            report['backup']=str(backup)
        t.execute('BEGIN IMMEDIATE')
        for sql in [
          'CREATE TABLE IF NOT EXISTS data_conflicts(key TEXT PRIMARY KEY, entity TEXT, field TEXT, existing_json TEXT, incoming_json TEXT, source_sha256 TEXT)',
          'CREATE TABLE IF NOT EXISTS venue_observations(key TEXT PRIMARY KEY, beer_id TEXT, venue_id TEXT, price REAL, volume_ml REAL, currency TEXT, source_url TEXT, observed_at TEXT, comparable INTEGER NOT NULL, issues_json TEXT, raw_json TEXT, source_sha256 TEXT)',
          "CREATE TABLE IF NOT EXISTS crawl_jobs(key TEXT PRIMARY KEY, source TEXT, target TEXT, kind TEXT, reason TEXT, priority INTEGER, status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, next_attempt_at INTEGER DEFAULT 0, last_error TEXT, source_sha256 TEXT)",
          'CREATE TABLE IF NOT EXISTS asset_imports(source_sha256 TEXT PRIMARY KEY, imported_at INTEGER, report_json TEXT)']:
            t.execute(sql)
        def conflict(entity,field,old,new):
            key=digest([entity,field,old,new,source_hash]);cur=t.execute('INSERT OR IGNORE INTO data_conflicts VALUES(?,?,?,?,?,?)',(key,entity,field,json.dumps(old),json.dumps(new),source_hash));report['conflicts']+=cur.rowcount
        def job(target_id,kind,reason,priority):
            key=digest(['untappd',str(target_id),kind]);cur=t.execute('INSERT OR IGNORE INTO crawl_jobs(key,source,target,kind,reason,priority,source_sha256) VALUES(?,?,?,?,?,?,?)',(key,'untappd',str(target_id),kind,reason,priority,source_hash));report['jobs_inserted']+=cur.rowcount
        t.row_factory=sqlite3.Row
        fields=sorted(shared)
        for record in s.execute('SELECT * FROM untappd_cache ORDER BY id'):
            incoming=dict(record);entity=str(incoming['id']);old=t.execute('SELECT * FROM untappd_cache WHERE id=?',(entity,)).fetchone()
            if not entity.strip() or not str(incoming.get('name') or '').strip():
                conflict(entity,'identity',dict(old) if old else None,incoming);continue
            if old and url_id(old['untappd_url']) and url_id(incoming['untappd_url']) and url_id(old['untappd_url'])!=url_id(incoming['untappd_url']):
                conflict(entity,'identity_url',old['untappd_url'],incoming['untappd_url']);job(entity,'resolve_identity','ID has conflicting source URLs',0);continue
            if incoming.get('style') and NOTICE.search(incoming['style']):
                conflict(entity,'style_notice',None,incoming['style']);incoming['style']=None
            for field,hi in [('abv',100),('rating',5),('ratings_count',float('inf'))]:
                value=incoming.get(field)
                if value is not None and (not number(value,0,hi) or (field=='ratings_count' and int(value)!=value)):
                    conflict(entity,field,None,value);incoming[field]=None
            if old is None:
                t.execute('INSERT INTO untappd_cache('+','.join(fields)+') VALUES('+','.join('?' for _ in fields)+')',[incoming.get(f) for f in fields]);report['cache_inserted']+=1
            else:
                for f in fields:
                    if f=='id':continue
                    previous=old[f];new=incoming.get(f)
                    if f=='style' and previous and NOTICE.search(previous):
                        conflict(entity,'existing_style_notice',previous,None);t.execute('UPDATE untappd_cache SET style=NULL WHERE id=?',(entity,));report['styles_quarantined']+=1;previous=None
                    if (previous is None or previous=='') and new is not None and new!='':
                        t.execute('UPDATE untappd_cache SET '+f+'=? WHERE id=?',(new,entity));report['fields_filled']+=1
                    elif new is not None and new!='' and previous!=new:conflict(entity,f,previous,new)
        identities={}
        for row in t.execute('SELECT id,untappd_url,style,abv,rating,ratings_count FROM untappd_cache'):
            for ident in {str(row['id']),url_id(row['untappd_url'])} - {None}:
                identities.setdefault(ident,set()).add(str(row['id']))
            missing=[f for f in ['style','abv','rating','ratings_count'] if row[f] is None or row[f]=='']
            if missing:job(row['id'],'missing_fields',','.join(missing),20)
        for rec in s.execute('SELECT * FROM venue_prices'):
            row=dict(rec);row.pop('id',None);issues=[]
            if not number(row['price'],0.000001):issues.append('nonpositive_price')
            if not number(row['volume_ml'],0.000001):issues.append('unknown_volume')
            if row['currency'] not in CURRENCIES:issues.append('unknown_currency')
            if not re.match(r'^https://(?:www\.)?untappd\.com/',str(row['source_url'] or '')):issues.append('invalid_source_url')
            if not row.get('container') or re.search(r'sample|flight|pack',str(row.get('container')),re.I):issues.append('serving_needs_review')
            stamp=row.get('scraped_at')
            if not number(stamp,1):issues.append('unknown_time')
            links=identities.get(str(row['beer_id']),set())
            if len(links)!=1:
                issues.append('unresolved_beer');job(row['beer_id'],'resolve_identity','Venue observation has no unique cached beer',5)
            report['invalid_observations']+=bool(issues)
            cur=t.execute('INSERT OR IGNORE INTO venue_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(digest(row),str(row['beer_id']),str(row['venue_id']),row['price'],row['volume_ml'],row['currency'],row['source_url'],str(stamp),int(not issues),json.dumps(issues),json.dumps(row,ensure_ascii=False),source_hash));report['observations_inserted']+=cur.rowcount
        report['cache_total']=t.execute('SELECT count(*) FROM untappd_cache').fetchone()[0]
        report['observation_total']=t.execute('SELECT count(*) FROM venue_observations').fetchone()[0]
        report['job_total']=t.execute('SELECT count(*) FROM crawl_jobs').fetchone()[0]
        report['comparable_observations']=t.execute('SELECT count(*) FROM venue_observations WHERE comparable=1').fetchone()[0]
        t.execute('INSERT OR REPLACE INTO asset_imports VALUES(?,?,?)',(source_hash,int(time.time()),json.dumps(report)))
        if hashlib.sha256(source.read_bytes()).hexdigest()!=source_hash:raise ValueError('Source changed during import')
        if t.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('Post-import integrity failed')
        t.commit()
        return report
    except BaseException:
        t.rollback();raise
    finally:
        s.close();t.close()
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',required=True);p.add_argument('--target',required=True);p.add_argument('--apply',action='store_true');p.add_argument('--report')
    args=p.parse_args();result=process(args.source,args.target,args.apply)
    if args.report:Path(args.report).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False,indent=2))
