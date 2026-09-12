# 测试集、结果与已知缺口

## 实测快照

日期：**2026-09-12**。被测代码：[2665a60](https://github.com/peterhuang-coding/beer-lens/commit/2665a60993f1f7316fcc899c0f1335bd9644dafa)。以下是该次生产构建上的历史测试结果；README 更新没有修复这些问题，也没有重新运行真实模型测试。

| 检查 | 结果 | 覆盖范围与限制 |
| :--- | :--- | :--- |
| 代码测试 | 548 / 548，64 suites，0 失败／跳过 | 包含结构和 schema 检查，不等同于业务全部正确 |
| 类型与生产构建 | 均通过 | 验证同一轮代码能够完成类型检查与构建 |
| 真实 `/api/agent` 回归 | 306 / 344；38 失败；0 请求异常 | 保留原断言；344 个 ID 无重无漏 |
| 现有 VQA 任务 | 59 / 60 | 全部无图片，不能作为视觉准确率 |
| 双 API 图片检查 | 11 / 14 | 4 张独立原图；两个 tap fixture 内容相同 |
| Golden 文字请求 | 11 条均返回 HTTP 200 和菜单 | 未验证全部预期业务行为；g005 缺图未执行 |
| 隔离模块复现 | 8 类缺陷、9 个观察点复现 | 是缺陷证据，不是 9 项产品验收通过 |

图片全量失败包括：两个 API 将 El Nido 图中的 Monkish 读成 `Morshik`，以及一次 `/api/agent` 营销卡视觉服务失败。营销卡定向重试恢复，原完整结果仍为 **11 / 14**。

同一罐图的 ABV 在两个 API 中分别为 8.5% 和 8.1%，却都通过现有检查，原因是断言没有核验 ABV。这说明必须补充字段参考答案，不能把两个 PASS 当作字段正确或一致。

## 已有测试数据

| 入口 | 内容 |
| :--- | :--- |
| [`data/regression-cases.json`](../data/regression-cases.json) | CLI 文本回归用例与原有期望 |
| [`data/vqa-tasks/tasks.json`](../data/vqa-tasks/tasks.json) | 现有 60 条 VQA 命名任务，实际为文字输入 |
| [`scripts/run-image-benchmark.mjs`](../scripts/run-image-benchmark.mjs) | 双 API 图片检查、样本引用与断言 |
| [`public/test-assets/`](../public/test-assets/) | 酒单、酒罐、营销卡片原图 |
| [`tests/fixtures/`](../tests/fixtures/) | tap list 等 fixture |
| [`tests/golden/menu-golden-set.json`](../tests/golden/menu-golden-set.json) | Golden 场景与预期定义 |
| [`docs/test-report-2026-09-11-fixes.md`](test-report-2026-09-11-fixes.md) | 前一轮修复验证记录，需与本次快照区分 |

已发现 `data/regression-cases.json` 与网页使用的 `public/data/regression-cases.json` 有 85 条记录不一致。CLI 与网页测试目前不是同一套验收标准，不能直接比较通过数。4 个旧图片样本缺失，Golden 的 g005 也依赖缺失图片；不能算作已覆盖。

## 为什么通过的案例也需要检查

对本次完整响应做核对后发现：

- 95 条通过的推荐中，52 条把完整用户请求放在第一款酒名的位置。
- 56 条通过的品饮反馈都回复“已记录未知啤酒”。这是回复统计，不据此推断每条都实际落库。
- 18 条通过的纠错中，17 条仅通用澄清；其中 6 条明确的清空、删除或重置请求未完成。

例如 `reg_300` 要求浑浊 IPA，首选却是 West Coast IPA；`reg_301` 的候选包含整句“求推荐西海岸 IPA”。原断言对路由和候选数量的检查不足以发现这些错误。

模块级隔离复现还发现以下问题，尚待修复：

| 问题 | 下一次验收应检查什么 |
| :--- | :--- |
| “不喜欢 IPA”被写成喜欢；“不苦”增加喜欢苦的权重 | 实际画像变化与否定含义一致 |
| “另一款”被绑定到首选；酒单第 7 号被当数组位置 | 明确对象才写入，印刷编号对应正确候选 |
| 禁止记忆写入后，纠错仍保存 | 写入开关覆盖所有入口，持久化状态与回复一致 |
| Skill 禁用返回成功，运行注册表仍启用 | 实际调用遵守开关，而非只检查 API 返回 |
| Case 错误标签被当作已标注答案，可导出空 `expected` | 错误分类和参考答案分开验收 |
| 同 ID YAML 规则重载后仍保留旧定义 | 运行中的规则内容与新版本一致 |

## 复现方式

安装与模型配置见 [开发文档](development.md)。先执行代码检查与生产构建：

```bash
npm run check
npm run start -- --hostname 127.0.0.1 --port 3000
```

保持服务运行，在另一个终端执行：

```bash
npm run test:agent -- --write-badcases false
npm run benchmark:images
```

这两条命令会调用已配置的真实模型；图片脚本会运行其当前定义的断言。避免同时运行开发服务和构建操作争用同一个 `.next` 目录。这里只重现测试入口，不承诺模型输出与历史快照完全相同。

后续评测应同时记录原断言结果与实际任务结果，重点补齐实体、字段、约束、反馈归因及状态变化。修正旧期望需要独立参考答案，不能照抄当前输出来提高通过率。
