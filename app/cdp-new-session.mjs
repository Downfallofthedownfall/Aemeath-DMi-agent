// cdp-new-session.mjs — 点击「新会话」验证不再要求工作区，且默认 preset 生效
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

  // 点击侧边栏「新会话」按钮（我们的极简列表里的）
  const click = await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      // 我们的新会话按钮包含 ＋ 或文本 新会话 且是侧边栏里的
      const target = btns.find(b => {
        const t = (b.textContent || '').trim();
        return (t === '新会话' || t === '＋\n新会话' || (t.includes('新会话') && t.length < 20)) && b.querySelector('span');
      });
      if (target) { target.click(); return 'clicked: ' + JSON.stringify(target.textContent); }
      return 'not found; new-session-ish: ' + btns.filter(b => (b.textContent||'').includes('新会话')).map(b => JSON.stringify(b.textContent)).join('|');
    })()`,
    returnByValue: true,
  });
  console.log('CLICK:', click.result?.value);

  await new Promise((r) => setTimeout(r, 2000));

  // 抓当前状态：是否出现工作区选择弹窗/是否进入会话
  const doc = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      const hasDirPicker = text.includes('选择文件夹') || text.includes('选择目录') || text.includes('browse') || text.includes('目录');
      const hasComposer = !!document.querySelector('[contenteditable="true"], textarea');
      return {
        hasDirPicker,
        hasComposer,
        bodySlice: text.slice(0, 400),
      };
    })()`,
    returnByValue: true,
  });
  console.log('AFTER CLICK:', JSON.stringify(doc.result?.value, null, 2));

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 20000);
