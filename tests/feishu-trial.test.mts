import { test } from "node:test";
import assert from "node:assert/strict";
import { FeishuMessageQueue } from "../lib/feishu/queue.ts";
import { checkFeishuTrialConfig, getTrialMessage, type FeishuSocketEvent } from "../lib/feishu/trial.ts";
import { shouldSkipFeishuEvent } from "../lib/feishu/client.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

function event(overrides: Partial<FeishuSocketEvent> = {}): FeishuSocketEvent {
  return {
    sender: { sender_type: "user", sender_id: { open_id: "test-user" } },
    message: { message_id: "test-message", chat_id: "test-chat", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "  什么是NEIPA？  " }) },
    ...overrides,
  };
}

test("同一聊天的追问等待上一轮完成，避免读取过期记忆", async () => {
  const queue = new FeishuMessageQueue();
  const seen: string[] = [];
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const first = queue.enqueue("chat-a", async () => { seen.push("first-start"); await gate; seen.push("first-done"); });
  const second = queue.enqueue("chat-a", async () => { seen.push("second"); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ["first-start"]);
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(seen, ["first-start", "first-done", "second"]);
});

test("一个聊天等待模型时不会阻塞其他聊天", async () => {
  const queue = new FeishuMessageQueue();
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const first = queue.enqueue("chat-a", () => gate);
  let otherFinished = false;
  await queue.enqueue("chat-b", async () => { otherFinished = true; });
  assert.equal(otherFinished, true);
  finish();
  await first;
  await queue.drain();
});

test("前一条消息处理失败不阻断同一聊天后续消息", async () => {
  const queue = new FeishuMessageQueue();
  const failure = queue.enqueue("chat-a", async () => { throw new Error("synthetic failure"); });
  const rejected = assert.rejects(failure, /synthetic failure/);
  let recovered = false;
  const next = queue.enqueue("chat-a", async () => { recovered = true; });
  await queue.drain();
  await Promise.all([rejected, next]);
  assert.equal(recovered, true);
});

test("配置检查只返回缺失字段，不回显凭据", () => {
  const result = checkFeishuTrialConfig({ FEISHU_APP_SECRET: "synthetic-test-only-secret" });
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, ["FEISHU_APP_ID", "OPENROUTER_API_KEY"]);
  assert.equal(JSON.stringify(result).includes("synthetic-test-only-secret"), false);
  assert.equal(checkFeishuTrialConfig({ FEISHU_APP_ID: "cli_xxx", FEISHU_APP_SECRET: "<REDACTED>", OPENROUTER_API_KEY: "replace_with_your_key" }).missing.length, 3);
});

test("接收私聊文字并保留聊天和消息身份", () => {
  const message = getTrialMessage(event());
  assert.equal(message?.text, "什么是NEIPA？");
  assert.equal(message?.chatId, "test-chat");
  assert.equal(message?.messageId, "test-message");
});

test("忽略群聊、机器人消息、无身份及未授权试用用户", () => {
  const original = event();
  assert.equal(getTrialMessage(event({ message: { ...original.message!, chat_type: "group" } })), null);
  assert.equal(getTrialMessage(event({ sender: { sender_type: "app" } })), null);
  assert.equal(getTrialMessage(event({ message: { ...original.message!, chat_id: "" } })), null);
  assert.equal(getTrialMessage(original, ["another-test-user"]), null);
  assert.ok(getTrialMessage(original, ["test-user"]));
});

test("图片和图文消息保留资源键及文字，非法内容被忽略", () => {
  const message = event().message!;
  const image = getTrialMessage(event({ message: { ...message, message_type: "image", content: JSON.stringify({ image_key: "test-image" }) } }));
  assert.equal(image?.imageKey, "test-image");
  const post = getTrialMessage(event({ message: { ...message, message_type: "post", content: JSON.stringify({ content: [[{ tag: "text", text: "预算60元" }, { tag: "img", image_key: "test-menu" }]] }) } }));
  assert.equal(post?.text, "预算60元");
  assert.equal(post?.imageKey, "test-menu");
  assert.equal(getTrialMessage(event({ message: { ...message, content: "invalid-json" } })), null);
});

test("飞书重投同一事件不会重复进入队列", () => {
  const payload = { event_id: "feishu-trial-unit-duplicate-event" };
  assert.equal(shouldSkipFeishuEvent(payload), false);
  assert.equal(shouldSkipFeishuEvent(payload), true);
});

test("重置命令清除本会话菜单与历史，保留长期口味及其他会话", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "beer-feishu-reset-"));
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const moduleUrl = (name: string) => pathToFileURL(path.join(repo, name)).href;
  const source = `
    import assert from 'node:assert/strict';
    import { mkdir, writeFile, readFile } from 'node:fs/promises';
    import { createHash } from 'node:crypto';
    const id='test-reset-chat';
    const key='session_'+createHash('sha256').update(JSON.stringify([id,id])).digest('hex');
    await mkdir('data/memory/short-term',{recursive:true});
    await mkdir('data/memory/users/test-reset-chat',{recursive:true});
    await writeFile('data/memory/users/test-reset-chat/profile.json','{"keep":true}');
    await writeFile('data/memory/short-term/'+key+'.json',JSON.stringify({userId:id,conversationId:id,recentTurns:[],lastMenu:{candidates:[{candidateId:'old-beer'}]},currentConstraints:['旧预算']}));
    await writeFile('data/feishu_conversations.json',JSON.stringify({version:1,conversations:{[id]:{chatId:id,messages:[{role:'user',content:'旧菜单'}]},other:{chatId:'other',messages:[{role:'user',content:'其他会话'}]}}}));
    const sent=[];
    globalThis.fetch=async(url,init)=>{
      if(String(url).endsWith('/auth/v3/tenant_access_token/internal')) return Response.json({code:0,tenant_access_token:'synthetic-token',expire:7200});
      if(String(url).endsWith('/im/v1/messages/test-reset-message/reply')) {sent.push(JSON.parse(init.body));return Response.json({code:0});}
      throw new Error('禁止未预期的网络访问');
    };
    const {enqueueFeishuMessage}=await import(${JSON.stringify(moduleUrl("lib/feishu/handler.ts"))});
    const {readShortTermMemory}=await import(${JSON.stringify(moduleUrl("lib/beer-agent/memory/short-term.ts"))});
    await enqueueFeishuMessage({text:'/reset',imageKey:'',fileKey:'',messageId:'test-reset-message',chatId:id,messageType:'text'});
    assert.equal(await readShortTermMemory(id,id),null);
    const conversations=JSON.parse(await readFile('data/feishu_conversations.json','utf8'));
    assert.equal(conversations.conversations[id],undefined);
    assert.equal(conversations.conversations.other.messages[0].content,'其他会话');
    assert.equal(await readFile('data/memory/users/test-reset-chat/profile.json','utf8'),'{'+'"keep":true}');
    assert.equal(sent.length,1);
    assert.match(JSON.parse(sent[0].content).text,/长期口味记录保留/);
    const {replyFeishuMessage}=await import(${JSON.stringify(moduleUrl("lib/feishu/client.ts"))});
    globalThis.fetch=async()=>Response.json({code:12345,msg:'synthetic provider failure'});
    await assert.rejects(replyFeishuMessage('test-reset-message','test'),/code 12345/);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", source], {
      cwd: directory, encoding: "utf8", timeout: 20_000,
      env: { NODE_OPTIONS: "--max-old-space-size=1024", GOMAXPROCS: "1", UV_THREADPOOL_SIZE: "1", TSX_TSCONFIG_PATH: path.join(repo, "tsconfig.json"), FEISHU_APP_ID: "synthetic-app", FEISHU_APP_SECRET: "synthetic-secret" },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
