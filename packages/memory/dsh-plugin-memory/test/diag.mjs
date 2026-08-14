// 临时诊断脚本
import { decide, hasTimeEvidence } from '../lib/gatekeeper.js';
import { search } from '../lib/bm25.js';

const q = '我周三的物理考试考完了，感觉还不错';
console.log('decide:', JSON.stringify(decide(q, '恭喜你！')));
console.log('timeEvidence:', hasTimeEvidence(q));
console.log('bm25:', JSON.stringify(search(q, [{ id: 'a', content: '我下周三有物理考试，我有点紧张' }], 1)));
