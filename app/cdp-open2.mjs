// cdp-open2.mjs — 精确打开设置面板
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

  // 找到侧边栏设置按钮（文本恰好是「设置」或 aria-label 含设置）
  const r1 = await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      const gear = btns.find(b => (b.textContent||'').trim() === '设置' || b.getAttribute('aria-label') === '设置');
      if (!gear) return 'no gear';
      gear.click();
      return 'clicked: ' + gear.outerHTML.slice(0, 120);
    })()`,
    returnByValue: true,
  });
  console.log('CLICK1:', r1.result?.value);
  await new Promise((r) => setTimeout(r, 2000));

  const r2 = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      return JSON.stringify({
        hasGeneral: text.includes('通用设置'),
        hasAemeath: text.includes('爱弥斯'),
        snippet: text.slice(0, 250),
      });
    })()`,
    returnByValue: true,
  });
  console.log('AFTER:', r2.result?.value);

  // 如果有「爱弥斯」导航，点击它
  await send('Runtime.evaluate', {
    expression: `(() => {
      const els = [...document.querySelectorAll('*')];
      const t = els.find(e => e.textContent?.trim() === '爱弥斯' && e.children.length === 0 && e.tagName !== 'BUTTON');
      if (!t) return 'no aemeath text';
      t.click();
      return 'clicked aemeath';
    })()`,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 1500));

  const r3 = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      return JSON.stringify({
        hasRoleSection: text.includes('角色模式'),
        hasFeatureSwitches: text.includes('功能开关'),
        roleBtns: [...document.querySelectorAll('button')].filter(b => (b.textContent||'').includes('物理学习') || (b.textContent||'').includes('陪伴')).length,
        snippet: text.slice(0, 300),
      });
    })()`,
    returnByValue: true,
  });
  console.log('FINAL:', r3.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 25000);
