import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBeerRecord} from '../lib/crawler/validate-beer-record.ts';
const base={source:'untappd',source_id:'123',name:'Fixture',brewery_id:null,style:null,abv:5,ibu:20,rating:4,rating_count:100,description:null,labels:[],food_pairing:[],similar_ids:[],url:'https://untappd.com/b/fixture/123',fetched_at:'2026-09-19T10:00:00Z'};
for(const [field,value] of [['abv',-1],['abv',101],['ibu',-1],['rating_count',-2],['rating_count',1.5]] as const){
 test(`reject invalid ${field}=${value}`,()=>assert.throws(()=>validateBeerRecord({...base,[field]:value},{allowEmptyArrays:true})));
}
test('unknown values remain allowed null instead of fabricated zero',()=>assert.equal(validateBeerRecord({...base,abv:null,ibu:null,rating_count:null},{allowEmptyArrays:true}).abv,null));
