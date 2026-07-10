/**
 * 生成 20 条纯文本多轮 VQA 测试任务。
 * 所有 beer 名来自 SQLite 真实数据，不依赖外部图片。
 * 每条任务包含明确的 pass 标准，测试时不改标准。
 */
import { writeFileSync } from "fs";
import path from "path";

const TASKS = [
  // ── 1. menu_recommend (4) ──
  {
    id: "vqa_menu_recommend_1",
    title: "酒吧菜单推荐 — IPA爱好者",
    candidateBeerName: "Pliny the Elder",
    description: "用户要求推荐IPA，agent 应返回候选啤酒（含评分和酒厂信息）",
    query: JSON.stringify([
      { role: "user", content: "帮我推荐一款IPA，要苦味明显的，西海岸风格最好" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否正确识别为 menu_recommend？" },
      { id: "has_candidates", type: "yesno", prompt: "是否返回了至少 1 个候选啤酒？" },
      { id: "has_rating", type: "yesno", prompt: "候选啤酒是否包含评分？" },
    ],
    passCriteria: { intent: "menu_recommend", minCandidates: 1, replyMinLen: 50 },
  },
  {
    id: "vqa_menu_recommend_2",
    title: "酒吧菜单推荐 — 世涛爱好者",
    candidateBeerName: "Parabola",
    description: "用户要求推荐高酒精度世涛，agent 应返回候选啤酒",
    query: JSON.stringify([
      { role: "user", content: "推荐世涛，要酒精度高的，帝国世涛那种" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否正确识别为 menu_recommend？" },
      { id: "has_candidates", type: "yesno", prompt: "是否返回了候选啤酒？" },
    ],
    passCriteria: { intent: "menu_recommend", minCandidates: 1, replyMinLen: 50 },
  },
  {
    id: "vqa_menu_recommend_3",
    title: "酸啤酒推荐 — 入门者",
    candidateBeerName: "Rodenbach Caractère Rouge",
    description: "第一次喝酸啤的用户请求推荐",
    query: JSON.stringify([
      { role: "user", content: "酸啤酒有什么推荐的？我第一次喝酸啤，不知道哪种好" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否正确识别为 menu_recommend？" },
      { id: "has_candidates", type: "yesno", prompt: "是否返回了候选啤酒？" },
    ],
    passCriteria: { intent: "menu_recommend", minCandidates: 1, replyMinLen: 50 },
  },
  {
    id: "vqa_menu_recommend_4",
    title: "多轮追问 — 比利时啤酒选择",
    candidateBeerName: "Tripel Karmeliet",
    description: "多轮对话：先问推荐，再追问具体酒款区别",
    query: JSON.stringify([
      { role: "user", content: "推荐几款比利时啤酒吧" },
      { role: "assistant", content: "好的，比利时啤酒推荐：Tripel Karmeliet（评分3.98，8.4%ABV）、Curieux（评分4.04，10.2%ABV）、De Garre（评分4.09，11%ABV）。" },
      { role: "user", content: "Tripel Karmeliet和Curieux有什么区别？哪个更甜？" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "第一轮意图是否正确？" },
      { id: "follow_up_match", type: "yesno", prompt: "第二轮追问是否正确识别为 follow_up_filter？" },
    ],
    passCriteria: { intent: "menu_recommend", minCandidates: 1, replyMinLen: 50 },
  },

  // ── 2. label_check (2) ──
  {
    id: "vqa_label_check_1",
    title: "酒标检查 — 生产日期",
    candidateBeerName: "",
    description: "用户询问酒标上的生产日期/保质期",
    query: JSON.stringify([
      { role: "user", content: "帮我看看这瓶酒的生产日期，我不确定还能不能喝" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否正确识别为 label_check？" },
    ],
    passCriteria: { intent: "label_check" },
  },
  {
    id: "vqa_label_check_2",
    title: "酒标检查 — 过期判断",
    candidateBeerName: "",
    description: "询问啤酒是否过期",
    query: JSON.stringify([
      { role: "user", content: "这瓶啤酒过期了吗？怎么看日期？" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否正确识别为 label_check？" },
    ],
    passCriteria: { intent: "label_check" },
  },

  // ── 3. tasting_feedback (3) ──
  {
    id: "vqa_tasting_feedback_1",
    title: "品饮反馈 — IPA评分",
    candidateBeerName: "Pliny the Elder",
    description: "用户喝完一款IPA后给出评分和品饮感受",
    query: JSON.stringify([
      { role: "user", content: "今天喝了Pliny the Elder，非常棒！8%的酒精度完全喝不出来，柑橘味爆炸，给4.5分，绝对会再喝" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否正确识别为 tasting_feedback？" },
      { id: "score_parsed", type: "yesno", prompt: "评分是否被正确解析？" },
    ],
    passCriteria: { intent: "tasting_feedback" },
  },
  {
    id: "vqa_tasting_feedback_2",
    title: "品饮反馈 — 世涛品鉴",
    candidateBeerName: "Parabola",
    description: "用户品鉴帝国世涛，描述风味并评分",
    query: JSON.stringify([
      { role: "user", content: "开了一瓶Parabola，14.1%的酒精度完全不像，入口是浓烈的波本桶味、黑巧克力、焦糖，给4分，会再喝" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否正确识别为 tasting_feedback？" },
    ],
    passCriteria: { intent: "tasting_feedback" },
  },
  {
    id: "vqa_tasting_feedback_3",
    title: "品饮反馈 — 酸啤初体验",
    candidateBeerName: "Rodenbach Caractère Rouge",
    description: "用户第一次喝酸啤的描述",
    query: JSON.stringify([
      { role: "user", content: "第一次喝酸啤，Rodenbach Caractère Rouge，好酸！但很特别，樱桃味明显，给3.5分，看情况再喝" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否正确识别为 tasting_feedback？" },
    ],
    passCriteria: { intent: "tasting_feedback" },
  },

  // ── 4. beer_knowledge (3) ──
  {
    id: "vqa_beer_knowledge_1",
    title: "啤酒知识 — IPA vs Lager",
    candidateBeerName: "",
    description: "用户询问IPA和拉格的区别",
    query: JSON.stringify([
      { role: "user", content: "IPA和拉格（Lager）到底有什么区别？不只是苦不苦的问题" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否正确识别为 beer_knowledge？" },
      { id: "has_detail", type: "yesno", prompt: "回复是否包含酿造工艺等细节信息？" },
    ],
    passCriteria: { intent: "beer_knowledge", replyMinLen: 100 },
  },
  {
    id: "vqa_beer_knowledge_2",
    title: "啤酒知识 — 风格分支",
    candidateBeerName: "",
    description: "用户询问West Coast IPA和NEIPA的区别",
    query: JSON.stringify([
      { role: "user", content: "West Coast IPA和New England IPA有什么区别？" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否正确识别为 beer_knowledge？" },
    ],
    passCriteria: { intent: "beer_knowledge", replyMinLen: 100 },
  },
  {
    id: "vqa_beer_knowledge_3",
    title: "啤酒知识 — 桶陈工艺",
    candidateBeerName: "",
    description: "用户询问桶陈世涛为什么受欢迎",
    query: JSON.stringify([
      { role: "user", content: "为什么桶陈世涛这么受欢迎？BCBS每年发售都排长队" },
      { role: "assistant", content: "桶陈世涛（Barrel Aged Stout）因为波本桶带来的香草、椰子、橡木风味，加上高酒精度陈年后更顺滑，所以很受欢迎。BCBS（Bourbon County Brand Stout）是 Goose Island 的旗舰产品。" },
      { role: "user", content: "那除了BCBS还有什么好的桶陈世涛推荐？" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否正确识别为 beer_knowledge？" },
    ],
    passCriteria: { intent: "beer_knowledge", replyMinLen: 80 },
  },

  // ── 5. profile_query (2) ──
  {
    id: "vqa_profile_query_1",
    title: "画像查询 — 口味偏好",
    candidateBeerName: "",
    description: "用户询问自己的口味画像",
    query: JSON.stringify([
      { role: "user", content: "我的口味偏好是什么？帮我看看我的画像" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否正确识别为 profile_query？" },
    ],
    passCriteria: { intent: "profile_query" },
  },
  {
    id: "vqa_profile_query_2",
    title: "画像查询 — 喝过什么",
    candidateBeerName: "",
    description: "用户询问自己喝过哪些酒",
    query: JSON.stringify([
      { role: "user", content: "我之前喝过哪些啤酒？帮我看看历史记录" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否正确识别为 profile_query？" },
    ],
    passCriteria: { intent: "profile_query" },
  },

  // ── 6. memory_correction (2) ──
  {
    id: "vqa_memory_correction_1",
    title: "记忆纠正 — 口味偏好纠正",
    candidateBeerName: "",
    description: "用户纠正之前说过的口味偏好",
    query: JSON.stringify([
      { role: "user", content: "上次我说喜欢IPA，但其实我更喜欢西海岸IPA那种清亮苦味明显的，NEIPA太浑浊了不太喜欢" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否正确识别为 memory_correction？" },
    ],
    passCriteria: { intent: "memory_correction" },
  },
  {
    id: "vqa_memory_correction_2",
    title: "记忆纠正 — 重置",
    candidateBeerName: "",
    description: "用户要求清空所有记忆",
    query: JSON.stringify([
      { role: "user", content: "清空我的所有记忆，重置" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否正确识别为 memory_correction？" },
    ],
    passCriteria: { intent: "memory_correction" },
  },

  // ── 7. follow_up_filter (2) ──
  {
    id: "vqa_follow_up_filter_1",
    title: "追问过滤 — 风格细化",
    candidateBeerName: "",
    description: "在上轮推荐后追问特定风格",
    query: JSON.stringify([
      { role: "user", content: "推荐几款IPA" },
      { role: "assistant", content: "推荐：Pliny the Elder（评分4.49，8%ABV）、Heady Topper（评分4.52，8%ABV）、King Sue（评分4.3，7.8%ABV）。" },
      { role: "user", content: "这里面哪款苦味最轻？" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "第一轮意图是否正确？" },
      { id: "follow_up_match", type: "yesno", prompt: "追问是否正确识别为 follow_up_filter？" },
    ],
    passCriteria: { intent: "menu_recommend", minCandidates: 1, replyMinLen: 50 },
  },
  {
    id: "vqa_follow_up_filter_2",
    title: "追问过滤 — 推荐再细化",
    candidateBeerName: "",
    description: "用户要求在第一轮推荐基础上进一步筛选",
    query: JSON.stringify([
      { role: "user", content: "推荐世涛" },
      { role: "assistant", content: "推荐：Parabola（评分4.42，13%ABV）、Bourbon County Brand Stout（评分4.73，14%ABV）、Founders Breakfast Stout（评分4.18，8.3%ABV）。" },
      { role: "user", content: "这几款里哪个酒精度最高？我想要最烈的" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "第一轮意图是否正确？" },
      { id: "follow_up_match", type: "yesno", prompt: "追问是否正确识别？" },
    ],
    passCriteria: { intent: "menu_recommend", minCandidates: 1, replyMinLen: 50 },
  },

  // ── 8. unclear (2) ──
  {
    id: "vqa_unclear_1",
    title: "意图不明 — 单字输入",
    candidateBeerName: "",
    description: "用户只输入一个字的模糊请求",
    query: JSON.stringify([
      { role: "user", content: "酒" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否正确识别为 unclear？" },
    ],
    passCriteria: { intent: "unclear" },
  },
  {
    id: "vqa_unclear_2",
    title: "意图不明 — 模棱两可",
    candidateBeerName: "",
    description: "用户输入模棱两可的请求",
    query: JSON.stringify([
      { role: "user", content: "帮我推荐一个啤酒吧。" },
    ]),
    questions: [
      { id: "intent_match", type: "yesno", prompt: "意图是否合理路由？" },
    ],
    passCriteria: { intent: "menu_recommend", minCandidates: 1, replyMinLen: 50 },
  },
];

// 生成任务
const now = new Date();
const tasks = TASKS.map((t, i) => ({
  id: t.id,
  source: "synthetic",
  sourceUrl: "",
  imageUrl: "",
  title: t.title,
  candidateBeerName: t.candidateBeerName || "",
  description: t.description,
  query: t.query,
  questions: t.questions,
  labels: { passCriteria: t.passCriteria },
  status: "pending",
  createdAt: new Date(now.getTime() + i * 1000).toISOString(),
  updatedAt: new Date(now.getTime() + i * 1000).toISOString(),
}));

const filePath = path.join(process.cwd(), "data", "vqa-tasks", "tasks.json");
writeFileSync(filePath, JSON.stringify(tasks, null, 2) + "\n");
console.log(`生成 ${tasks.length} 条 VQA 任务`);
console.log("覆盖意图:", [...new Set(TASKS.map(t => t.passCriteria.intent))].join(", "));
console.log("每条任务包含 passCriteria:", TASKS.every(t => t.passCriteria) ? "✅" : "❌");