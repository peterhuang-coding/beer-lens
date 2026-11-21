import { registerHooks } from 'node:module';

const parents = [
  '/lib/beer-agent/event-grounding.ts',
  '/lib/beer-agent/menu-supplements.ts',
  '/lib/beer-agent/file-cache.ts',
];

registerHooks({
  resolve(spec, context, next) {
    if (spec === 'node:fs/promises' && parents.some(parent => context.parentURL?.endsWith(parent))) {
      const code = `
        import * as fs from 'node:fs/promises';
        export async function readFile(...args) {
          globalThis.__beerMenuFileReads.push(String(args[0]));
          return fs.readFile(...args);
        }
        export const stat = fs.stat;
      `;
      return { url: 'data:text/javascript,' + encodeURIComponent(code), shortCircuit: true };
    }
    return next(spec, context);
  },
});
