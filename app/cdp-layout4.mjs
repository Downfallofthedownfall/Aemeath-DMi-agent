// cdp-layout4.mjs — 完整祖先链分析
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
      if (t) t.click();
    })()`,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 1500));

  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const hello = [...document.querySelectorAll('div')].find(e => e.children.length === 0 && e.textContent.includes('你好呀'));
      if (!hello) return 'no hello';
      const chain = [];
      let node = hello;
      for (let i = 0; i < 7 && node; i++) {
        const cs = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        chain.push({
          lv: i, tag: node.tagName,
          cls: (node.className||'').toString().slice(0, 60),
          display: cs.display, fd: cs.flexDirection,
          ai: cs.alignItems, jc: cs.justifyContent,
          w: Math.round(rect.width), left: Math.round(rect.left),
          top: Math.round(rect.top),
          pad: cs.padding.slice(0,20),
        });
        node = node.parentElement;
      }
      return JSON.stringify(chain);
    })()`,
    returnByValue: true,
  });
  console.log('CHAIN:', r.result?.value);
  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 20000);
