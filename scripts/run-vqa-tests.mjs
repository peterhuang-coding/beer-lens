/**
 * run-vqa-tests.mjs — 严格按 passCriteria 运行 VQA 测试。
 * 不改 pass 标准，不编造通过条件。每条测试严格按任务定义的 passCriteria 判断。
 */
import { readFileSync, writeFileSync } from "fs";
import path from "path";

const ROOT = process.cwd();
const TASKS_PATH = path.join(ROOT, "data", "vqa-tasks", "tasks.json");
const AGENT_URL = "http://localhost:3000/api/agent";

function checkPass(task, result) {
  const criteria = task.labels?.passCriteria || {};
  const intent = criteria.intent;
  const reply = result?.reply || "";

  // 意图在 intentResult.intent 里，不在顶层
  const actualIntent = result?.intentResult?.intent || result?.mode || "unknown";
  if (actualIntent !== intent) {
    return { pass: false, reason: `意图不匹配: 期望=${intent}, 实际=${actualIntent}` };
  }

  // 2. 检查候选数
  const minCandidates = criteria.minCandidates || 0;
  const candidates = result?.candidates?.length || 0;
  if (candidates < minCandidates) {
    return { pass: false, reason: `候选数不足: 期望>=${minCandidates}, 实际=${candidates}` };
  }

  // 3. 检查回复长度
  const minLen = criteria.replyMinLen || 0;
  if (reply.length < minLen) {
    return { pass: false, reason: `回复太短: 期望>=${minLen}字, 实际=${reply.length}字` };
  }

  // 4. 检查是否报错
  if (result?.error) {
    return { pass: false, reason: `API返回错误: ${result.error}` };
  }

  return { pass: true, reason: "" };
}

async function main() {
  const tasks = JSON.parse(readFileSync(TASKS_PATH, "utf8"));
  let pass = 0, fail = 0;
  const results = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const criteria = task.labels?.passCriteria || {};
    process.stdout.write(`  [${i + 1}/${tasks.length}] ${task.id.slice(0, 35)}... `);

    try {
      let messages;
      try {
        messages = typeof task.query === "string" ? JSON.parse(task.query) : task.query || [{ role: "user", content: "推荐啤酒" }];
        if (!Array.isArray(messages)) messages = [{ role: "user", content: "推荐啤酒" }];
      } catch {
        messages = [{ role: "user", content: "推荐啤酒" }];
      }

      const body = { userId: "vqa-auto-test", conversationId: task.id, messages };

      const agentResp = await fetch(AGENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await agentResp.json();

      const verdict = checkPass(task, result);

      task.labels = task.labels || {};
      task.labels.autoTestResult = {
        pass: verdict.pass,
        intent: result?.intentResult?.intent || result?.mode || "unknown",
        candidates: result?.candidates?.length ?? 0,
        candidateNames: (result?.candidates || []).map((c) => c.displayName || c.name || "").filter(Boolean),
        replyPreview: (result?.reply || "").slice(0, 200),
        testedAt: new Date().toISOString(),
        error: verdict.reason || null,
        passCriteria: criteria,
      };

      if (verdict.pass) {
        pass++;
        process.stdout.write("✅\n");
      } else {
        fail++;
        process.stdout.write(`❌ ${verdict.reason}\n`);
      }
      results.push({ id: task.id, pass: verdict.pass, reason: verdict.reason, intent: criteria.intent });
    } catch (err) {
      fail++;
      task.labels = task.labels || {};
      task.labels.autoTestResult = {
        pass: false,
        candidates: 0,
        testedAt: new Date().toISOString(),
        error: `请求异常: ${err.message}`,
        passCriteria: criteria,
      };
      process.stdout.write(`❌ ${err.message.slice(0, 60)}\n`);
      results.push({ id: task.id, pass: false, reason: err.message });
    }
  }

  writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2) + "\n");

  console.log("\n" + "=".repeat(50));
  console.log(`结果: ${pass}/${tasks.length} 通过`);
  console.log("=".repeat(50));
  for (const r of results) {
    const icon = r.pass ? "✅" : "❌";
    console.log(`  ${icon} ${r.id} (${r.intent}) ${r.pass ? "" : "— " + r.reason}`);
  }
  console.log("=".repeat(50));
}

main().catch(console.error);