import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const facades = [
  ['/lib/beer-agent/provider.ts', './multi-stage-pipeline', ['runMultiStagePipeline']],
  ['/lib/beer-agent/beer-db/pipeline.ts', './data-layer', ['batchLookupBeers','getBeerDbStats','lookupBrewery','batchLookupBreweries']],
  ['/lib/beer-agent/beer-db/untappd-client.ts', './data-layer', ['searchBeer','getBeerInfo','batchSearchBeers']],
  ['/lib/beer-agent/beer-db/enricher.ts', './untappd-verify', ['verifyUntappdRating']],
  ['/lib/beer-agent/beer-db/pipeline.ts', './updater', ['refreshDatabase']],
];
registerHooks({ resolve(spec, context, next) {
  const key = spec.replace(/\.ts$/, '');
  const f = facades.find(([parent, name]) => context.parentURL?.endsWith(parent) && key === name);
  if (f) {
    const code = f[2].map(name => `export const ${name}=(...args)=>globalThis.__beerImageFixture[${JSON.stringify(name)}](...args);`).join('\n');
    return {url: 'data:text/javascript,' + encodeURIComponent(code), shortCircuit:true};
  }
  if (spec.startsWith('.') && context.parentURL?.startsWith('file:') && !/\.[cm]?[jt]s$/.test(spec)) {
    const target = new URL(spec + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(target))) return next(target.href, context);
  }
  return next(spec, context);
}});
