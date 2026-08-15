// cdp-layout3.mjs — 验证 hero 开场白布局修复
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
  await new Promise((r) => setTimeout(r, 2500));

  await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find(b => (b.textContent||'').trim() === '新建会话' || (b.textContent||'').trim() === '新会话');
      if (t) { t.click(); return 'clicked'; }
      return 'no';
    })()`,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 1500));

  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const hello = [...document.querySelectorAll('div')].find(e => e.children.length === 0 && e.textContent.includes('你好呀'));
      if (!hello) return 'no hello';
      const cs = getComputedStyle(hello);
      const rect = hello.getBoundingClientRect();
      const parent = hello.parentElement;
      const pcs = parent ? getComputedStyle(parent) : null;
      const viewport = window.innerWidth;
      const centerX = viewport / 2;
      return JSON.stringify({
        helloWidth: Math.round(rect.width),
        helloLeft: Math.round(rect.left),
        helloCenter: Math.round(rect.left + rect.width / 2),
        viewportCenter: Math.round(centerX),
        centered: Math.abs((rect.left + rect.width/2) - centerX) < 5,
        parentDisplay: pcs?.display,
        parentFlexDir: pcs?.flexDirection,
        parentAlign: pcs?.alignItems,
        helloDisplay: cs.display,
        whiteSpace: cs.whiteSpace,
        text: hello.textContent.slice(0, 30),
      });
    })()`,
    returnByValue: true,
  });
  console.log('LAYOUT:', r.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 20000);
