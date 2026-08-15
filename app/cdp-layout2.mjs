// cdp-layout2.mjs — 看 hero 整体结构
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

  // 点新建会话
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

  // 找 hero 根容器，输出其子树结构（标签+class+文本前30字）
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const hello = [...document.querySelectorAll('div')].find(e => e.children.length === 0 && e.textContent.includes('你好呀'));
      if (!hello) return 'no hello';
      // 向上走 4 层打印每层结构
      const chain = [];
      let node = hello;
      for (let i = 0; i < 5 && node; i++) {
        const cs = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        chain.push({
          level: i,
          tag: node.tagName,
          cls: (node.className||'').toString().slice(0, 50),
          display: cs.display,
          flexDir: cs.flexDirection,
          align: cs.alignItems,
          justify: cs.justifyContent,
          w: Math.round(rect.width), h: Math.round(rect.height),
          top: Math.round(rect.top),
          text: (node.childNodes.length <= 2 ? node.textContent.slice(0, 25) : ''),
        });
        node = node.parentElement;
      }
      return JSON.stringify(chain);
    })()`,
    returnByValue: true,
  });
  console.log('CHAIN:', r.result?.value);

  // 检查是否有重叠：开场白与输入框位置
  const r2 = await send('Runtime.evaluate', {
    expression: `(() => {
      const hello = [...document.querySelectorAll('div')].find(e => e.children.length === 0 && e.textContent.includes('你好呀'));
      const input = document.querySelector('[contenteditable="true"], textarea');
      if (!hello || !input) return 'missing';
      const hr = hello.getBoundingClientRect();
      const ir = input.getBoundingClientRect();
      return JSON.stringify({
        helloBottom: hr.bottom,
        inputTop: ir.top,
        gap: ir.top - hr.bottom,
        overlap: hr.bottom > ir.top,
      });
    })()`,
    returnByValue: true,
  });
  console.log('OVERLAP:', r2.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 20000);
