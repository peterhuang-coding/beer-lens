# El Nido 2026-11-21 菜单覆盖与待补数据

## 证据层

- 图片：用户 2026-11-21 提供的 El Nido 菜单照片。
- 方法：按图上文字手工转成 OCR 字段，调用当前生产 `runLocalMenuKnowledge`（当前 HEAD `42505fb`）做**零模型/零网络**字段重放；`queueKnowledgeGaps:false`，不写补采队列。
- 原图未存入仓库、未外发：图右上角有 Wi‑Fi 密码卡片；要送视觉模型或归档，先裁掉该卡片。
- 证据：`coverage.json`、`field-replay.mts`。

## 覆盖结果

**18 款啤酒**（另有 4 个非啤酒/非标准项）：

| 类别 | 数量 | 款 |
| --- | ---: | --- |
| 当前来源可直接确认 | **8** | #1 本杰明六月 / #2 发枝儿 / #8 膨胀恐惧症 / #9 天鹅狂爱症 / #12 迷你恐惧症 / #15 无序海上将军 / #17 烈日下的粉碎机 / #18 印记 |
| 已知但身份未决 | **2** | #7 崩#0037 / Demolition#0037；#11 未来学家 / Futurist |
| 有来源但版本/名称门未过 | **2** | #13 果味满满46号 / Just Fruit（两水果 vs 三水果候选）；#19 一零六号原型机 / Proto 106（加料版本 vs 基础款） |
| 当前无记录 | **6** | #3 Wills pils / #4 Polotmavé Pivo / #5 IPA De Quartier / #6 Haze War / #10 A Dark in the Light / #16 Ghost Berry Blast |
| 非啤酒/非标准 | **4** | #14 TLC 西打、#20 山楂气泡水、#21 热红酒、侧卡荔枝啤酒冰沙 |

- 8 款确认款都有来源 URL + 评分快照；其中 4 款有结构化酒花（#2、#8、#9、#12）。
- 本地 50k SQLite 只命中 **branching out** 一款；上述确认主要来自 `data/menus/elnido-2026-11.json` 菜单来源档案，不是 50k 库。
- 原图清晰可读；#5 在图中不可见/被遮挡，回复应继续标图像边界。

## 与旧 El Nido snapshot 的差异

- 旧 `data/menus/elnido-2026-11.json` 有 **16 条来源**，但其中 **6 款不在这张图上**：King Lear、Forward Motion、Wildflower、Daze、Champs of My Rye、Squirrel Friends。
- 编号已移位：旧 #6 Expansionphobia 在这张图是 **#8**；旧 #10 Futurist 在这张图是 **#11**；旧 #3/#4/#5/#8/#11/#16 与这张图不是同一款。
- 因此**不能按编号套旧 snapshot**；必须按「酒名 + 酒厂 + 版本」对齐。旧 snapshot 不是这张图的超集。

## 需要重新拉的数据（按优先级）

### P0：直接决定这张图能不能逐款回答

1. **6 款无记录**：Wills pils、Polotmavé Pivo、IPA De Quartier、Haze War、A Dark in the Light、Ghost Berry Blast。
   - 需要：Untappd/酒厂页的身份、酒厂、风格、ABV、评分 + 人数、URL、核对日期；页面明确写时再收酒花/配料。
2. **2 款身份未决**：Demolition#0037、Futurist。
   - 需要：能同时确认酒名 + 酒厂 + 版本的页面或罐标；Futurist 必须排除已知 Siren 4.8% 款，不能再用错配。
3. **2 款版本门**：Just Fruit 两水果 vs 三水果；Proto 106 加料版本 vs 基础款。
   - 需要：版本/批次依据；没有依据就保持未决，不套用另一版本的评分或感官。
4. **这张图自己的菜单 snapshot**：22 行（18 啤酒 + 4 非啤酒），记录观察日期、价格、容量、ABV、图像 hash；不要覆盖旧 `elnido-2026-11.json`。存图先裁 Wi‑Fi 卡片。

### P1：让追问从“风格级”变成“款级”

5. **IBU**：当前 Q2“我怕苦”只能说菜单没有 IBU、按风格判断；要真正排序低苦，需要逐款 IBU（页面有才收，没有继续标未知）。
6. **酒花/配料**：Q3“哪款酒花最香”目前是风格通性；18 款里只有 4 款有结构化酒花，其余需要页面明确写出的品种。
7. **经典/历史来源**：Q4 只有菜单“纯正原产 百年老牌”文字；要把 Gaffel Kölsch 称为经典，需要酒厂官方历史/经典款页面。#10 菜单写“GABF 两年铜奖”，如引用奖项也需奖项来源。

### P2：产品明确要做时才拉

8. **同款同版本同形式产地/市场价**：同币种、同容量/包装、同消费形式、注明日期的报价；没有就继续只做菜单内算术。
9. **本地 50k SQLite 补库**：只有产品要以 50k 库为主时才需要定向导入；否则以菜单来源档案为主，不为单张菜单重爬全库。

## 飞书当前状态（2026-11-21 13:47）

- **长连接已建立**，bot 进程在跑；日志：`~/.claude/jobs/6b669d9a/tmp/feishu-bot.log`。
- 配置：DeepSeek 视觉 + OpenRouter 文本；使用本地 gitignored `.env.local` 里的新 key；不要在仓库写 key。
- 重启命令（不包含凭据）：
  `cd /Volumes/SanDisk2TB/beer-lens-feishu-harness && BEER_VISION_PROVIDER=deepseek BEER_TEXT_PROVIDER=openrouter caffeinate -dimsu node --env-file=/Volumes/SanDisk2TB/beer-lens/.env.local --import tsx scripts/feishu-bot.ts`
- 只使用已授权的 beer taster 私聊；图右上角 Wi‑Fi 密码卡片不要外发。

## 结论

这张图不是“都有”：8/18 可直接确认，2 款身份未决，2 款版本门未过，6 款无记录。优先补 P0 的 8 款和本图 snapshot；IBU/酒花/经典来源属于 P1；市场价与全库补库属于 P2，未获授权不启动。
