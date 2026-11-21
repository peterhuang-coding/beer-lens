import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFeishuTrialConfig } from "../lib/feishu/trial.ts";

// 纯合成值，不对应任何真实凭据；测试过程不写盘、不联网。
const APP = {
  FEISHU_APP_ID: "synthetic-app-id-2026",
  FEISHU_APP_SECRET: "synthetic-app-secret-2026",
} as const;

const legacyEnv = () => ({ ...APP, OPENROUTER_API_KEY: "synthetic-openrouter-key-2026" });
const packageEnv = () => ({
  ...APP,
  BEER_VISION_PROVIDER: "coding-plan",
  CODING_PLAN_API_KEY: "synthetic-package-key-2026",
});

test("显式选择 coding-plan 镜像路由时，只需要套餐密钥即可就绪，不要求 OpenRouter", () => {
  const result = checkFeishuTrialConfig(packageEnv());
  assert.equal(result.ready, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.mode, "private-chat");
  assert.equal(result.missing.includes("OPENROUTER_API_KEY"), false);
});

test("选择 coding-plan 但缺少套餐密钥时阻断，即使旧的 OpenRouter 密钥存在", () => {
  const result = checkFeishuTrialConfig({ ...legacyEnv(), BEER_VISION_PROVIDER: "coding-plan" });
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, ["CODING_PLAN_API_KEY"]);
});

test("套餐密钥为占位值时阻断，旧密钥存在也不放行", () => {
  for (const placeholder of ["xxx", "<YOUR_PACKAGE_KEY>", "replace_with_real_key", "your-package-key", "   "]) {
    const result = checkFeishuTrialConfig({
      ...legacyEnv(),
      BEER_VISION_PROVIDER: "coding-plan",
      CODING_PLAN_API_KEY: placeholder,
    });
    assert.equal(result.ready, false, placeholder);
    assert.deepEqual(result.missing, ["CODING_PLAN_API_KEY"], placeholder);
  }
});

test("coding-plan 模式下飞书应用字段仍然必需", () => {
  const missingId = checkFeishuTrialConfig({
    FEISHU_APP_SECRET: APP.FEISHU_APP_SECRET,
    BEER_VISION_PROVIDER: "coding-plan",
  });
  assert.equal(missingId.ready, false);
  assert.deepEqual(missingId.missing, ["FEISHU_APP_ID", "CODING_PLAN_API_KEY"]);

  const noFields = checkFeishuTrialConfig({
    BEER_VISION_PROVIDER: "coding-plan",
  });
  assert.equal(noFields.ready, false);
  assert.deepEqual(noFields.missing, ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "CODING_PLAN_API_KEY"]);
});

test("选择器两侧空白被裁剪后仍识别 coding-plan", () => {
  const result = checkFeishuTrialConfig({
    ...APP,
    BEER_VISION_PROVIDER: "  coding-plan  ",
    CODING_PLAN_API_KEY: "synthetic-package-key-2026",
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.missing, []);
});

test("Anthropic 视觉与 coding-plan 文本可独立配置，两个密钥齐全即可就绪", () => {
  const result = checkFeishuTrialConfig({
    ...APP,
    BEER_VISION_PROVIDER: "anthropic",
    BEER_TEXT_PROVIDER: "coding-plan",
    ANTHROPIC_API_KEY: "synthetic-anthropic-key-2026",
    CODING_PLAN_API_KEY: "synthetic-package-key-2026",
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.missing, []);
});

test("Anthropic 视觉必须显式选择文本路由，不静默使用已有 OpenRouter 密钥", () => {
  const result = checkFeishuTrialConfig({
    ...legacyEnv(),
    BEER_VISION_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "synthetic-anthropic-key-2026",
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, ["BEER_TEXT_PROVIDER"]);
});

test("Anthropic 视觉不借用其他密钥，文本也不能选择 anthropic", () => {
  const missingImageKey = checkFeishuTrialConfig({
    ...APP,
    BEER_VISION_PROVIDER: "anthropic",
    BEER_TEXT_PROVIDER: "coding-plan",
    CODING_PLAN_API_KEY: "synthetic-package-key-2026",
  });
  assert.deepEqual(missingImageKey.missing, ["ANTHROPIC_API_KEY"]);

  const anthropicText = checkFeishuTrialConfig({
    ...APP,
    BEER_VISION_PROVIDER: "anthropic",
    BEER_TEXT_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "synthetic-anthropic-key-2026",
  });
  assert.deepEqual(anthropicText.missing, ["BEER_TEXT_PROVIDER"]);
});

test("DeepSeek 视觉使用最新独立密钥，并要求显式文本路由", () => {
  const ready = checkFeishuTrialConfig({
    ...APP,
    BEER_VISION_PROVIDER: "deepseek",
    BEER_TEXT_PROVIDER: "coding-plan",
    DEEPSEEK_API_KEY: "synthetic-deepseek-key-2026",
    CODING_PLAN_API_KEY: "synthetic-package-key-2026",
  });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.missing, []);

  const missingText = checkFeishuTrialConfig({
    ...legacyEnv(),
    BEER_VISION_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "synthetic-deepseek-key-2026",
  });
  assert.deepEqual(missingText.missing, ["BEER_TEXT_PROVIDER"]);

  const missingImageKey = checkFeishuTrialConfig({
    ...APP,
    BEER_VISION_PROVIDER: "deepseek",
    BEER_TEXT_PROVIDER: "coding-plan",
    CODING_PLAN_API_KEY: "synthetic-package-key-2026",
  });
  assert.deepEqual(missingImageKey.missing, ["DEEPSEEK_API_KEY"]);
});

test("llm 文本路由复用现有 LLM_* 三字段，且不要求套餐或 OpenRouter 密钥", () => {
  const ready = checkFeishuTrialConfig({
    ...APP,
    BEER_VISION_PROVIDER: "deepseek",
    BEER_TEXT_PROVIDER: "llm",
    DEEPSEEK_API_KEY: "synthetic-deepseek-key-2026",
    LLM_BASE_URL: "https://llm.example/v1",
    LLM_API_KEY: "synthetic-llm-key-2026",
    LLM_MODEL: "synthetic-llm-model",
  });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.missing, []);

  for (const field of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]) {
    const missing = checkFeishuTrialConfig({
      ...APP,
      BEER_VISION_PROVIDER: "deepseek",
      BEER_TEXT_PROVIDER: "llm",
      DEEPSEEK_API_KEY: "synthetic-deepseek-key-2026",
      LLM_BASE_URL: "https://llm.example/v1",
      LLM_API_KEY: "synthetic-llm-key-2026",
      LLM_MODEL: "synthetic-llm-model",
      [field]: "",
    });
    assert.equal(missing.ready, false, field);
    assert.deepEqual(missing.missing, [field], field);
  }
});

test("选择器未设置或为空白时保持旧行为：要求 OpenRouter 字段", () => {
  for (const selector of [undefined, "", "   "]) {
    const ready = checkFeishuTrialConfig({ ...legacyEnv(), BEER_VISION_PROVIDER: selector });
    assert.equal(ready.ready, true, String(selector));
    assert.deepEqual(ready.missing, [], String(selector));

    const blocked = checkFeishuTrialConfig({ ...APP, BEER_VISION_PROVIDER: selector });
    assert.equal(blocked.ready, false, String(selector));
    assert.deepEqual(blocked.missing, ["OPENROUTER_API_KEY"], String(selector));
  }
});

test("非空但未知的选择器一律失败关闭，即使所有密钥字段都存在", () => {
  const rawSelector = "mystery-route-never-echoed-9f3a";
  const result = checkFeishuTrialConfig({
    ...APP,
    BEER_VISION_PROVIDER: rawSelector,
    OPENROUTER_API_KEY: "synthetic-openrouter-key-2026",
    CODING_PLAN_API_KEY: "synthetic-package-key-2026",
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, ["BEER_VISION_PROVIDER"]);
});

test("检查器只读取传入参数，不读取环境中的 process.env", () => {
  const previous = process.env.BEER_VISION_PROVIDER;
  process.env.BEER_VISION_PROVIDER = "coding-plan";
  try {
    // 参数是不带选择器的旧配置；若实现偷读 process.env 就会错误地要求套餐密钥。
    const result = checkFeishuTrialConfig(legacyEnv());
    assert.equal(result.ready, true);
    assert.deepEqual(result.missing, []);
  } finally {
    if (previous === undefined) delete process.env.BEER_VISION_PROVIDER;
    else process.env.BEER_VISION_PROVIDER = previous;
  }
});

test("检查器不修改传入的环境参数对象", () => {
  const env = { ...packageEnv(), BEER_VISION_PROVIDER: "  coding-plan  " };
  const snapshot = JSON.stringify(env);
  checkFeishuTrialConfig(env);
  assert.equal(JSON.stringify(env), snapshot);
});

test("结果 JSON 只含稳定字段名，绝不回显合成凭据或未知选择器原值", () => {
  const rawSelector = "mystery-route-never-echoed-9f3a";
  const variants = [
    packageEnv(),
    legacyEnv(),
    { ...legacyEnv(), BEER_VISION_PROVIDER: "coding-plan" },
    {
      ...APP,
      BEER_VISION_PROVIDER: "anthropic",
      BEER_TEXT_PROVIDER: "coding-plan",
      ANTHROPIC_API_KEY: "synthetic-anthropic-key-2026",
      CODING_PLAN_API_KEY: "synthetic-package-key-2026",
    },
    {
      ...APP,
      BEER_VISION_PROVIDER: "deepseek",
      BEER_TEXT_PROVIDER: "coding-plan",
      DEEPSEEK_API_KEY: "synthetic-deepseek-key-2026",
      CODING_PLAN_API_KEY: "synthetic-package-key-2026",
    },
    {
      ...APP,
      BEER_VISION_PROVIDER: rawSelector,
      OPENROUTER_API_KEY: "synthetic-openrouter-key-2026",
      CODING_PLAN_API_KEY: "synthetic-package-key-2026",
    },
  ];
  const secrets = [
    APP.FEISHU_APP_ID,
    APP.FEISHU_APP_SECRET,
    "synthetic-package-key-2026",
    "synthetic-openrouter-key-2026",
    "synthetic-anthropic-key-2026",
    "synthetic-deepseek-key-2026",
    rawSelector,
  ];
  for (const env of variants) {
    const json = JSON.stringify(checkFeishuTrialConfig(env));
    for (const secret of secrets) {
      assert.equal(json.includes(secret), false, json);
    }
  }
});
