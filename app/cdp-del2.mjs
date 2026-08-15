// cdp-del2.mjs — hover 显示删除按钮 + 实际删除一条测试会话
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

  // 1) hover 第一行 → 删除按钮应显示
  const r1 = await send('Runtime.evaluate', {
    expression: `(() => {
      const row = document.querySelector('.aemeath-session-row');
      if (!row) return 'no row';
      const del = row.querySelector('[data-session-delete]');
      const before = getComputedStyle(del).opacity;
      row.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
      const after = getComputedStyle(del).opacity;
      return JSON.stringify({ before, after, label: del.getAttribute('aria-label') });
    })()`,
    returnByValue: true,
  });
  console.log('HOVER:', r1.result?.value);

  // 2) 实际删除：选一条"你好"会话（非当前），点击删除，验证列表减少
  const r2 = await send('Runtime.evaluate', {
    expression: `(() => {
      const del = document.querySelector('button[data-session-delete][aria-label="删除 你好"]') || document.querySelector('button[data-session-delete]');
      if (!del) return 'no delete btn';
      const label = del.getAttribute('aria-label');
      const countBefore = document.querySelectorAll('.aemeath-session-row').length;
      del.click();
      return JSON.stringify({ clicked: label, countBefore });
    })()`,
    returnByValue: true,
  });
  console.log('CLICK:', r2.result?.value);
  await new Promise((r) => setTimeout(r, 2000));

  const r3 = await send('Runtime.evaluate', {
    expression: `(() => {
      const countAfter = document.querySelectorAll('.aemeath-session-row').length;
      return JSON.stringify({ countAfter });
    })()`,
    returnByValue: true,
  });
  console.log('AFTER:', r3.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 25000);
