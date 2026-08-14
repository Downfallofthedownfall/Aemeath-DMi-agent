import { decide, hasTimeEvidence } from '../lib/gatekeeper.js';
for (const q of ['我这学期选了热力学和光学两门课','我习惯早上先做数学题再学物理','我发现自己晚上学习效率比白天高']) {
  try { console.log(q, '=>', JSON.stringify(decide(q, '好的'))); } catch (e) { console.log(q, 'THREW:', e.message); }
}
