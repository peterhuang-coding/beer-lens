import { registerHooks } from 'node:module';

const facades = {
  './context': ['buildAgentContext', 'describeContext'],
  './skill-registry': ['buildSkillPrompt', 'parseSkillSelection', 'ensureSkillsLoaded', 'getSkill'],
  '../harness/router-rules.ts': ['keywordRoute'],
  '@/lib/beer-agent/text-client': ['agentTextFetch'],
  '@/lib/beer-agent/trace': ['writeTrace'],
  '@/lib/beer-agent/memory/short-term': ['updateShortTermMemory'],
  '@/lib/beer-agent/monitor/metrics': ['recordTurnStart', 'recordTurnEnd', 'recordHandlerError'],
  '@/lib/skills/fallback/execute': ['execute'],
};

registerHooks({
  resolve(spec, context, next) {
    if (context.parentURL?.endsWith('/lib/agent/controller.ts') && facades[spec]) {
      const code = facades[spec].map(name =>
        `export const ${name}=(...args)=>globalThis.__beerControllerDeadlineStub[${JSON.stringify(name)}](...args);`
      ).join('\n');
      return { url: 'data:text/javascript,' + encodeURIComponent(code), shortCircuit: true };
    }
    if (context.parentURL?.endsWith('/lib/agent/controller.ts') && spec === '@/lib/harness/skill-registry') {
      return { url: 'data:text/javascript,export%20%7B%7D', shortCircuit: true };
    }
    return next(spec, context);
  },
});
