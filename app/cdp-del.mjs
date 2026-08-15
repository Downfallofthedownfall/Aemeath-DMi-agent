// cdp-del.mjs — 验证会话删除按钮
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

  // 检查删除按钮存在（aria-label 含「删除」）
  const r1 = await send('Runtime.evaluate', {
    expression: `(() => {
      const delBtns = [...document.querySelectorAll('button[data-session-delete]')];
      return JSON.stringify({
        deleteButtonCount: delBtns.length,
        sampleLabels: delBtns.slice(0, 3).map(b => b.getAttribute('aria-label')),
        opacity0: delBtns.length ? getComputedStyle(delBtns[0]).opacity : null,
      });
    })()`,
    returnByValue: true,
  });
  console.log('DELETE BTNS:', r1.result?.value);

  // hover 第一行看按钮是否显示（模拟 mouseenter）
  await send('Runtime.evaluate', {
    expression: `(() => {
      const del = document.querySelector('button[data-session-delete]');
      if (!del) return 'no btn';
      del.parentElement.dispatchEvent(new MouseEvent('mouseenter', {bubbles: true}));
      return 'hovered: ' + getComputedStyle(del).opacity;
    })()`,
    returnByValue: true,
  }).then((r) => console.log('HOVER:', r.result?.value));

  // 点第一个删除（选一个非当前会话，避免误删当前）——先列出可删的
  const r2 = await send('Runtime.evaluate', {
    expression: `(() => {
      const del = document.querySelector('button[data-session-delete]');
      if (!del) return 'no btn';
      return 'target: ' + del.getAttribute('aria-label');
    })()`,
    returnByValue: true,
  });
  console.log('FIRST DELETABLE:', r2.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 20000);
