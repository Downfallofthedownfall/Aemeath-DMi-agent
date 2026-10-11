// ============================================================
// check.mjs — 标记语法 + 类型/留白 单测
// 运行：npm test -w @aemeath/dsh-plugin-lecture
// ============================================================
import assert from 'node:assert/strict';
import {
  classifyLine,
  parseShorthand,
  renderShorthand,
  splitChunks,
  textsOfKind,
  missingBlanks,
  parseFrontMatter,
  renderFrontMatter,
} from '../lib/types.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// ---------- 标记语法 ----------

t('# 主题行', () => {
  const l = classifyLine('# 角动量定义');
  assert.equal(l.kind, 'topic');
  assert.equal(l.text, '角动量定义');
});

t('= 公式行', () => {
  const l = classifyLine('= L = r × p = Iω');
  assert.equal(l.kind, 'formula');
  assert.equal(l.text, 'L = r × p = Iω');
});

t('? 疑问行', () => {
  assert.equal(classifyLine('? 为什么必须有对称轴').kind, 'question');
});

t('! 重点行', () => {
  assert.equal(classifyLine('! 定轴转动才可写成 Iω').kind, 'keypoint');
});

t('> 例子行', () => {
  assert.equal(classifyLine('> 花样滑冰收臂').kind, 'example');
});

t('--- 分块（整行三连字符）', () => {
  const l = classifyLine('---');
  assert.equal(l.kind, 'divider');
  assert.equal(l.text, '');
});

t('--- 分块（含空格 / 更多连字符）', () => {
  assert.equal(classifyLine('- - -').kind, 'divider');
  assert.equal(classifyLine('-----').kind, 'divider');
});

t('短连字符不算分块（-- / 单个 -）', () => {
  assert.equal(classifyLine('--').kind, 'text');
  assert.equal(classifyLine('- 列表项').kind, 'text');
});

t('普通文本行', () => {
  const l = classifyLine('教授说下周有小测');
  assert.equal(l.kind, 'text');
  assert.equal(l.text, '教授说下周有小测');
});

t('空行 → text/value 空串', () => {
  const l = classifyLine('   ');
  assert.equal(l.kind, 'text');
  assert.equal(l.text, '');
});

t('标记后无空格也能解析', () => {
  assert.equal(classifyLine('=F=ma').kind, 'formula');
  assert.equal(classifyLine('=F=ma').text, 'F=ma');
});

// ---------- 解析 / 回写往返 ----------

t('parseShorthand 多行', () => {
  const lines = parseShorthand('# 标题\n= F = ma\n? 为什么\n');
  assert.equal(lines.length, 4); // 末尾空行也算一行
  assert.equal(lines[0].kind, 'topic');
  assert.equal(lines[1].kind, 'formula');
  assert.equal(lines[2].kind, 'question');
});

t('renderShorthand 往返一致', () => {
  const src = '# 标题\n= F = ma\n! 重点\n> 例子';
  const round = renderShorthand(parseShorthand(src));
  assert.equal(round, src);
});

t('renderShorthand 往返：分块', () => {
  const src = '# A\n= x\ny\n---\n# B\n? q';
  assert.equal(renderShorthand(parseShorthand(src)), src);
});

// ---------- 分块 ----------

t('splitChunks 按 --- 切分', () => {
  const chunks = splitChunks(parseShorthand('# A\n= x\n---\n# B\n= y'));
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 2);
  assert.equal(chunks[1].length, 2);
});

t('splitChunks 无分隔符 → 单块', () => {
  assert.equal(splitChunks(parseShorthand('# A\n= x')).length, 1);
});

t('splitChunks 忽略空块', () => {
  const chunks = splitChunks(parseShorthand('# A\n---\n---\n# B'));
  assert.equal(chunks.length, 2);
});

t('textsOfKind 提取公式', () => {
  const lines = parseShorthand('= F = ma\n= E = mc^2\n? q');
  assert.deepEqual(textsOfKind(lines, 'formula'), ['F = ma', 'E = mc^2']);
});

// ---------- 强制留白 ----------

t('missingBlanks：都填了 → 空', () => {
  assert.deepEqual(missingBlanks('[我的理解] 这是理解\n[我的疑问] 这里是疑问'), []);
});

t('missingBlanks：都缺', () => {
  const m = missingBlanks('随便写的内容');
  assert.equal(m.length, 2);
});

t('missingBlanks：只有标签没内容 → 视为缺失', () => {
  const m = missingBlanks('[我的理解]   \n[我的疑问] 有内容');
  assert.deepEqual(m, ['[我的理解]']);
});

t('missingBlanks：疑问缺失', () => {
  const m = missingBlanks('[我的理解] 有\n[我的疑问]');
  assert.deepEqual(m, ['[我的疑问]']);
});

// ---------- front-matter ----------

t('front-matter 往返', () => {
  const fm = { course: 'Physik I', unit: '第3讲', date: '2026-10-15', semester: 'WiSe', module: 'PHY-101' };
  const md = renderFrontMatter(fm) + '\n\n正文内容';
  const { front, body } = parseFrontMatter(md);
  assert.equal(front.course, 'Physik I');
  assert.equal(front.module, 'PHY-101');
  assert.equal(body.trim(), '正文内容');
});

t('front-matter 缺失 → body 原样返回', () => {
  const { front, body } = parseFrontMatter('没有头部\n正文');
  assert.deepEqual(front, {});
  assert.equal(body, '没有头部\n正文');
});

console.log(`\n[check.mjs] ${passed} 项断言通过`);
