// ============================================================
// 课程大纲纯函数单测（解析/学期/检索/摘要）
// 运行：npm test -w @aemeath/dsh-plugin-curriculum
// ============================================================
import assert from 'node:assert/strict';
import { parseCurriculum, currentSemester, modulesInSemester, searchModules, semesterSummary, formatModuleDetail, WINTER, SUMMER } from '../lib/curriculum.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const SAMPLE = {
  university: 'Universität Hamburg',
  degree_program: 'Bachelorstudiengang Physik',
  document_date: '25.01.2023',
  modules: [
    {
      category: 'Pflichtmodule aus dem Fachbereich Physik',
      details: [
        {
          title: 'Physik I (Mechanik und Wärmelehre)',
          module_code: 'PHY-E1',
          semester: ['Wintersemester', 'Sommersemester'],
          type: 'Pflichtmodul',
          prerequisites: { mandatory: 'keine', recommended: 'keine' },
          credits: 12,
          content: ['Experimentalphysik: Kinematik, Dynamik', 'Theoretische Physik I: Kepler-Problem'],
        },
        {
          title: 'Physik II (Elektrodynamik und Optik)',
          module_code: 'PHY-E2',
          semester: ['Wintersemester', 'Sommersemester'],
          type: 'Pflichtmodul',
          prerequisites: { mandatory: 'keine', recommended: 'Erfolgreiche Modulprüfung in PHYSIK I' },
          credits: 12,
          content: ['Elektrostatik', 'Maxwell-Gleichungen'],
        },
      ],
    },
    {
      category: 'Pflichtmodule aus der Mathematik',
      details: [
        {
          title: 'Mathematik I für Studierende der Physik',
          module_code: 'MATH1',
          semester: ['Wintersemester'],
          type: 'Pflichtmodul',
          prerequisites: { mandatory: 'keine', recommended: 'keine' },
          credits: 8,
          content: ['Vektoren und Vektorräume', 'Integration'],
        },
      ],
    },
  ],
};

const data = parseCurriculum(SAMPLE);

t('解析：3 个模块、分组正确', () => {
  assert.equal(data.categories.length, 2);
  const flat = data.categories.flatMap((c) => c.modules);
  assert.equal(flat.length, 3);
  assert.ok(flat.some((m) => m.module_code === 'PHY-E1'));
});

t('解析容错：坏模块跳过', () => {
  const bad = parseCurriculum({ modules: [{ category: 'x', details: [{ module_code: 'OK1', credits: 1 }, { title: 'no-code' }, null] }] });
  assert.equal(bad.categories[0].modules.length, 1);
});

t('学期判断：WiSe（10-3 月）与 SoSe（4-9 月）', () => {
  assert.equal(currentSemester(new Date(2026, 9, 1)), WINTER); // 10 月
  assert.equal(currentSemester(new Date(2026, 2, 15)), WINTER); // 3 月
  assert.equal(currentSemester(new Date(2026, 7, 14)), SUMMER); // 8 月
  assert.equal(currentSemester(new Date(2026, 7, 14), WINTER), WINTER); // 覆盖
});

t('模块检索：代码前缀', () => {
  const hits = searchModules(data, 'PHY-E1');
  assert.equal(hits[0]?.module_code, 'PHY-E1');
});

t('模块检索：德语关键词', () => {
  const hits = searchModules(data, 'Maxwell');
  assert.ok(hits.some((m) => m.module_code === 'PHY-E2'));
});

t('模块检索：内容关键词（德语）', () => {
  const hits = searchModules(data, 'Elektrostatik');
  assert.ok(hits.some((m) => m.module_code === 'PHY-E2'), 'PHY-E2 内容含 Elektrostatik');
});

t('学期模块筛选：WiSe 含 MATH1，SoSe 不含', () => {
  const winter = modulesInSemester(data, WINTER).flatMap((c) => c.modules);
  assert.ok(winter.some((m) => m.module_code === 'MATH1'));
  const summer = modulesInSemester(data, SUMMER).flatMap((c) => c.modules);
  assert.ok(!summer.some((m) => m.module_code === 'MATH1'));
});

t('semesterSummary：含学位/学期/模块', () => {
  const s = semesterSummary(data, WINTER);
  assert.ok(s.includes('Bachelorstudiengang'));
  assert.ok(s.includes('Wintersemester'));
  assert.ok(s.includes('PHY-E1'));
  assert.ok(s.includes('12 LP'));
});

t('formatModuleDetail：含前置与内容', () => {
  const d = formatModuleDetail(data.categories[0].modules[1]);
  assert.ok(d.includes('PHY-E2'));
  assert.ok(d.includes('Erfolgreiche Modulprüfung in PHYSIK I'));
  assert.ok(d.includes('Maxwell-Gleichungen'));
});

console.log(`\n[curriculum] ${passed} 项断言全部通过`);
