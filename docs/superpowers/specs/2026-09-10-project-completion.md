# Beer Lens 项目收尾设计

目标：完成现有草稿 PR #2 的已设计功能，消除新检出无法运行的问题，补齐 README 明确承诺但缺失的 Cases 面板，并提供可重复的测试和 GitHub 交付。

## 已核实基线
main e5923a2；419 tests passing；typecheck/build passing。LLM 集成方案与推荐模块已实现；README 的记忆纠正占位描述已过期。旧 PR #2 冲突且依赖忽略的本机 Python/SQLite 文件。旧 worktree 的 828 个文件被意外跟踪。

## 实施选择
采用当前 main 上定向迁移旧 PR。完整合并旧 PR 会带回旧依赖、数据库和陈旧报告；重新建产品会扩大范围。保留现有 Web/飞书/CLI 与活跃对话管线。

## 功能
1. 恢复 agent、crawl:round、inspector、hub:serve 命令。项目 skill 使用标准目录，说明当前真实可用入口。
2. 采集清单按 gaps/user/seeds 优先级合并；修复中文括号酒厂别名重复；参数严格验证；--print 只输出 JSON；无私有数据库也可使用种子数据。生成目标不等于实际完成爬取。
3. 巡检报告反映当前代码和数据，不把扫描测试源码当作通过测试，不把未验证种子称为 verified。
4. Hub 的健康、统计、日志、接口、功能和快照读取采用可移植项目文件；可选数据缺失显示空态；所有动态文本安全呈现。仅默认监听 loopback。
5. Debug Cases 面板查询、筛选、查看详情和修改状态/标签，复用现有授权及 API。
6. 移除 Git 跟踪的本机工作副本与系统文件，补齐忽略规则、README 与 CI。原工作目录保留已有未提交改动。

## 验证
新增实际子进程 CLI、fixture 数据、HTTP 路由及 Cases API 回归；全套 npm test、typecheck、production build；浏览器检查 Hub/Cases 空态及交互；全新检出不要求本机 .beer-data；最终代码审查后提交分支并发布 PR。

## 边界
独立 npm 商业发布、Docker 托管、商业模式与许可证选择是原评估中的未批准新产品路线；本次不自动进行。外部 LLM 和站点真实质量单独记录可验证程度。
