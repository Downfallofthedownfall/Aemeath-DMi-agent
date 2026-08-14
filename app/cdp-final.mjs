// cdp-final.mjs — 最终验证：会话列表 + 新会话点击 + 无错误
import { WebSocket } from 'ws';

const ws = new WebSocket(process.argv[2]);
let msgId = 0;
const pending = new Map();
const errors = [];

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
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    const desc = (msg.params.args || []).map((a) => a.description || a.value || '').join(' ');
    errors.push(desc.slice(0, 300));
  }
});

ws.on('open', async () => {
  await send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 3000));

  const doc = await send('Runtime.evaluate', {
    expression: `document.body.innerText.slice(0, 600)`,
    returnByValue: true,
  });
  console.log('=== BODY ===');
  console.log(JSON.stringify(doc.result?.value ?? 'N/A'));

  // 点侧边栏「新会话」
  await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      const t = btns.find(b => {
        const txt = (b.textContent || '').trim();
        return txt === '新会话' && b.querySelector('span');
      });
      if (t) { t.click(); return 'clicked'; }
      return 'not found';
    })()`,
    returnByValue: true,
  }).then((r) => console.log('CLICK:', r.result?.value));
  await new Promise((r) => setTimeout(r, 2000));

  const doc2 = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      return {
        hasDirPicker: text.includes('选择文件夹') || text.includes('选择目录'),
        hasNewSessionView: text.includes('还没有会话') || text.includes('新会话'),
        hasComposer: !!document.querySelector('[contenteditable="true"], textarea'),
        snippet: text.slice(0, 300),
      };
    })()`,
    returnByValue: true,
  });
  console.log('=== AFTER ===');
  console.log(JSON.stringify(doc2.result?.value, null, 2));
  console.log('=== ERRORS:', errors.length ? errors.join(' | ') : 'NONE');

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 25000);
