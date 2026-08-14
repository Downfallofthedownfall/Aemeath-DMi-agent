// cdp-role.mjs — 点击角色切换按钮验证响应
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
  // 设置面板应该还开着（上一步已开 + 已点爱弥斯）

  // 读角色按钮状态
  const r1 = await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')].filter(b => (b.textContent||'').includes('物理学习') || (b.textContent||'').includes('陪伴'));
      return JSON.stringify(btns.map(b => {
        const cs = getComputedStyle(b);
        return { text: (b.textContent||'').trim().replace(/\\n/g,' '), border: cs.borderColor, bg: cs.backgroundColor };
      }));
    })()`,
    returnByValue: true,
  });
  console.log('BEFORE:', r1.result?.value);

  // 点星炬
  await send('Runtime.evaluate', {
    expression: `(() => {
      const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').includes('物理学习'));
      if (b) { b.click(); return 'clicked'; }
      return 'no';
    })()`,
    returnByValue: true,
  }).then((r) => console.log('CLICK:', r.result?.value));
  await new Promise((r) => setTimeout(r, 1500));

  const r2 = await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')].filter(b => (b.textContent||'').includes('物理学习') || (b.textContent||'').includes('陪伴'));
      return JSON.stringify(btns.map(b => {
        const cs = getComputedStyle(b);
        return { text: (b.textContent||'').trim().replace(/\\n/g,' '), border: cs.borderColor };
      }));
    })()`,
    returnByValue: true,
  });
  console.log('AFTER:', r2.result?.value);

  // 服务端确认
  const srv = await send('Runtime.evaluate', {
    expression: `fetch('/aemeath/api/settings').then(r=>r.json()).then(d=>JSON.stringify(d.namespaces['agent-presets']))`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('SERVER:', srv.result?.value);

  // 切回爱弥斯
  await send('Runtime.evaluate', {
    expression: `(() => {
      const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').includes('陪伴'));
      if (b) { b.click(); return 'clicked back'; }
      return 'no';
    })()`,
    returnByValue: true,
  }).then((r) => console.log('BACK:', r.result?.value));
  await new Promise((r) => setTimeout(r, 1200));

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 25000);
