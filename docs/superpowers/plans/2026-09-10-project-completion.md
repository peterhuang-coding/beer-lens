# Project completion implementation plan

> Execute in the approved isolated worktree using subagent-driven-development and test-driven-development. Scope approved 2026-09-10.

**Goal:** Deliver the unfinished agent/crawler/Hub/inspector surface and Cases panel with reproducible validation.
**Architecture:** Keep current main application; migrate useful PR #2 scripts with a shared portable JSON data adapter. Optional legacy SQLite does not block a fresh clone. Reuse existing Next Cases endpoints.
**Tech Stack:** Node ES modules, Next/React/TypeScript, node:test, Playwright.

- [x] Restore PR target helpers; add regression asserting Chinese brewery alias deduplication and unknown-country behavior. Run `node --test tests/always-on-crawler.test.mts` and observe failure before fixes.
- [x] Add process tests for JSON-only output, zero/invalid limits, no private DB, inspector measured status, agent check and rejected flags. Implement shared project-data reader and strict parsing in scripts; rerun process tests.
- [x] Adapt Hub routes to portable JSON data and semantic missing/error states. Add HTTP tests covering query strings, static files, methods, snapshots and unsafe path rejection. Escape dynamic dashboard strings; verify browser rendering.
- [x] Add Cases panel using GET filters, GET detail and PATCH review. Add mutation validation tests before fixes. Verify UI loading, empty, error and review/save behavior.
- [x] Update project skill to standard SKILL.md path, commands/docs and source honesty. Install shared project Skills for Claude Code through existing skill locations, preserving existing installations.
- [x] Remove tracked historical working copies and system files from new revision. Ignore new runtime outputs. Add CI running `npm ci`, `npm test`, `npm run typecheck`, `npm run build`; reconcile dependency audit findings with compatible fixes.
- [ ] Run full tests/build/typecheck and HTTP/browser smoke checks. Review changes against approved design and code quality. Commit and push `codex/finish-project`, publish PR that supersedes old PR #2, and record remaining external service limitations.

## 实测追加修复

- [x] Python 3.9 可加载数据库查询脚本（延迟类型注解）；无库启动回归通过。
- [x] SQLite 酒名查询保留用户所有词，避免截短误匹配；verified 读取真实值。
- [x] 接通旧 CLI 的真实爬取分支，fixture 验证输出、续跑、限制与错误。
- [x] 技能失败透传至 SSE 与失败指标；不再把错误回复计为成功。
