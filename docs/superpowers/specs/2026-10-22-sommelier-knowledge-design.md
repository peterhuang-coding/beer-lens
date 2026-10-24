# 侍酒师知识:来源化酒款档案与推理契约设计(2026-10-22)

状态:仅设计与评测 gold,不改生产代码、不接模型、不跑提示词。60s 为目标而非已测量;所有"答案"为期望(expected),非模型实际输出。来源仅本轮列出的源码与公开资料,不新增 URL 或真实酒款数值。

## 1. 知识缺口审计(现状,代码锚点)

- `lib/skills/beer-knowledge/execute.ts` 的 `execute`:一次模型调用,系统提示为泛化口语规则("直接用你的知识回答");注入画像、`buildMenuPromptSection` 菜单块、`lookupBeers` 旧库探测,旧库行仅渲染 名称/酒厂/风格/ABV/评分/人数,无结构化酒花、原料、旗舰、价格来源。`extractProbes` 为 ≤8 个关键词探测,证据文本内事实可能漏检。45s 单次超时(`coding-plan` 180s)、max_tokens 1500、temperature 0.3;无结构化回答契约,无覆盖度反馈。
- `lib/skills/beer-knowledge/skill.ts` 描述仍写"纯LLM回答,不查数据库",与 execute 的旧库探测矛盾。
- `lib/skills/beer-knowledge/menu-context.ts`:`MAX_CANDIDATES=8`、每款 ≤3 证据;`selectShown` 把显式引用行(如 #99)换入且 cap 不增长;`renderBeer` 只输出 风格/ABV/Untappd 分数与人数/价格容量/证据原文,不输出 `BeerCandidate.hops`(`lib/beer-agent/types.ts`),无酒厂实力、旗舰、评分日期、品饮顺序。规则块已含来源优先、感官需来源、`valuePossible` 无价格不判价值、同名歧义反问、菜单外名称、「」注入隔离。
- `lib/beer-agent/menu-supplements.ts` + `data/menus/elnido-2026-10.json`(17 款,taps 2–18,2026-10-20 转录):身份三态 confirmed/version_unresolved/batch_unresolved;`applyGrounding` 唯一匹配后清除旧评分/ID/链接/originBenchmark/valueScore;ABV 容差 0.06 区分一位小数显示(6.66/6.7)与真冲突(9/9.1);酒花/风味仅存于 `description_zh` 自由文本,无结构化字段。`groundMenuSupplements` 仅在图像推荐链路调用,知识技能不直接读补充文件,只能经短期记忆候选 evidence 原文间接受益。
- `lib/beer-agent/recommendation/reply-builder.ts`:评分可用须分数+人数;稀疏单款诚实回答;仅同菜单两款做价量比较。`lib/beer-agent/recommendation/decision.ts` 做硬约束筛选。缺口:跨会话知识复用契约、酒厂/旗舰知识、知识侧产地比价证据闸(originBenchmark 已被补充链路清空,但提示词无对应硬规则)。
- 数据面:147 活动条目与 17 补充行是试点,非全量;多数旧库行仅 名称/风格/ABV/评分;评分日期/样本量只散见证据文本。

## 2. 来源化酒款档案(Dossier)

建议新增纯类型 `lib/beer-agent/dossier/types.ts` 与纯函数 `build-dossier.ts`,由 BeerCandidate、已读取的 MenuSupplementEntry 索引和旧库探测行装配。`getSupplementGrounding()` 仅返回 entryId/menuId/identityStatus/evidence，不能当完整条目；以返回 ID 关联已载入条目,无 I/O、不 mutate:

- identity:menuId、menuIndex、snapshotDate、displayName、canonicalName、brewery、aliases、identityStatus。
- Claim<T> = {value, source(ocr|venue_site|social_web|untappd|legacy_db|agent_inference), url?, access?, excerpt?, checkedAt?, publishedAt?, reviewStatus, usable}。
- 字段:style;abv{观察值[], 冲突值[], resolution}（明确来源的 0% 是有效值，null 才是缺失，不沿用旧代码将 0 视作未知的约定）;hops: Claim<string[]>|null;ingredients/sensory 同;rating{score,count,source,date}|null(冲突或被宣告不可用即为 null);brewery{strengths, flagship: null|{beer, evidence[], status: proven|unproven}};offer{price,currency,volumeMl,observedAt};preferenceFit(画像推导,强制个人标注)。
- styleLayer:风格通讲,款级无来源时使用,输出必须标注,永不升级为款级事实。
- coverage:每字段状态 sourced | menu_observed | style_inference | conflicted | unknown。

硬闸:酒花/原料/款级风味只接受证据层来源;高分不产生 flagship(须酒厂自有来源或多份独立来源明称核心/招牌);产地比价须同版本、同饮用形式（生啤/瓶罐分别）的 Claim，包含容量、币种、税费口径、价格观察日、汇率来源及日期;价格仅属于本菜单快照,不注入其他菜单(沿用补充文件适用范围声明)。

## 3. 推理契约

待评审、未接入的文本见 `docs/sommelier-system-prompt-draft.md`:身份先消歧 → 具体断言必带来源层 → ABV 冲突并列 → 评分三要素+旗舰证据闸 → 价格/产地证据闸 → 偏好分层 → 菜单边界 → 注入隔离。信息不足时给"标注的风格通讲 + 一个下一步",禁止只有免责声明,禁止伪装品鉴经历与库存断言。

首轮回答契约：先给 2–3 个优先选择及理由，再按当前菜单编号列全每款的身份、度数、价格/容量和一句有用的口味/适配说明。详情和来源可按需展开，但不能把全单缩成前 8 款。已知事实、风格推断和用户偏好用自然语言区别；不能整屏未知，也不能虚构缺失事实。图片不清时保留疑似条目和缺口，不能宣称识别完整。

## 4. 增量富集与人工反馈(无调度器、无无人值守授权)

字段证据状态机:unknown → menu_observed(仅转录) → public_sourced(URL+checked_at+身份 confirmed) → conflicted(多源并存,不撤回观察值) → withdrawn(被撤回,如旧评分清除)。每次转换必须带来源记录。

富集批次（在已授权范围自动生成候选，由主代理核验来源与抽检；冲突/低置信项人工处理）:
- S1 已知菜单:17 补充行增补结构化 sourced_facts(hops/sensory 指向 sources 下标;以下是既有描述中的候选，结构化前逐字段核对 sources.fields、原文及访问方式，不能将索引摘要说成直连官网验证:#3 Citra/Nelson Sauvin、#10 Nelson/Nectaron/Citra、#12 Citra/Strata/Mosaic/Nelson Sauvin/Krush、#6 Pink Boots/Vista、#7 Saaz、#8 Saphir);#2 因 Untappd 与经销商酒花清单互斥保持 null。
- S2 高频追问酒厂与招牌:凭证据立 flagship,否则 unproven。
- S3 风格/酒花通用知识库:只服务 styleLayer,禁止挂到具体酒款。
- S4 覆盖度度量:按字段统计 sourced 覆盖率、未决身份数、冲突数、可用评分数、价量齐套数、追问未命中类型;不按行数计功;不承诺覆盖全啤酒宇宙。

反馈条目状态:open → needs_evidence(请用户补链接/照片) → accepted(人工核对并入 JSON,带 checked_at)/ rejected(记原因) → superseded(新快照替换)。用户的“太甜/喜欢”进入个人适配反馈，不自动变成公共酒款事实。事实纠错要证据，推荐策略变更先跑冻结回归与留出集，再批准采用；本设计不创建新调度。

## 5. 文件级任务与依赖(本包不实施)

- T1 `data/menus/elnido-2026-10.json` 增可选 `sourced_facts`;`lib/beer-agent/menu-supplements.ts` 的 `isMenuSupplementEntry` 守卫同步。
- T2 新建 `lib/beer-agent/dossier/types.ts`、`build-dossier.ts`(纯函数,可单测,复用 `getSupplementGrounding`)。
- T3 `lib/skills/beer-knowledge/menu-context.ts` 扩展或新建同级 `dossier-context.ts`:保留「」隔离与 `resolveReference` 消歧；全菜单简明档案必须保留，8 款/3 证据最多是详细引文预算，不能限制菜单覆盖。点名尾部条目时展开该款，且不覆盖完整快照。
- T4 `lib/skills/beer-knowledge/execute.ts` 采用 SP 草案,保留旧库低优先定位；现有 45s/套餐180s 超时不等于达标，首次回复须受时延方案的端到端剩余预算约束。
- T5 更新 `lib/skills/beer-knowledge/skill.ts` 过时描述。
- T6 离线覆盖度脚本与人工反馈队列(后续包),无定时任务。依赖:T1/T2 并行 → T3 → T4;T5 独立。

## 6. 验收场景(期望,非实测)

1. no-OCR-only:仅 OCR 行不产生款级风味/酒花断言;稀疏时给标注风格通讲+下一步。
2. no-top-eight-only:18 款清晰菜单首轮必须有 18 款简明知识解读；只列 8 款或只在被问时补尾部均失败。追问任意行仍准确引用，不重做 OCR。
3. incomplete-menu:清晰菜单按人工金标核对每个编号，必须无漏项；无法识别的行明确待确认。模糊图不能靠声明“仅展开部分”算完整成功。
4. unknown-version:#11 只报观察 9.5% 与候选版本,不迁移 8.5% 旧款或 #2 评分。
5. unsupported-classic/菜单外:无证据不称旗舰/经典;菜单外名酒(如 Tree House Julius)只做标界通讲,不套用菜单事实。
6. wrong-country-price:无同版本同口径产地价不给贵贱/折扣;禁国家均价与汇率常数;未知价≠贵,单位价≠整体品质。
7. cross-user-context:只读当前 conversationId+userId 短期记忆(execute 现状),不写画像、不跨用户引用。
8. 冲突 ABV(#15 9% vs 9.1%)并列、一位小数显示(#10、#18)按已解释处理;偏好不合表述为个人适配而非酒差。

## 7. 目标与度量

60s 端到端为目标;既往图像调用约 54s/99s、一次知识调用超时(背景,非本次验证)。档案拟在菜单导入时预计算,知识回合保持一次有界模型调用;Feishu 新图端到端未验收。本包不跑模型,以下用例为 gold 期望,不构成测量结果或真实回答。

## 8. Gold 用例(评测 JSON;数值仅取自 elnido-2026-10.json 的历史转录快照；行号仅适用于该快照，不能当作今日酒单)

```json
[
  {
    "id": "gold-hops-sourced",
    "input": "#3 Kiwi Fingers 用了什么酒花?",
    "expected": "据现有来源包的 Untappd 索引/缓存摘要(2026-10-21 核对)记载 Citra 与 Nelson Sauvin；该字段未记录为 ISM 官网支持;菜单转录 6.8%、¥90/300ml(2026-10-20);「Kiwi」是酒名,不构成猕猴桃配料证据。",
    "forbidden": "补编其他酒花;声称猕猴桃配料/风味;把风格通讲表述为来源",
    "measurement": "含 Citra、Nelson Sauvin 且声明来源层;无未授权酒花名;人工 0/1 评分",
    "layer": "social_web+ocr"
  },
  {
    "id": "gold-style-only",
    "input": "#4 Victory Lap 喝起来什么感觉?",
    "expected": "公开来源只覆盖身份/West Coast Pilsner/5.0%,无款级风味来源;可给标注「风格通讲,非本款事实」的通讲:干爽、明显酒花苦感与柑橘/松脂方向香气。",
    "forbidden": "把通讲断言为该酒来源描述;虚构酒厂品鉴语",
    "measurement": "出现「风格通讲」标注;无伪装来源措辞;人工 0/1",
    "layer": "style_inference"
  },
  {
    "id": "gold-flagship-no-evidence",
    "input": "Free Lunch 评分那么高,是 BlackStack 的旗舰吗?",
    "expected": "无酒厂自有或多份独立来源的旗舰/核心证据,不能认定;缓存评分快照 4.38/181 与 4.289/943 冲突,不采用任何评分;可述 10.1% Triple NEIPA 与来源酒花 Citra/Strata/Mosaic/Nelson Sauvin/Krush。",
    "forbidden": "称旗舰/招牌;引用任一冲突评分为当前事实;高分即证据",
    "measurement": "含「无旗舰证据」语义;4.38/4.289 仅以冲突说明出现;人工 0/1",
    "layer": "social_web"
  },
  {
    "id": "gold-preference-mismatch",
    "input": "画像=不苦、不喝高度酒;「Free Lunch 适合我吗?」",
    "expected": "客观:10.1% 三倍浑浊、酒花清单有来源但不直接证明苦感强度;按你不喝高度酒的偏好不合适，这不代表酒差。旧快照中 #4(5%)、#8(4.5%)仅是低度候选，不保证不苦；进一步按风格与苦感证据筛选，必要时建议先试饮。",
    "forbidden": "说该酒不好/避雷;声称适合所有人;不给替代",
    "measurement": "含偏好限定语;不将低度候选冒充低苦推荐;无客观贬低;人工 0/1",
    "layer": "user_profile+social_web"
  },
  {
    "id": "gold-origin-price-no-evidence",
    "input": "Reclaim Me 2026 卖 ¥160/200ml,比产地便宜吗?",
    "expected": "仅有 2026-10-20 菜单转录价;无同版本(Reclaim Me 2026)、同饮用形式且可按容量归一的产地售价证据,不能算折扣或判贵贱;不用国家均价/汇率常数;公开确切 ABV 19.25%,菜单 19.2% 为一位小数显示;未标年份的 15% Reclaim Me 是另一款。",
    "forbidden": "给出折扣%;国家常数推断;值/不值断言;混入 15% 款价格",
    "measurement": "无缺乏价格证据的溢价/折扣数值；不误伤有来源的 ABV 百分数或国家名称;含证据缺失声明;人工 0/1",
    "layer": "ocr+social_web"
  },
  {
    "id": "gold-abv-conflict",
    "input": "#15 Double Blueberry Marshmallow Shake 到底几度?",
    "expected": "分歧并列:酒厂订购页 9.10%、Systembolaget 9%、菜单转录 9%;不取平均、不静默归一,建议以瓶标/现场为准;区别于旧款 Double Blueberry Shake;被拒的 BeerAdvocate 误描述不作证据。",
    "forbidden": "只报单值;取平均;静默归一",
    "measurement": "9% 与 9.1% 同现且无单值断言;人工 0/1",
    "layer": "social_web+ocr"
  },
  {
    "id": "gold-version-unresolved",
    "input": "#11 K-philia 是那款 8.5% 的吗?",
    "expected": "照片仅写 K-philia、观察 9.5%,版本未确认;8.5% Imperial Oat Cream IPA 旧款是另一款;候选 K-philia #2(Kyoto Brewing 合酿,9.5% DDH 西海岸三倍 IPA)未获照片 #2 标识确认;不迁移任何评分。",
    "forbidden": "直接等同 #2;迁移旧款评分;套用规范风格/ABV",
    "measurement": "9.5% 观察值与「版本未确认」同现;人工 0/1",
    "layer": "ocr+social_web"
  },
  {
    "id": "gold-roster-and-outside",
    "input": "Ology 怎么样?有 Tree House Julius 吗?",
    "expected": "逐行说明菜单内 Ology #4/#5/#6/#14 的已来源事实,不做无来源酒厂总评;Tree House Julius 不在本菜单,仅可做标界的一般知识,不套用菜单 ABV/价格,不声称库存。",
    "forbidden": "泛化酒厂排名;把菜单事实套到 Julius;声称有货/售罄",
    "measurement": "列出 4 个行号且出现菜单外声明;人工 0/1",
    "layer": "ocr+social_web+style_inference"
  }
]
```
