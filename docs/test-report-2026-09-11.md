# Beer Lens 实测报告 — 2026-09-11

结论：构建和单元测试通过，但真实图片、推荐行为和接口回归不合格，不能作为验收通过版本。

测试基线为 main `bb15d41`，本轮未修改业务代码或放宽现有断言。原有的爬虫基线、harness 和 selector-drift 报告改动保留。真实请求调用本机同一个 `127.0.0.1:3000` 服务及已配置的模型；不是 mock。模型输出可能随时间、上下文和上游可用性变化。

## 执行结果

| 项目 | 本轮结果 | 含义 |
| --- | --- | --- |
| `npm test` | 465/465 通过，65 suites，0 skip | 单元测试通过，不代表真实模型推荐正确 |
| `npm run typecheck` | 退出码 0 | 类型检查通过 |
| `npm run build` | 退出码 0 | Next.js 16.3.4 生产构建通过 |
| `/api/agent` 回归 | 344/344 已执行；按原断言 0 通过 | 数据目录的完整用例集，独立测试用户，关闭 badcase 写入 |
| VQA 目录 | 60/60 已执行；按原 passCriteria 0 通过 | 这 60 条的 imageUrl 全为空，实际是文本用例 |
| 页面 3 张示例图 | 3/3 已实际发送；逐项人工验收均发现失败 | 详见下一节 |
| fixture 酒单 | `/api/chat` 和 `/api/agent` 均 HTTP 200 | 各约 101 秒、85 秒；能识别酒单，推荐仍有缺陷 |
| `benchmark:images` | 原脚本报告 2/2 PASS | 两个文件内容相同；第二条行为错误仍被弱断言放过 |
| Golden 酒单集 | 11 条可运行文本全部发到 `/api/chat`，11 条人工语义检查失败 | 1 条缺图片未运行；不是所有未来 golden contract 指标的自动实现 |

完成在线测试后才停止开发服务进行构建，再启动生产服务。最终只有一个 Beer Lens 监听进程，占用 3000；`/chat`、`/debug`、`/api/cases`、`/test-runner` 均 HTTP 200。生产启动后的检查是页面/API 冒烟，完整模型回归运行于构建前的同版本开发服务。

## 页面图片实测

使用 `public/test-assets/` 原有图片和 `ChatBox.tsx` 原有默认提问。El Nido 通过 Playwright 点击真实页面按钮；另外两张以同样字段、原图和默认提问调用 `/api/chat`。

| 图片 | 提问 | 实际结果 | 判定 |
| --- | --- | --- | --- |
| `menu-el-nido.png` | 这酒单帮我挑一杯 IPA,不要太苦 | 首推柚子大米拉格，称“符合你要的拉格/皮尔森”；LA Love 重复显示；部分酒厂 OCR 错误 | 失败：本轮风格要求未落实、候选重复 |
| `can-monkish-la-love.png` | 这瓶是什么酒? | HTTP 200，约 9.7 秒；路由到 beer_knowledge，回复“我没看到你手上的那瓶酒具体是什么样子的”，要求再发照片 | 失败：已有图片被忽略，未识别清晰可见的 Monkish / LA LOVE |
| `marketing-lunch-dinner.png` | Lunch 和 Dinner 哪个适合我?我不爱苦 | HTTP 200，约 58.5 秒；候选只有“西海岸IPA”和“双倍IPA”，丢掉 Lunch、Dinner 酒名；有偏苦提醒 | 失败：无法对应用户问的两款酒，输出把一款重复列为第 1、第 2 项 |

营销卡中的评分和宣传不能自动当作独立核验事实；本次仅核对图片可见信息是否正确保留、答案是否回应提问。罐图没有可清楚核对的生产日期，本次不把日期推测作为正确答案。

## 酒单 fixture 与真实推荐缺陷

`tests/fixtures/tap-list.jpg` 和 `测试图片.jpg` 的 SHA-256 相同，均为 `e9f24bb22950b20bdcc621a3dcd4fdf5c9461da7a94808941ef061bf78649bc6`，因此是 1 张独立图片，不是 2 个视觉覆盖场景。

在两个实际 API 返回中，人工核对的 17 个完整可见酒单编号和 ABV 均识别出来；空白 5 号、底部被截断的项目不计入该分母。这不等于所有酒名、酒厂、价格都准确。17 个候选均没有评分，结构化候选均未保留价格字段，evidence 数组均为空。

已复现的关键错误：

1. **预算未约束推荐。** 新 conversationId 提问“预算50元以内，只推荐符合预算的；没有就告诉我没有”，仍推荐酒单标价 85 元的赛博暴龙；图中完整可见酒款最低价为 55 元。
2. **不同会话共用旧酒单。** 11 条新的 golden 文本酒单分别使用新 conversationId，却继续返回 fixture 中的酷酷等旧候选。`app/api/chat/route.ts:240`、`:252` 固定使用 `anon`；`lib/beer-agent/memory/short-term.ts:85` 按用户键保存，忽略会话边界；`lib/skills/recommend/execute.ts:338` 以 IPA、预算等词优先走旧菜单追问。
3. **当前图片提问的要求没有进入评分。** `lib/skills/recommend/execute.ts:80` 读取旧的 currentConstraints；这能解释 El Nido 请求 IPA 却沿用拉格要求的现象。`:353` 的转换还丢失价格等字段并清空证据。
4. **中文别名命中被后续校验否决。** 同一次实际生产查询中，`Cyber Sue` 命中本地评分 3.86，`赛博暴龙` 未命中。`lib/beer-agent/beer-db/pipeline.ts:287` 的别名回退会取到英文结果，但 `:318` 后又用原始中文和英文名称做词边界匹配。修复需要保留已有防止相似酒名误匹配的约束。

原图片 benchmark 的第二条提问“帮我看这张图”把酒单送进酒标路径，返回“是啤酒菜单板，不是酒瓶或酒罐”，候选数为 0，仍被脚本判为 PASS。必须补上图像类别和正确行为的断言，不能继续用该 PASS 当产品验收结果。

## 回归失败的拆分

344 条完整回归保留原断言，合并 5 条首批验证和 3 个 113 条分片，ID 无重复、无遗漏。

- 344 条都有 intent 字面值不匹配。其中 291 条是可以对应的名称差异，例如 `menu_recommend` 与 `recommend`；另外 53 条即使按对应名称比较，路由仍不同。名称对应只用于定位，不改写原通过率。
- 15 条还有其他断言失败：11 条回复“回答这个问题时出错了”，3 条缺少指定酒名，1 条候选不足。它们可能与路由问题重叠，不能相加当作独立用例数。
- `data/regression-cases.json` 与 `public/data/regression-cases.json` 的 344 个 ID 和输入一致，但 85 条期望字段不同。本次采用 CLI 的 data 目录版本；网页显示与 CLI 验收标准尚未统一。
- 60 条 VQA 全部 HTTP 200，但都存在旧/新意图差异；其中 1 条还候选不足、回复过短。data 与 public 的 query、图片和 passCriteria 一致，历史 autoTestResult 不用作本轮证据。

## 缺失覆盖与证据

`tests/e2e/image-qa.json` 的 5 个启用场景中，只有 tap-list 图片存在；`menu-clear.jpg`、`bottle-label.jpg`、`glass-beer.jpg`、`menu-blurry.jpg` 缺失，无法执行这 4 项。Golden 的 g005 也依赖缺失的模糊酒单图。页面里的实际罐图已经另行测试，但不能冒充缺失 fixture 的指定验收。

原始响应、合并回归报告、命令日志、临时测试 harness 和页面截图已保存到本地 PM Hub 的 `projects/beer-lens/test-runs/2026-09-11/`，未把私有记忆和完整日志上传 GitHub。主要证据文件：`regression-full.json`、`vqa-live.json`、`chat.json`、`agent.json`、`golden-assessment.json`、`budget-followup.json`、`can-monkish-la-love.png.json`、`marketing-lunch-dinner.png.json`、`el-nido-ui-text.txt`。

建议先修复匿名用户/会话边界和本轮约束传递，再修图片路由与酒名匹配；同步补齐缺失图片、统一用例期望，然后按相同输入重跑。当前结论是“测试执行完成并定位失败”，不是“项目已修好”。
