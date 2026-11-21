# 语义守卫二次修复 · 2026-11-18

每日独立验收（`test-runs/2026-11-16-daily-review/`）对 `7ba7223` 的守卫给出 **1 PASS / 3 FAIL**。本轮把守卫从“只加核对前缀”改为“移除/重写被证伪句 + 实体/属性绑定 + 币种分组”。

## 父级探针结果

`parent-guard-probes.mjs` 对当前 `lib/skills/beer-knowledge/evidence-guards.ts` 重跑：

| 探针 | 旧结果 | 新结果 |
|---|---|---|
| 正确算术前缀 | PASS | PASS |
| 错误最低价断言不得原样保留 | FAIL | **PASS** |
| 其他行 classic 不得为 #7 旗舰背书 | FAIL | **PASS** |
| 20 CNY 不得与 10 USD 硬算最低 | FAIL | **PASS** |

4/4 PASS，零真实模型/网络请求。证据：`parent-guard-probes-after-fix.json`。

11/18 每日复审又给出 `parent-extended-probes.mjs` 4/4 FAIL；修复后同样 **4/4 PASS**：

| 扩展探针 | 旧结果 | 新结果 |
|---|---|---|
| 提到正确最低款不能放行错误比较句 | FAIL | **PASS** |
| 单位价最低不能授权总价最低 | FAIL | **PASS** |
| classic 自述不能证明百年历史 | FAIL | **PASS** |
| 未决版本不能输出 supplement curated 评分 | FAIL | **PASS** |

证据：`parent-extended-probes-after-fix.json`。两组合计 **8/8 PASS**。

## 修复方式

1. **错误最低价句不再保留**：含“最低/最便宜/性价比最高”且不是实际最低款的句子直接从可见回复移除；正确指向实际最低款的句子保留。前缀给出确定性的单位价/总价最低款。
2. **来源绑定实体 + 属性**：只统计句中提到的 `#行号/酒名/酒厂` 的 reputation；`旗舰` 需要 `flagship` 来源，`经典` 需要 `classic`，`最畅销` 需要文本明确，`获奖` 需要 `award`。其他行的 classic 自述不能为 #7 的旗舰背书；无来源的历史/旗舰句移除。
3. **币种分组**：显式 ISO 币种或 OCR 可见符号才参与算术；多种币种时不做跨币种最低价，输出“币种边界”，USD 不会被写成元。
4. **预算句**：`maxPrice` 内被说成“超预算”的句子移除，并列出预算内款。

## 回归

- `tests/knowledge-evidence-guards.test.mts`：11/11，覆盖错误句移除、正确句保留、跨实体旗舰、style 通识不误杀、预算、跨币种、普通回复不变。
- `npm run check`：**1115/1115 Node、38/38 Python、typecheck、build** 通过。
- 该修复不调用模型；真实多轮的下一次运行会使用新守卫，但本轮没有追加真实调用。

## 边界

模型仍可能产生守卫未覆盖的新说法；最终回复仍需人工复核。守卫只处理可确定性判定/证伪的四类：最低价、预算、来源绑定、币种。
