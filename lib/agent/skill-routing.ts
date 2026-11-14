/**
 * Controller-level routing guard for knowledge follow-ups.
 *
 * The public keyword router is intentionally terse and maps "哪款…" to the
 * recommendation skill. On an active menu, a question such as "哪款酒花最香"
 * or "哪款是经典款" is asking for sourced beer knowledge, not another pick.
 * Keep this decision pure so it can be tested without loading model code.
 */
export function knowledgeFollowUpIntent(text: string, hasActiveMenu: boolean): boolean {
  if (!hasActiveMenu) return false;
  const normalized = (text || "").trim();
  if (!normalized) return false;

  const knowledge = /酒花|啤酒花|\bhops?\b|经典款|经典地位|是经典|旗舰|评分|untappd|产地|原产|哪个国家|哪国产|原料|配料|工艺|历史|故事|为什么|区别|是什么|定义|如何酿|怎么酿|保存|陈年|酒厂/i;
  if (!knowledge.test(normalized)) return false;

  // An explicit transaction wins: budget/price/choose/swap requests stay on
  // the deterministic recommendation path. A knowledge word inside such a
  // request ("推荐一款经典 IPA") still stays a recommendation request.
  const transactional = /推荐|帮我选|选哪款|买哪款|哪款.*(?:最适合|适合我|好喝|值得|划算|便宜|贵)|预算|多少钱|价格|最便宜|性价比|单位价|换一|再来/i;
  return !transactional.test(normalized);
}
