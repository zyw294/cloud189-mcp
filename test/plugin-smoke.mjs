// DSH shell smoke test: real stdio round-trip + a fake DSH ctx to prove that
// apply() registers every discovered MCP tool through ctx.tools.register.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { apply, name, inject } from '../lib/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION = process.env.CLOUD189_SESSION_PATH || 'F:/Ai/Deepseek/sync/.c189_session.json';
const EXPECTED = 10;

const registered = [];
const ctx = {
  tools: {
    register(definition) {
      registered.push(definition);
      return () => {
        const i = registered.indexOf(definition);
        if (i >= 0) registered.splice(i, 1);
      };
    },
  },
  effect() {},
  on() {},
};

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });

check('插件导出 name', name === 'cloud189-mcp', name);
check('插件 inject 包含 tools', Array.isArray(inject) && inject.includes('tools'), inject);

apply(ctx, { sessionPath: SESSION });

const deadline = Date.now() + 60000;
while (registered.length < EXPECTED && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200));
}

check(`apply() 注册了 ${EXPECTED} 个工具`, registered.length === EXPECTED, registered.map((t) => t.name));

const quota = registered.find((t) => t.name === 'cloud189_quota');
if (quota) {
  try {
    const value = await quota.execute({});
    check('通过壳调用 cloud189_quota 成功', Boolean(value && value.text), value && value.text);
  } catch (error) {
    check('通过壳调用 cloud189_quota 成功', false, error.message);
  }
} else {
  check('找到 cloud189_quota 工具', false, null);
}

const del = registered.find((t) => t.name === 'cloud189_delete');
check('删除工具已注册', Boolean(del), del ? del.parameters : null);

const report = { at: new Date().toISOString(), checks, allPassed: checks.every((c) => c.ok) };
mkdirSync(join(HERE, '..', 'verify'), { recursive: true });
const file = join(HERE, '..', 'verify', `plugin-smoke-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ file, checks: report.checks, allPassed: report.allPassed }, null, 2));
process.exit(report.allPassed ? 0 : 1);
