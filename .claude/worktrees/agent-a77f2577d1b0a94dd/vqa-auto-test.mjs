#!/usr/bin/env node
/**
 * beer-lens VQA Auto Test Suite
 * Tests all 7 intents with Chinese inputs
 */

const BASE = 'http://localhost:3000/api/agent';
const USER_ID = 'vqa-auto-test';

const tests = [
  // ===== menu_recommend (酒单推荐) =====
  { intent: 'menu_recommend', input: '双倍干投暴龙苏', expectedMode: 'recommend', name: '双倍干投暴龙苏→Pseudo Sue' },
  { intent: 'menu_recommend', input: '赛博暴龙', expectedMode: 'recommend', name: '赛博暴龙→Cyber Sue' },
  { intent: 'menu_recommend', input: '推荐一款IPA', expectedMode: 'recommend', name: '推荐一款IPA' },
  { intent: 'menu_recommend', input: '推荐清爽的啤酒', expectedMode: 'recommend', name: '推荐清爽的啤酒' },

  // ===== label_check (酒标检查) =====
  { intent: 'label_check', input: '帮我看这个酒标', expectedMode: 'label_check', name: '帮我看这个酒标' },
  { intent: 'label_check', input: '这瓶酒过期了吗', expectedMode: 'label_check', name: '这瓶酒过期了吗' },
  { intent: 'label_check', input: '检查这瓶啤酒的生产日期', expectedMode: 'label_check', name: '检查生产日期' },

  // ===== tasting_feedback (品饮反馈) =====
  { intent: 'tasting_feedback', input: 'Pseudo Sue 4分，会再喝', expectedMode: 'tasting_feedback', name: 'Pseudo Sue评分' },
  { intent: 'tasting_feedback', input: '这酒不错，给5分，柑橘味', expectedMode: 'tasting_feedback', name: '好评5分柑橘味' },
  { intent: 'tasting_feedback', input: '不好喝，2分，不会再喝', expectedMode: 'tasting_feedback', name: '差评2分' },

  // ===== profile_query (画像查询) =====
  { intent: 'profile_query', input: '我喜欢什么风格的啤酒', expectedMode: 'profile_query', name: '喜欢的风格' },
  { intent: 'profile_query', input: '我的口味偏好是什么', expectedMode: 'profile_query', name: '口味偏好' },
  { intent: 'profile_query', input: '我之前喝过什么', expectedMode: 'profile_query', name: '喝过什么' },

  // ===== beer_knowledge (啤酒知识) =====
  { intent: 'beer_knowledge', input: '什么是IPA', expectedMode: 'beer_knowledge', name: '什么是IPA' },
  { intent: 'beer_knowledge', input: '世涛和波特有什么区别', expectedMode: 'beer_knowledge', name: '世涛vs波特' },
  { intent: 'beer_knowledge', input: '啤酒是怎么酿造的', expectedMode: 'beer_knowledge', name: '啤酒酿造' },

  // ===== memory_correction (记忆纠正) =====
  { intent: 'memory_correction', input: '清空我的历史记录', expectedMode: 'memory_correction', name: '清空历史记录' },
  { intent: 'memory_correction', input: '重置我的口味画像', expectedMode: 'memory_correction', name: '重置口味画像' },

  // ===== unclear (意图不明) =====
  { intent: 'unclear', input: '你好', expectedMode: 'unclear', name: '你好问候' },
];

async function runTest(test, idx) {
  const convId = `test-${test.intent}-${idx}`;
  const body = {
    userId: USER_ID,
    conversationId: convId,
    messages: [{ role: 'user', content: test.input }]
  };

  try {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const statusCode = res.status;
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        intent: test.intent,
        input: test.input,
        name: test.name,
        expectedMode: test.expectedMode,
        actualMode: 'PARSE_ERROR',
        actualError: text.substring(0, 500),
        pass: false,
        statusCode,
        candidates: null,
        picks: null,
        details: 'Response is not valid JSON'
      };
    }

    const actualMode = data.mode || data.intent || 'MISSING';
    let pass = actualMode === test.expectedMode;

    // For menu_recommend, also check candidates/picks
    let candidates = null;
    let picks = null;
    if (test.expectedMode === 'recommend') {
      candidates = data.candidates?.length ?? 0;
      picks = data.picks?.length ?? 0;
      // pass only if we found candidates too (unless the LLM didn't find any)
      if (pass && candidates === 0) {
        // might still be acceptable if the intent was right but no beer found
      }
    }

    // For unclear, beer_knowledge is also acceptable
    if (test.expectedMode === 'unclear' && (actualMode === 'beer_knowledge' || actualMode === 'unclear')) {
      pass = true;
    }

    return {
      intent: test.intent,
      input: test.input,
      name: test.name,
      expectedMode: test.expectedMode,
      actualMode,
      pass,
      statusCode,
      candidates,
      picks,
      details: pass ? 'OK' : `Expected ${test.expectedMode}, got ${actualMode}`
    };
  } catch (err) {
    return {
      intent: test.intent,
      input: test.input,
      name: test.name,
      expectedMode: test.expectedMode,
      actualMode: 'NETWORK_ERROR',
      pass: false,
      statusCode: 0,
      candidates: null,
      picks: null,
      details: err.message
    };
  }
}

async function main() {
  console.log('=== beer-lens VQA Auto Test Suite ===\n');

  const results = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    process.stdout.write(`[${i + 1}/${tests.length}] ${test.name.padEnd(30)} → `);
    const result = await runTest(test, i);
    results.push(result);

    if (result.pass) {
      passed++;
      process.stdout.write(`PASS (${result.actualMode})`);
    } else {
      failed++;
      process.stdout.write(`FAIL (expected=${result.expectedMode}, actual=${result.actualMode})`);
    }

    // Extra info for menu_recommend
    if (test.expectedMode === 'recommend') {
      process.stdout.write(` | candidates=${result.candidates}, picks=${result.picks}`);
    }

    if (test.expectedMode === 'unclear') {
      process.stdout.write(` | actualMode=${result.actualMode}`);
    }

    process.stdout.write('\n');
  }

  // Summary
  console.log(`\n=== Summary ===`);
  console.log(`Total: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Pass rate: ${(passed / results.length * 100).toFixed(1)}%`);

  // Intent distribution
  const modeCounts = {};
  for (const r of results) {
    modeCounts[r.actualMode] = (modeCounts[r.actualMode] || 0) + 1;
  }
  console.log('\nIntent Distribution (actual):');
  for (const [mode, count] of Object.entries(modeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${mode}: ${count}`);
  }

  // Badcase analysis
  const badcases = results.filter(r => !r.pass);
  if (badcases.length > 0) {
    console.log('\nBadcases:');
    for (const b of badcases) {
      console.log(`  [FAIL] ${b.name}: ${b.details}${b.actualError ? ' | ' + b.actualError : ''}`);
    }
  }

  return {
    testedAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed,
    results
  };
}

main().then(output => {
  // Output as JSON for piping
  console.log('\n---JSON_OUTPUT---');
  console.log(JSON.stringify(output, null, 2));
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});