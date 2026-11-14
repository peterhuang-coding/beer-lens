import { registerHooks } from 'node:module';

const facades = {
  '@/lib/beer-agent/text-client': ['agentTextFetch'],
  '@/lib/beer-agent/memory/short-term': ['readShortTermMemory'],
  '@/lib/beer-agent/beer-db': ['lookupBeers'],
};

registerHooks({
  resolve(spec, context, next) {
    if (context.parentURL?.endsWith('/lib/skills/beer-knowledge/execute.ts') && facades[spec]) {
      const code = facades[spec].map(name =>
        `export const ${name}=(...args)=>globalThis.__beerKnowledgeDeadlineStub[${JSON.stringify(name)}](...args);`
      ).join('\n');
      return { url: 'data:text/javascript,' + encodeURIComponent(code), shortCircuit: true };
    }
    return next(spec, context);
  },
});
