// cdp-ui.mjs — 验证 UI 精简：侧边栏内容（应显示爱弥斯会话列表而非 workspace 浏览器）
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

  const doc = await send('Runtime.evaluate', {
    expression: `document.body.innerText.slice(0, 1500)`,
    returnByValue: true,
  });
  console.log('=== BODY (first 1500) ===');
  console.log(JSON.stringify(doc.result?.value ?? 'N/A'));

  // 检查是否有「新会话」按钮（我们的极简列表）vs 工作区标题
  const check = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      return {
        hasOurNewSession: text.includes('新会话'),
        hasWorkspaceHeader: text.includes('工作区'),
        hasAemeathBrand: text.includes('爱弥斯 · 物理学习 Copilot'),
        hasAddWorkspace: text.includes('添加工作区'),
      };
    })()`,
    returnByValue: true,
  });
  console.log('=== UI CHECK ===');
  console.log(JSON.stringify(check.result?.value, null, 2));

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 20000);
