// cdp-layout.mjs — 检查 hero 开场白布局错位
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

  // 点新建会话看 hero
  await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find(b => (b.textContent||'').trim() === '新建会话' || (b.textContent||'').trim() === '新会话');
      if (t) { t.click(); return 'clicked'; }
      return 'no';
    })()`,
    returnByValue: true,
  }).then((r) => console.log('NEW:', r.result?.value));
  await new Promise((r) => setTimeout(r, 1500));

  // 找开场白元素及其父容器布局
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const hello = [...document.querySelectorAll('div,span')].find(e => e.children.length === 0 && e.textContent.includes('你好呀，我是爱弥斯'));
      const sub = [...document.querySelectorAll('div,span')].find(e => e.children.length === 0 && e.textContent.includes('想聊聊天，还是让星炬'));
      const info = (el) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const parent = el.parentElement;
        const pcs = parent ? getComputedStyle(parent) : null;
        return {
          tag: el.tagName,
          display: cs.display,
          position: cs.position,
          marginTop: cs.marginTop,
          textAlign: cs.textAlign,
          width: rect.width, height: rect.height,
          top: rect.top, left: rect.left,
          parentDisplay: pcs?.display,
          parentFlexDir: pcs?.flexDirection,
          parentGrid: pcs?.gridTemplateColumns ? pcs.gridTemplateColumns.slice(0,40) : null,
        };
      };
      return JSON.stringify({
        hello: info(hello),
        sub: info(sub),
        helloText: hello ? hello.textContent.slice(0, 30) : 'NOT FOUND',
        subText: sub ? sub.textContent.slice(0, 30) : 'NOT FOUND',
      });
    })()`,
    returnByValue: true,
  });
  console.log('LAYOUT:', r.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 20000);
