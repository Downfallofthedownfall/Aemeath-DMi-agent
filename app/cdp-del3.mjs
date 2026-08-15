// cdp-del3.mjs — 点击删除 → 行即时消失
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

  // 计数 + 点第一条的删除（选非当前会话）
  const r1 = await send('Runtime.evaluate', {
    expression: `(() => {
      const rows = [...document.querySelectorAll('.aemeath-session-row')];
      const before = rows.length;
      // 选第一条非当前会话的删除按钮
      const del = rows.map(r => r.querySelector('[data-session-delete]')).find(d => d && d.getAttribute('aria-label') !== '删除 新会话');
      if (!del) return JSON.stringify({ before, clicked: null });
      const label = del.getAttribute('aria-label');
      del.click();
      return JSON.stringify({ before, clicked: label });
    })()`,
    returnByValue: true,
  });
  console.log('CLICK:', r1.result?.value);
  await new Promise((r) => setTimeout(r, 1500));

  const r2 = await send('Runtime.evaluate', {
    expression: `(() => {
      const after = document.querySelectorAll('.aemeath-session-row').length;
      return JSON.stringify({ after });
    })()`,
    returnByValue: true,
  });
  console.log('AFTER:', r2.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 20000);
