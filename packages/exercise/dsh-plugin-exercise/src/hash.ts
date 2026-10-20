// ============================================================
// hash.ts — 小型哈希工具（答案指纹、条目 id）
//
// 为什么单独一个文件：types.ts 是**纯函数/客户端可用**的，不能 import node:crypto；
// 而答案指纹（check.answer_sha）只在 host 侧算，放这里最干净。
// ============================================================

import { createHash } from 'node:crypto';

/** 12 位 sha1 前缀：够撞不上，也够短到能塞进 UI。 */
export function sha1Short(text: string): string {
  return createHash('sha1').update(text, 'utf-8').digest('hex').slice(0, 12);
}

/** 答案指纹：先规范化（去行尾空白/折叠空行），再哈希 —— 只改空格不算改答案。 */
export function answerFingerprint(normalizedAnswer: string): string {
  return sha1Short(normalizedAnswer);
}
