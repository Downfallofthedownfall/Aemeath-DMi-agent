// cdp-all.mjs — 验证角色切换/TTS/无工作区dropdown
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

  // 打开设置面板
  await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      const gear = btns.find(b => b.getAttribute('aria-label')?.includes('设置') || b.textContent?.includes('设置'));
      if (gear) { gear.click(); return 'clicked'; }
      return 'no gear';
    })()`,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 1200));

  // 点「爱弥斯」section
  await send('Runtime.evaluate', {
    expression: `(() => {
      const els = [...document.querySelectorAll('*')];
      const t = els.find(e => e.textContent?.trim() === '爱弥斯' && e.children.length === 0);
      if (t) { t.click(); return 'clicked'; }
      return 'no aemeath';
    })()`,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 1500));

  const check = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      // 角色按钮（爱弥斯/星炬卡片）
      const roleBtns = [...document.querySelectorAll('button')].filter(b => {
        const t = (b.textContent || '').trim();
        return t.includes('陪伴') || t.includes('物理学习');
      });
      return JSON.stringify({
        hasRoleSection: text.includes('角色模式'),
        roleButtonCount: roleBtns.length,
        roleButtonTexts: roleBtns.map(b => (b.textContent||'').trim().replace(/\\n/g, ' ')).slice(0, 2),
        hasWorkspaceDropdown: text.includes('选择工作区') || text.includes('Choose workspace'),
        hasTtsButton: text.includes('朗读'),
      });
    })()`,
    returnByValue: true,
  });
  console.log('CHECK:', check.result?.value);

  // 点角色切换按钮（星炬）并验证
  await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      const scholar = btns.find(b => (b.textContent||'').includes('物理学习'));
      if (scholar) { scholar.click(); return 'clicked scholar'; }
      return 'no scholar btn';
    })()`,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 1500));
  const after = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      const scholarBtn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('物理学习'));
      const border = scholarBtn ? getComputedStyle(scholarBtn).borderColor : null;
      return JSON.stringify({ text: text.slice(0, 120), scholarBorder: border });
    })()`,
    returnByValue: true,
  });
  console.log('AFTER CLICK:', after.result?.value);

  ws.close();
  process.exit(0);
});
setTimeout(() => process.exit(0), 30000);
