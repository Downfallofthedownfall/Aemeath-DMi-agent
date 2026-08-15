// cdp-l3.mjs — 验证 L1/L2/L3 分层面板
import { WebSocket } from 'ws';
const ws = new WebSocket(process.argv[2]);
let msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
});
ws.on('open', async () => {
  await send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 3000));

  await send('Runtime.evaluate', {
    expression: `(() => {
      const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '设置' || x.getAttribute('aria-label') === '设置');
      if (b) { b.click(); return 'ok'; }
      return 'no';
    })()`,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 1200));
  await send('Runtime.evaluate', {
    expression: `(() => {
      const dialog = document.querySelector('[role="dialog"]') || document.querySelector('[aria-modal="true"]');
      if (!dialog) return 'no dialog';
      const t = [...dialog.querySelectorAll('*')].find(e => e.textContent?.trim() === '小爱同学' && e.children.length === 0);
      if (t) { t.click(); return 'clicked'; }
      return 'no nav';
    })()`,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 1800));

  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const dtext = dialog ? dialog.textContent : '';
      return JSON.stringify({
        hasL1: dtext.includes('L1 · 暂存区'),
        hasL2: dtext.includes('L2 · 角色记忆'),
        hasL3: dtext.includes('L3 · 共享记忆'),
        hasL1Desc: dtext.includes('会话内工作态'),
        hasL2Desc: dtext.includes('角色隔离'),
        hasL3Desc: dtext.includes('跨角色共享'),
        hasMemoryItem: dtext.includes('物理考试') || dtext.includes('学习'),
        statsL1: dtext.includes('L1 暂存'),
        statsL2: dtext.includes('L2 角色'),
        statsL3: dtext.includes('L3 共享'),
      });
    })()`,
    returnByValue: true,
  });
  console.log('LAYERS:', r.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 25000);
