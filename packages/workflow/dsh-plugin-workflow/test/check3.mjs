// ============================================================
// check3.mjs — compute_verify / check_dimensions 的 Python 脚本（需要 python + sympy）
// 环境没有 sympy 时跳过（macOS 版本来就不带 Python）。
// ============================================================
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYMPY_SCRIPT, DIMENSION_SCRIPT } from '../lib/scripts.js';

try {
  execFileSync('python', ['-c', 'import sympy'], { stdio: 'ignore', timeout: 30000 });
} catch {
  console.log('[workflow-scripts] 跳过：没有 python + sympy');
  process.exit(0);
}

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};
const run = (script, ...args) => JSON.parse(execFileSync('python', ['-c', script, ...args], { encoding: 'utf-8', timeout: 30000 }));
const verify = (...args) => run(SYMPY_SCRIPT, ...args);
const dims = (...args) => run(DIMENSION_SCRIPT, ...args);

t('compute_verify：正常表达式与解', () => {
  const r = verify('x**2-4', '2,-2');
  assert.equal(r.verified, true);
  assert.deepEqual(new Set(r.solutions), new Set(['-2', '2']));
  assert.equal(verify('x**2-4', '3').verified, false);
});

t('compute_verify：常用函数和常量仍可用', () => {
  assert.equal(verify('sin(x)', '0').verified, true);
  assert.equal(verify('exp(x)-1', '0').verified, true);
  assert.equal(verify('cos(x)', 'pi/2').verified, true);
  assert.equal(verify('t-1', '1', 't').verified, true);
});

t('compute_verify：白名单里的其他函数能算（曾被当成未定义函数，正确答案判成失败）', () => {
  assert.equal(verify('asinh(x)', '0').verified, true);
  assert.equal(verify('atan2(x, 1)', '0').verified, true);
  assert.equal(verify('Max(x, 2) - 2', '1').verified, true);
  assert.equal(verify('gamma(x) - 2', '3').verified, true);
});

t('compute_verify：不认识的函数名报错，不静默判成验证失败', () => {
  assert.match(verify('foo(x) - 1', '1').error, /unknown function: foo/);
  assert.match(verify('x(x + 1)', '0').error, /unknown function: x/);
});

t('compute_verify：^ 当乘方；不带括号的函数名按变量处理', () => {
  assert.equal(verify('x^2 - 4', '2,-2').verified, true);
  assert.equal(verify('gamma*x - 2*gamma', '2').verified, true);
  assert.equal(verify('N - 3', '3', 'N').verified, true);
});

const tmp = mkdtempSync(join(tmpdir(), 'wf-rce-'));
const marker = join(tmp, 'marker.txt').replace(/\\/g, '/');
const payloads = [
  `__import__('pathlib').Path('${marker}').write_text('x') and x`,
  `().__class__.__base__.__subclasses__()`,
  `f"{().__class__}"`,
  `lambda: __import__('os')`,
  `(1).real`,
];
for (const p of payloads) {
  t(`compute_verify 拒绝：${p.slice(0, 44)}`, () => {
    const r = verify(p, '1');
    assert.ok(r.error, `应该报错而不是执行：${JSON.stringify(r)}`);
    assert.equal(r.verified ?? false, false);
    assert.ok(!existsSync(marker), '代码被执行了');
  });
}
t('compute_verify：声称的解同样走安全解析', () => {
  const r = verify('x-1', `__import__('pathlib').Path('${marker}').write_text('x')`);
  assert.equal(r.verified, false);
  assert.ok(!existsSync(marker), '代码被执行了');
});
t('compute_verify：非法变量名被拒', () => {
  assert.match(verify('x-1', '1', '__class__').error, /variable/);
  assert.match(verify('x-1', '1', 'a b').error, /variable/);
});
t('check_dimensions 同样拒绝代码', () => {
  const r = dims(`__import__('pathlib').Path('${marker}').write_text('x')`);
  assert.equal(r.ok, false);
  assert.ok(!existsSync(marker), '代码被执行了');
});
rmSync(tmp, { recursive: true, force: true });

t('check_dimensions：传 expected 且量纲相同 → ok（曾经恒为 false）', () => {
  const r = dims('N*s/kg', 'm/s');
  assert.equal(r.ok, true);
  assert.equal(r.mismatch, undefined);
});
t('check_dimensions：量纲不同 → 报 mismatch', () => {
  const r = dims('N*s/kg', 'm');
  assert.equal(r.ok, false);
  assert.ok(r.mismatch);
});
t('check_dimensions：加项量纲不一致', () => {
  assert.equal(dims('m + s').consistent, false);
  assert.equal(dims('m/s + 2*m/s').ok, true);
});
t('check_dimensions：工具说明里的 Ω 可用', () => {
  assert.equal(dims('Ω*A', 'V').ok, true);
  assert.equal(dims('O*A', 'V').ok, true);
});

console.log(`\n[workflow-scripts] ${passed} 项断言全部通过`);
