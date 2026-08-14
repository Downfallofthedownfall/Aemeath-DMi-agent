// cdp-check4.mjs — 简化版 svg 检查
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
  await new Promise((r) => setTimeout(r, 2000));
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      fishCount: document.querySelectorAll('svg[viewBox="0 0 23.16 17.04"]').length,
      brandCount: document.querySelectorAll('svg[viewBox^="0 0 182 24"]').length,
      cssInjected: !!document.querySelector('style[data-plugin-css="@aemeath/dsh-plugin-ui/brand-hide"]'),
      fishDisplay: (() => { const el = document.querySelector('svg[viewBox="0 0 23.16 17.04"]'); return el ? getComputedStyle(el).display : 'no-el'; })(),
    })`,
    returnByValue: true,
  });
  console.log('RESULT:', r.result?.value);
  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 15000);
