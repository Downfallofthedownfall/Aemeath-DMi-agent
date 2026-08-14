// cdp-check3.mjs — 检查 fish/brand svg 是否被 CSS 隐藏
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
    expression: `(() => {
      const fish = [...document.querySelectorAll('svg[viewBox="0 0 23.16 17.04"]')];
      const brand = [...document.querySelectorAll('svg[viewBox^="0 0 182 24"]')];
      const info = (el) => {
        const cs = getComputedStyle(el);
        const parent = el.closest('[data-testid], [class]');
        return {
          display: cs.display,
          visibility: cs.visibility,
          parentClass: parent ? parent.className.slice(0, 60) : null,
          parentText: parent ? parent.textContent.slice(0, 40) : null,
        };
      };
      return {
        fish: fish.map(info),
        brand: brand.map(info),
        injectedCss: !!document.querySelector('style[data-plugin-css="@aemeath/dsh-plugin-ui/brand-hide"]'),
      };
    })()`,
    returnByValue: true,
  });
  console.log(JSON.stringify(r.result?.value, null, 2));
  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 15000);
