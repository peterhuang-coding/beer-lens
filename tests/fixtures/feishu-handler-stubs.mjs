import {registerHooks} from 'node:module';
const facades={
 '../agent/controller.ts':['runAgentTurn'],
 './mbcb.ts':['handleMbcbQuery'],
 './client.ts':['downloadFeishuImage','replyFeishuMessage'],
 './conversations.ts':['beginConversationTurn','clearConversation','completeConversationTurn','getConversationMessages'],
 '../beer-agent/memory/short-term.ts':['clearShortTermMemory'],
 '../beer-agent/cases.ts':['listCases','updateCase'],
};
registerHooks({resolve(spec,context,next){
 if(context.parentURL?.endsWith('/lib/feishu/handler.ts')&&facades[spec]){
  const code=facades[spec].map(name=>`export const ${name}=(...args)=>globalThis.__beerFeishuStub[${JSON.stringify(name)}](...args);`).join('\n');
  return {url:'data:text/javascript,'+encodeURIComponent(code),shortCircuit:true};
 }
 return next(spec,context);
}});
