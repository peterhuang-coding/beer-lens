<div align="center">

<h1>🍺 Beer Lens</h1>
<h3>把酒单看懂，把这一杯选明白。</h3>
<p>面向真实点单场景的多模态精酿决策工作台。<br>连接酒单图片、自主整合的领域数据与个人口味，逐步沉淀可验证的推荐经验。</p>
<p><a href="https://github.com/peterhuang-coding/beer-lens/actions/workflows/ci.yml"><img src="https://github.com/peterhuang-coding/beer-lens/actions/workflows/ci.yml/badge.svg" alt="CI"></a> <img src="https://img.shields.io/badge/stage-experimental-d97706" alt="Stage: Experimental"> <img src="https://img.shields.io/badge/Next.js-16-18181b?logo=nextdotjs" alt="Next.js 16"> <img src="https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&amp;logoColor=white" alt="TypeScript"></p>
<p><a href="#真实输入">真实输入</a> · <a href="#项目特色">项目特色</a> · <a href="#数据资产">数据资产</a> · <a href="#快速开始">快速开始</a> · <a href="#测试与进展">测试与进展</a> · <a href="docs/development.md">开发文档</a></p>

</div>

---

> “这张酒单里，预算 80 元、不想太苦，今晚先点哪一杯？”

Beer Lens 围绕这样的问题工作：从图片中识别酒款，结合可查证的资料、当次约束和口味记录，给出有依据的选择。我们希望长期积累两类资产：**可核对的领域数据**，以及**经过真实案例验证的处理方法**。

| 从输入到选择 | 当前能力 |
| :--- | :--- |
| 📷 看懂现场 | 接收酒单、酒标图片，提取酒名、酒厂、风格与可见字段 |
| 🔎 核对酒款 | 查询本地酒库与评分缓存，结合名称、酒厂和版本线索核验匹配 |
| 🍻 帮助点单 | 结合预算、风格与口味约束组织推荐，支持围绕已有酒单继续追问 |
| 📝 记录体验 | 已有品饮反馈、口味画像与记忆纠正模块；反馈归因仍需完善 |
| 🧪 查看证据 | 提供调用轨迹、规则、Cases 审阅界面和文本／图片测试脚本 |

**当前为实验版本。** OCR、候选解析和反馈写入仍有已知缺陷；从反馈到 Skill 改进、评测和发布的完整闭环在规划中。具体边界见 [测试说明](docs/testing.md)。

## 真实输入

下面是仓库中实际使用的测试图片，可直接用于本地体验。它们是输入样本，不代表识别结果已经全部正确。

**酒单 · El Nido**

[![El Nido 酒单测试原图](public/test-assets/menu-el-nido.png)](public/test-assets/menu-el-nido.png)

<details>
<summary><strong>展开更多场景：单罐酒标与营销卡片</strong></summary>
<br>
<table>
<tr>
<td align="center" width="50%"><img src="public/test-assets/can-monkish-la-love.png" width="260" alt="Monkish LA LOVE 酒罐测试原图"></td>
<td align="center" width="50%"><img src="public/test-assets/marketing-lunch-dinner.png" width="260" alt="午餐与晚餐营销卡片测试原图"></td>
</tr>
<tr>
<td align="center"><strong>单罐酒标</strong><br>辨认酒款，核对风格和酒精度。</td>
<td align="center"><strong>营销卡片</strong><br>区分酒款信息与宣传文案。</td>
</tr>
</table>
</details>

## 项目特色

**中文精酿语境。** 关注中文名、英文名、别名，以及容易混淆的酒厂和版本信息，让资料能够对应到眼前这一款酒。

**真实点单约束。** 把预算、口味和当前菜单纳入推荐；追问时保留菜单上下文，逐步缩小选择范围。

**可以检查的过程。** 将识别、查库、推荐和记忆操作放进可观察的执行流程，用案例暴露问题，并用实际结果检验改动。

**数据与经验共同积累。** 自主整合领域资料，同时建设“反馈 → 复核 → 方法候选 → 对照评测 → 人工发布”的改进流程。数据层已有基础，经验闭环仍在建设。

同类产品也在布局拍照选酒与口味匹配，例如开发中的 [Barley Lens](https://brewlytics.ai/lens)；[Dify](https://github.com/langgenius/dify) 和 [RAGFlow](https://github.com/infiniflow/ragflow) 则提供通用 AI 应用或知识检索能力。Beer Lens 的定位是深耕精酿点单场景，把领域数据、执行过程与体验反馈结合起来。详见 [同类项目与定位](docs/positioning.md)，这里不作未经实测的效果排名。

## 数据资产

**我们自主整合并持续维护面向精酿场景的领域数据资产。**

围绕真实点单需求，我们将多来源酒款资料、中文名称映射、酒厂与版本线索、评分记录和菜单识别证据，组织为可查询、可核对的数据层。**整合结构、匹配规则、质量检查和真实案例**，是项目持续积累的工作。

| 资产 | 用途 |
| :--- | :--- |
| 酒款资料与评分缓存 | 补充风格、酒厂和评分等背景信息 |
| 名称映射与实体匹配规则 | 连接中英文名称，减少同名、近似名和版本混淆 |
| 酒单与酒标样本 | 验证现场识别、字段提取与推荐链路 |
| 测试用例与问题案例 | 把失败转成可复现的改进任务 |

自主整合描述的是我们的整理、组织与维护工作；原始来源与证据仍保留在数据说明中。门店价格增量接入、持久化缺口队列和自动补采回写属于下一阶段，见 [数据资产说明](docs/data-assets.md)。

## 快速开始

需要 **Node.js 22.19+**、npm 和 **Python 3.9+**（SQLite 查询使用）。

```bash
git clone https://github.com/peterhuang-coding/beer-lens.git
cd beer-lens
npm ci
cp .env.example .env.local
```

在 `.env.local` 填写 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，用于聊天路由。知识与视觉 Skill 的现有调用还需要 `OPENROUTER_API_KEY`；视觉模型需支持图片输入。各入口的配置关系见 [模型配置](docs/development.md#模型配置)。

```bash
npm run dev
```

打开 [localhost:3000/chat](http://localhost:3000/chat)，上传上面的测试图，或输入一个精酿问题。

| 页面 | 用途 |
| :--- | :--- |
| `/chat` | 流式对话入口 |
| `/beers` | 浏览酒库 |
| `/debug` | 查看调用、规则与 Cases |
| `/harness` | 查看 Skill 管理界面 |
| `/test-runner` | 查看并运行网页测试任务 |

## 测试与进展

以下为 **2026-09-12、代码 `2665a60` 的实测快照**，不是本次文档更新重新运行的模型测试。

| 测试层 | 结果 | 解释 |
| :--- | :--- | :--- |
| 代码测试 | 548 / 548 通过 | 同轮类型检查与生产构建通过 |
| 真实 API 文本回归 | 306 / 344 通过 | 按原有自动断言计数；存在通过但回答不正确的案例 |
| 现有 VQA 任务 | 59 / 60 通过 | 这组全部为文字输入，不能代表视觉准确率 |
| 双 API 图片检查 | 11 / 14 通过 | 覆盖 4 张独立原图，样本量有限 |

已发现的问题包括酒厂名 OCR 误读、把整句请求当酒名、否定偏好解析和反馈对象绑定错误。**自动检查通过数不等于产品准确率。** 可查看 [测试集入口、结果解读与已知缺口](docs/testing.md)。

```bash
npm run check                                      # 代码测试、类型检查、生产构建
npm run test:agent -- --write-badcases false         # 对运行中的服务做真实 API 回归
npm run benchmark:images                           # 对运行中的服务做图片检查
```

后两项需要已配置模型的服务，会产生真实模型调用；运行方式见 [测试说明](docs/testing.md#复现方式)。

### 接下来要完成

- [ ] 修复候选解析、否定偏好和反馈归因，并验收实际记忆变化。
- [ ] 统一执行记录、Cases 与参考答案，补足字段级图片评测。
- [ ] 接入新增数据，建立有界补采、去重与质量缺口回写流程。
- [ ] 建立 Skill 新旧版本对照、独立样本验证和人工发布／回退流程。

## 开发文档

[开发与架构](docs/development.md) · [数据资产](docs/data-assets.md) · [测试与已知问题](docs/testing.md) · [同类项目与定位](docs/positioning.md) · [数据升级设计](docs/superpowers/specs/2026-09-11-data-upgrade-crawler-design.md)

欢迎通过 [Issues](https://github.com/peterhuang-coding/beer-lens/issues) 提供可复现的问题：输入样本、预期结果、实际结果和运行版本，能直接帮助我们改进下一次点单体验。分享前请去除个人信息与密钥。
