import { registerHooks } from 'node:module';

registerHooks({
  resolve(spec, context, next) {
    if (context.parentURL?.endsWith('/lib/beer-agent/multi-stage-pipeline.ts') && spec === './openrouter-client') {
      const code = 'export const openrouterFetch=(...args)=>globalThis.__beerPipelineDeadlineStub.openrouterFetch(...args);';
      return { url: 'data:text/javascript,' + encodeURIComponent(code), shortCircuit: true };
    }
    return next(spec, context);
  },
});
