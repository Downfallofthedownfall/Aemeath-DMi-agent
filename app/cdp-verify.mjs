// cdp-verify.mjs — 验证 hero 开场白 + 白色主题 + 无探索未至之境
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
  await new Promise((r) => setTimeout(r, 3500));

  // 新建空白会话看 hero（当前有会话，直接看当前页 + 新建后）
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      const bg = getComputedStyle(document.body).backgroundColor;
      const heroText = [...document.querySelectorAll('div')].filter(d => d.textContent.includes('我是爱弥斯')).length;
      return JSON.stringify({
        hasExploreHeadline: text.includes('探索未至之境'),
        hasPreview: text.includes('预览版'),
        hasAemeathHero: text.includes('我是爱弥斯'),
        heroElements: heroText,
        bodyBg: bg,
        bodySlice: text.slice(0, 300),
      });
    })()`,
    returnByValue: true,
  });
  console.log('CHECK:', r.result?.value);

  // 点新会话看 hero 区
  await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find(b => (b.textContent||'').trim() === '新会话');
      if (t) { t.click(); return 'clicked'; }
      return 'not-found';
    })()`,
    returnByValue: true,
  });
  await new Promise((r2) => setTimeout(r2, 2000));
  const r2 = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      const cs = getComputedStyle(document.body);
      return JSON.stringify({
        hasExploreHeadline: text.includes('探索未至之境'),
        hasAemeathHero: text.includes('我是爱弥斯') || text.includes('爱弥斯 ✦'),
        bodyBg: cs.backgroundColor,
        slice: text.slice(0, 350),
      });
    })()`,
    returnByValue: true,
  });
  console.log('AFTER NEW SESSION:', r2.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 25000);
