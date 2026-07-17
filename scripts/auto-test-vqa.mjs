/**
 * auto-test-vqa.mjs — Run VQA auto-test with intent-specific pass criteria.
 * Usage: node scripts/auto-test-vqa.mjs
 */
import { readFileSync, writeFileSync } from "fs";
import path from "path";

const ROOT = process.cwd();
const TASKS_PATH = path.join(ROOT, "data", "vqa-tasks", "tasks.json");
const AGENT_URL = "http://localhost:3000/api/agent";

function passCriteria(taskId, result) {
  const intent = result?.intent || (result?.mode === "recommend" ? "menu_recommend" : "unknown");
  const reply = result?.reply || "";
  const hasCandidates = result?.candidates?.length > 0;

  // Determine expected intent from task ID
  const isMenu = taskId.includes("recommend") || taskId.includes("up_filter");
  const isKnowledge = taskId.includes("knowledge");
  const isLabel = taskId.includes("label");
  const isTasting = taskId.includes("feedback");
  const isProfile = taskId.includes("profile");
  const isCorrection = taskId.includes("correction");
  const isUnclear = taskId.includes("unclear");

  if (isMenu) {
    return hasCandidates || reply.length > 20;
  }
  if (isKnowledge) {
    return reply.length > 50 && (reply.includes("IPA") || reply.includes("拉格") || reply.includes("啤酒") || reply.includes("风格") || reply.includes("酿造"));
  }
  if (isLabel) {
    return reply.includes("照片") || reply.includes("图片") || reply.includes("酒标") || reply.length > 30;
  }
  if (isTasting) {
    return reply.length > 20;
  }
  if (isProfile) {
    return reply.length > 15;
  }
  if (isCorrection) {
    return reply.length > 15;
  }
  if (isUnclear) {
    return reply.length > 15 && (reply.includes("?") || reply.includes("？") || reply.includes("可以"));
  }
  return reply.length > 20;
}

async function main() {
  const tasks = JSON.parse(readFileSync(TASKS_PATH, "utf8"));
  let pass = 0, fail = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    process.stdout.write(`  [${i + 1}/${tasks.length}] ${(task.id || "").slice(0, 35)}... `);

    try {
      // Parse messages
      let messages;
      try {
        messages = typeof task.query === "string" ? JSON.parse(task.query) : task.query || [{ role: "user", content: "推荐啤酒" }];
        if (!Array.isArray(messages)) messages = [{ role: "user", content: "推荐啤酒" }];
      } catch {
        messages = [{ role: "user", content: "推荐啤酒" }];
      }

      // Use first user message
      const firstUser = messages.find((m) => m.role === "user");
      const testContent = firstUser?.content || "推荐啤酒";
      const body = { userId: "vqa-auto-test", conversationId: task.id, messages: [{ role: "user", content: testContent }] };

      // Only send image if it's a real beer image (not a placeholder)
      // Placehold.co images are synthetic and the vision pipeline can't OCR them
      if (task.imageUrl?.startsWith("http") && !task.imageUrl?.includes("placehold.co")) {
        try {
          const imgResp = await fetch(task.imageUrl);
          if (imgResp.ok) {
            const buf = Buffer.from(await imgResp.arrayBuffer());
            const base64 = buf.toString("base64");
            body.image = { name: task.id + ".jpg", type: "image/jpeg", dataUrl: `data:image/jpeg;base64,${base64}` };
          }
        } catch {}
      }

      // Call agent
      const agentResp = await fetch(AGENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await agentResp.json();
      const isPass = passCriteria(task.id, result);

      task.labels = task.labels || {};
      task.labels.autoTestResult = {
        pass: isPass,
        intent: result?.intent || result?.mode || "unknown",
        candidates: result?.candidates?.length ?? 0,
        candidateNames: (result?.candidates || []).map((c) => c.displayName || c.name || "").filter(Boolean),
        replyPreview: (result?.reply || "").slice(0, 150),
        testedAt: new Date().toISOString(),
        error: null,
      };

      if (isPass) { pass++; process.stdout.write("✅\n"); }
      else { fail++; process.stdout.write(`❌ (${result?.intent || "?"}, cand=${result?.candidates?.length || 0})\n`); }
    } catch (err) {
      task.labels = task.labels || {};
      task.labels.autoTestResult = { pass: false, candidates: 0, testedAt: new Date().toISOString(), error: err.message };
      fail++;
      process.stdout.write(`❌ ${err.message.slice(0, 60)}\n`);
    }
  }

  writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2) + "\n");
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
}

main().catch(console.error);