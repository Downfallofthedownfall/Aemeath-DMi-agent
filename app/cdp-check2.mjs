// cdp-check2.mjs — 验证：会话历史、单新会话按钮、无 dsh 品牌/鲸鱼、无多余预设
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
    expression: `(() => {
      const text = document.body.innerText;
      // 新会话按钮计数：sidebar 里的
      const btns = [...document.querySelectorAll('button')];
      const newSessionBtns = btns.filter(b => (b.textContent||'').trim() === '新会话' || (b.textContent||'').includes('新会话'));
      const fishSvg = document.querySelectorAll('svg[viewBox="0 0 23.16 17.04"]');
      const brandSvg = document.querySelectorAll('svg[viewBox^="0 0 182 24"]');
      return {
        bodySlice: text.slice(0, 500),
        newSessionButtonCount: newSessionBtns.length,
        fishSvgCount: fishSvg.length,
        brandSvgCount: brandSvg.length,
        hasSessionHistory: text.includes('熵的定义与解读') || text.includes('什么是熵'),
        hasDeepSeekHarnessText: text.includes('DeepSeek Harness'),
        hasStandardMode: text.includes('标准模式'),
        hasAgentPresetNav: text.includes('Agent 预设'),
      };
    })()`,
    returnByValue: true,
  });
  console.log('=== CHECK ===');
  console.log(JSON.stringify(doc.result?.value, null, 2));
  console.log('=== ERRORS:', errors.length ? errors.join(' | ') : 'NONE');

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 25000);
