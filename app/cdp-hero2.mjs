// cdp-hero2.mjs — 精确定位开场白文本节点
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
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      // 找文本恰好是开场白或副标题的元素
      const targets = ['你好呀，我是爱弥斯', '想聊聊天，还是让星炬'];
      const out = {};
      for (const t of targets) {
        const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim().startsWith(t));
        if (el) {
          const cs = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          out[t.slice(0, 8)] = {
            display: cs.display,
            fontSize: cs.fontSize,
            color: cs.color,
            rect: rect.width > 0 ? rect.width + 'x' + rect.height : 'zero',
          };
        } else {
          out[t.slice(0, 8)] = 'NOT FOUND';
        }
      }
      // 主题变量（可能在 body 或 :root 上）
      const tryTokens = ['--dsw-alias-bg-base', '--dsw-alias-bg-subtle', '--dsw-alias-label-primary'];
      const tokens = {};
      for (const tk of tryTokens) {
        tokens[tk] = getComputedStyle(document.body).getPropertyValue(tk).trim() || getComputedStyle(document.documentElement).getPropertyValue(tk).trim();
      }
      return JSON.stringify({ found: out, tokens, bodyBg: getComputedStyle(document.body).backgroundColor });
    })()`,
    returnByValue: true,
  });
  console.log('HERO2:', r.result?.value);
  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 20000);
