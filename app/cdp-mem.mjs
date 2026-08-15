// cdp-mem.mjs — 验证记忆面板 + 角色命名
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

  // 开设置 → 小爱同学页
  await send('Runtime.evaluate', {
    expression: `(() => {
      const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '设置' || x.getAttribute('aria-label') === '设置');
      if (b) { b.click(); return 'ok'; }
      return 'no';
    })()`,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 1200));
  await send('Runtime.evaluate', {
    expression: `(() => {
      const dialog = document.querySelector('[role="dialog"]') || document.querySelector('[aria-modal="true"]');
      if (!dialog) return 'no dialog';
      const t = [...dialog.querySelectorAll('*')].find(e => e.textContent?.trim() === '小爱同学' && e.children.length === 0);
      if (t) { t.click(); return 'clicked'; }
      return 'no aemeath nav; dialog text: ' + dialog.textContent.slice(0, 100);
    })()`,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 1500));

  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      const dialog = document.querySelector('[role="dialog"]');
      const dtext = dialog ? dialog.textContent : '';
      return JSON.stringify({
        hasMemorySection: dtext.includes('记忆管理'),
        hasRoleSection: dtext.includes('角色模式'),
        hasRoleLabels: dtext.includes('小爱同学') && dtext.includes('爱弥斯-拉贝尔学部学霸'),
        hasMemoryItems: dtext.includes('物理考试') || dtext.includes('二相乐园'),
        hasStats: dtext.includes('活跃') && dtext.includes('沉睡'),
        hasDeleteBtn: dtext.includes('删除'),
        dtextSlice: dtext.slice(0, 300),
      });
    })()`,
    returnByValue: true,
  });
  console.log('MEM PANEL:', r.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 25000);
