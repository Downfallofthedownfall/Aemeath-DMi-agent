// ============================================================
// app.js - 聊天窗口核心逻辑
// 功能：双模态切换、共享记忆、流式对话、OOC自动修正、
//       TTS语音、语音输入、KaTeX公式渲染
// ============================================================

window.addEventListener('DOMContentLoaded', () => {

  // ========== DOM 元素 ==========
  const historyList = document.getElementById('history-list');
  const messagesContainer = document.getElementById('messages-container');
  const userInput = document.getElementById('user-input');
  const sendBtn = document.getElementById('send-btn');
  const micBtn = document.getElementById('mic-btn');
  const newChatBtn = document.getElementById('new-chat-btn');
  const ttsSwitch = document.getElementById('tts-switch');
  const modeToggleBtn = document.getElementById('mode-toggle-btn');
  const modeIndicator = document.getElementById('mode-indicator');
  const sendStatusEl = document.getElementById('send-status');

  // ========== 状态变量 ==========
  let conversations = [];
  let currentConversationId = null;
  let currentConfirmActions = null;   // 当前页内确认框的快捷键处理函数（F8/F7/F9 委托用）
  let isRecording = false;
  let recognition = null;
  let currentMode = 'aemeath';
  let planMode = false;  // 计划模式总开关
  let configData = null;
  let approveAllRemaining = false;  // F9：本次任务剩余非高风险工具自动允许
  let authToken = ''; 
  let isSending = false;  // 流式期间禁发，避免同一会话并发轮次交错（问题4）
  // AI 服务地址
  const AI_SERVICE_URL = 'http://127.0.0.1:18892';

  // ========== TTS 语音播报（通过 Electron 主进程请求，不占用浏览器连接池） ==========
  async function speakText(text) {
    if (!text) return;
    
    try {
      const appPath = await window.electronAPI.getAppPath();
      const projectRoot = appPath.substring(0, appPath.lastIndexOf('\\'));
      const voicePath = projectRoot + '\\voices\\aemeath.wav';

      console.log('[TTS] 通过主进程请求...');
      
      // 用 Electron IPC 请求 TTS（不走浏览器 fetch）
      const base64Audio = await window.electronAPI.ttsFetch(text, voicePath);
      
      console.log('[TTS] 收到音频，开始播放...');
      
      // base64 → Blob → 播放
      const binaryString = atob(base64Audio);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'audio/wav' });
      const audioUrl = URL.createObjectURL(blob);
      
      await new Promise((resolve) => {
        const audio = new Audio(audioUrl);
        audio.onended = () => { URL.revokeObjectURL(audioUrl); resolve(); };
        audio.onerror = () => { URL.revokeObjectURL(audioUrl); resolve(); };
        audio.play().catch(() => resolve());
      });
      
      console.log('[TTS] 播放完成');
      
    } catch (error) {
      console.warn('[TTS] 不可用:', error.message);
    }
  }

  // ========== 语音播报开关 ==========
  const ttsEnabled = localStorage.getItem('ttsEnabled') !== 'false';
  ttsSwitch.checked = ttsEnabled;
  ttsSwitch.addEventListener('change', () => {
    localStorage.setItem('ttsEnabled', ttsSwitch.checked);
  });

  // ========== 共享记忆 ==========
  function saveSharedMemory(key, value) {
    let memory = JSON.parse(localStorage.getItem('shared_memory') || '{}');
    memory[key] = value;
    localStorage.setItem('shared_memory', JSON.stringify(memory));
  }

  function getSharedMemory(key) {
    let memory = JSON.parse(localStorage.getItem('shared_memory') || '{}');
    return memory[key] || null;
  }

  function getAllSharedMemoryText() {
    let memory = JSON.parse(localStorage.getItem('shared_memory') || '{}');
    let parts = [];
    for (let key in memory) {
      parts.push(key + '：' + memory[key]);
    }
    return parts.length > 0 ? '用户信息：' + parts.join('；') : '';
  }

  // ========== 初始化 ==========
  async function init() {
    const config = await window.electronAPI.getConfig();   // 只声明一次！
    configData = config;
    // 获取认证 token（只走 IPC，网页拿不到）
    try { authToken = await window.electronAPI.getAuthToken(); } catch (e) { authToken = ''; }
    if (!configData.deepseek_api_key || configData.deepseek_api_key === 'sk-把你的DeepSeekAPIKey填在这里') {
      console.warn('⚠️ 警告：未配置 DeepSeek API Key，请在 config.json 中设置');
    }
    const savedConversations = localStorage.getItem('conversations_' + currentMode);
    if (savedConversations) {
      conversations = JSON.parse(savedConversations);
    } else {
      conversations = [createNewConversation()];
    }
    currentConversationId = conversations[0].id;
    updateModeIndicator();
    renderHistoryList();
    renderMessages();
    // 启动 TTS 暖机（不阻塞）
    warmupTTS();
    // 全局快捷键（常驻）：F9 在任何状态都能开启"剩余自动允许"；F8/F7 委托给当前确认框
    window.electronAPI?.onApprovalHotkey?.((action) => {
      if (currentConfirmActions && currentConfirmActions[action]) {
        currentConfirmActions[action]();
      } else if (action === 'approve-all') {
        approveAllRemaining = true;
        appendSystemNote('已开启：本次任务剩余非高风险操作自动允许');
      }
    });
  }
  // ========== 会话 ID 生成（前端 UUID，避免按首条消息哈希导致会话碰撞） ==========
  function generateSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'sess_' + window.crypto.randomUUID();
    }
    // 兜底：时间戳 + 随机数
    return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 10);
  }

  // ========== 对话对象 ==========
  function createNewConversation() {
    return {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      session_id: generateSessionId(),   // 新增：服务端按此 ID 隔离 L1/L2/scratch
      title: 'New',
      messages: [],
    };
  }

  function saveConversations() {
    localStorage.setItem('conversations_' + currentMode, JSON.stringify(conversations));
  }

  function getCurrentConversation() {
    return conversations.find(c => c.id === currentConversationId);
  }

  function updateModeIndicator() {
    if (modeIndicator && configData && configData.modes) {
      modeIndicator.textContent = configData.modes[currentMode]?.name || currentMode;
    }
  }

  function addSystemMessage(text) {
    const div = document.createElement('div');
    div.style.cssText = 'text-align: center; color: #888; font-size: 13px; padding: 8px;';
    div.textContent = '✦ ' + text + ' ✦';
    messagesContainer.appendChild(div);
    scrollToBottom();
  }

  // ========== 模式切换 ==========
  function switchMode(mode) {
    if (mode === currentMode) return;
    saveConversations();
    currentMode = mode;
    const savedConversations = localStorage.getItem('conversations_' + mode);
    if (savedConversations) {
      conversations = JSON.parse(savedConversations);
    } else {
      conversations = [createNewConversation()];
    }
    currentConversationId = conversations[0].id;
    updateModeIndicator();
    renderHistoryList();
    renderMessages();
    addSystemMessage('Switched to：' + (configData.modes[mode]?.name || mode));
  }

  // ========== 渲染函数 ==========
  function renderHistoryList() {
    historyList.innerHTML = '';
    conversations.forEach(conv => {
      const li = document.createElement('li');
      const titleSpan = document.createElement('span');
      titleSpan.textContent = conv.title;
      titleSpan.style.flex = '1';
      titleSpan.style.overflow = 'hidden';
      titleSpan.style.textOverflow = 'ellipsis';
      titleSpan.style.whiteSpace = 'nowrap';
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '×';
      deleteBtn.style.cssText = 'background: none; border: none; color: #888; font-size: 16px; cursor: pointer; padding: 0 4px; margin-left: 8px; border-radius: 4px; display: none; line-height: 1;';
      deleteBtn.title = 'Delete this conversation';
      li.addEventListener('mouseenter', () => { deleteBtn.style.display = 'inline-block'; });
      li.addEventListener('mouseleave', () => { deleteBtn.style.display = 'none'; });
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = conversations.findIndex(c => c.id === conv.id);
        if (index !== -1) {
          conversations.splice(index, 1);
          if (conversations.length === 0) conversations.push(createNewConversation());
          if (currentConversationId === conv.id) currentConversationId = conversations[0].id;
          saveConversations();
          renderHistoryList();
          renderMessages();
        }
      });
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display: flex; align-items: center; width: 100%;';
      wrapper.appendChild(titleSpan);
      wrapper.appendChild(deleteBtn);
      li.appendChild(wrapper);
      li.dataset.id = conv.id;
      if (conv.id === currentConversationId) li.classList.add('active');
      li.addEventListener('click', () => { switchConversation(conv.id); });
      historyList.appendChild(li);
    });
  }

  function switchConversation(convId) {
    currentConversationId = convId;
    renderHistoryList();
    renderMessages();
  }

  function renderMessages() {
    const conv = getCurrentConversation();
    if (!conv) return;
    messagesContainer.innerHTML = '';
    conv.messages.forEach(msg => {
      appendMessageToDOM(msg.role, msg.content, msg.typing);
    });
    scrollToBottom();
  }

  function appendMessageToDOM(role, content, typing = false) {
    const div = document.createElement('div');
    div.classList.add('message');
    div.classList.add(role);
    if (typing) {
      div.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    } else {
      let clean = content || '';
      clean = filterThinkTags(clean);
      div.innerHTML = renderMessageHTML(clean);
    }
    messagesContainer.appendChild(div);
    scrollToBottom();
    return div;
  }

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function updateLastAssistantMessage(content, typing = false) {
    const messages = messagesContainer.querySelectorAll('.message.assistant');
    if (messages.length === 0) return;
    const lastMsgDiv = messages[messages.length - 1];
    if (typing) {
      lastMsgDiv.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    } else {
      let clean = content || '';
      clean = filterThinkTags(clean);
      lastMsgDiv.innerHTML = renderMessageHTML(clean);
    }
    scrollToBottom();
  }

  // 流式期间轻量更新：只改纯文本，不做 KaTeX/Markdown 富渲染
  // （逐 chunk 全量重渲染是主线程卡死的元凶，公式越多越严重）
  function updateLastAssistantText(content) {
    const messages = messagesContainer.querySelectorAll('.message.assistant');
    if (messages.length === 0) return;
    const lastMsgDiv = messages[messages.length - 1];
    if (lastMsgDiv.querySelector('.typing-indicator')) {
      lastMsgDiv.innerHTML = '';   // 移除打字动画
    }
    lastMsgDiv.textContent = content || '';
    scrollToBottom();
  }

  // ========== 过滤 <think> 标签 ==========
  function filterThinkTags(text) {
    if (!text) return '';
    let r = text;
    while (r.includes('<think') || r.includes('</think>')) {
      const s = r.indexOf('<think');
      if (s === -1) break;
      const e = r.indexOf('</think>', s);
      if (e === -1) { r = r.substring(0, s); break; }
      r = r.substring(0, s) + r.substring(e + 8);
    }
    return r;
  }

  // ========== 消息渲染（Markdown + KaTeX，占位符策略防冲突） ==========
  function renderMessageHTML(text) {
    if (!text) return '';

    // 1. HTML 转义
    let result = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 2. 先提取公式 → 渲染成 KaTeX HTML → 换成占位符
    const formulas = [];
    if (window.katex) {
      // 显示公式 $$...$$
      result = result.replace(/\$\$([\s\S]*?)\$\$/g, (match, formula) => {
        try {
          formulas.push(katex.renderToString(formula.trim(), { displayMode: true, throwOnError: false }));
          return `@@FORMULA_${formulas.length - 1}@@`;
        } catch (e) { return match; }
      });
      // 显示公式 \[...\]
      result = result.replace(/\\\[([\s\S]*?)\\\]/g, (match, formula) => {
        try {
          formulas.push(katex.renderToString(formula.trim(), { displayMode: true, throwOnError: false }));
          return `@@FORMULA_${formulas.length - 1}@@`;
        } catch (e) { return match; }
      });
      // 内联公式 $...$
      result = result.replace(/\$([\s\S]*?)\$/g, (match, formula) => {
        try {
          formulas.push(katex.renderToString(formula.trim(), { displayMode: false, throwOnError: false }));
          return `@@FORMULA_${formulas.length - 1}@@`;
        } catch (e) { return match; }
      });
      // 内联公式 \(...\)
      result = result.replace(/\\\(([\s\S]*?)\\\)/g, (match, formula) => {
        try {
          formulas.push(katex.renderToString(formula.trim(), { displayMode: false, throwOnError: false }));
          return `@@FORMULA_${formulas.length - 1}@@`;
        } catch (e) { return match; }
      });
    }

    // 3. Markdown 转换（加粗、斜体、代码块、标题、列表、换行）
    result = renderMarkdown(result);

    // 4. 恢复公式占位符
    result = result.replace(/@@FORMULA_(\d+)@@/g, (match, idx) => {
      return formulas[parseInt(idx)] || match;
    });

    return result;
  }

  // ========== 轻量 Markdown 渲染 ==========
  function renderMarkdown(text) {
    if (!text) return '';
    let r = text;

    // 代码块（先提取，防止内部被转换）
    const codeBlocks = [];
    r = r.replace(/```([\s\S]*?)```/g, (match, code) => {
      codeBlocks.push(`<pre class="code-block"><code>${code}</code></pre>`);
      return `@@CODE_${codeBlocks.length - 1}@@`;
    });
    // 行内代码
    r = r.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // 加粗 **text**（不跨行）
    r = r.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

    // 标题
    r = r.replace(/^###\s+(.+)$/gm, '<h4>$1</h4>');
    r = r.replace(/^##\s+(.+)$/gm, '<h3>$1</h3>');
    r = r.replace(/^#\s+(.+)$/gm, '<h2>$1</h2>');

    // 无序列表 - item
    r = r.replace(/^[-•]\s+(.+)$/gm, '<li>$1</li>');
    r = r.replace(/(<li>[\s\S]*?<\/li>)(?:\n|$)/g, '<ul>$1</ul>');

    // 换行：双换行 → 段落，单换行 → <br>
    const paragraphs = r.split(/\n{2,}/);
    r = paragraphs.map(p => {
      p = p.trim();
      if (!p) return '';
      // 已是块级元素或占位符，不再包 <p>
      if (p.startsWith('<h') || p.startsWith('<ul') || p.startsWith('<pre') || p.startsWith('@@')) {
        return p;
      }
      p = p.replace(/\n/g, '<br>');
      return `<p>${p}</p>`;
    }).join('');

    // 恢复代码块
    r = r.replace(/@@CODE_(\d+)@@/g, (match, idx) => codeBlocks[parseInt(idx)] || match);

    return r;
  }

  // ========== 对话管理 ==========
  function newChat() {
    const newConv = createNewConversation();
    conversations.unshift(newConv);
    currentConversationId = newConv.id;
    saveConversations();
    renderHistoryList();
    renderMessages();
  }

  function updateConversationTitle(conv) {
    const firstUserMsg = conv.messages.find(m => m.role === 'user');
    if (firstUserMsg) {
      conv.title = firstUserMsg.content.substring(0, 20) + (firstUserMsg.content.length > 20 ? '...' : '');
    }
    saveConversations();
    renderHistoryList();
  }

  // ========== 清理回答 ==========
  function cleanReply(text) {
    if (!text) return '';
    let r = text;
    r = filterThinkTags(r);
    r = r.replace(/<[^>]*>/g, '');
    r = r.replace(/\n{3,}/g, '\n\n').trim();
    r = r.replace(/^[\s\n]*/, '');
    return r;
  }

  // ========== 计划模式判定 ==========
  function shouldUsePlanMode(text) {
    if (!planMode) return false;
    // 单动作（打开/启动/关闭）走快速模式，不弹计划
    if (/^(帮我)?(打开|启动|关闭|暂停|停止)/.test(text.trim())) return false;
    // 多步自动化任务 → 计划模式
    return /(自动|流程|依次|然后|批量|帮我完成|一系列|帮我操作|操作一下|执行以下|写文件|保存文件)/.test(text);
  }
  // ========== 发送消息（流式） ==========
  async function sendMessage() {
    approveAllRemaining = false;  // 每次新任务重置
    if (isSending) return;        // 流式期间禁发
    const text = userInput.value.trim();
    const usePlan = shouldUsePlanMode(text);
    if (!text) return;
    if (!configData || !configData.deepseek_api_key || configData.deepseek_api_key === 'sk-把你的DeepSeekAPIKey填在这里') {
      alert('请先在 config.json 中配置 DeepSeek API Key');
      return;
    }

    const conv = getCurrentConversation();

    // 旧会话（历史 localStorage 数据）可能没有 session_id → 补一个并随本次 saveConversations 落库
    if (!conv.session_id) {
      conv.session_id = generateSessionId();
    }

    // 1. 添加用户消息到数据 + DOM
    conv.messages.push({ role: 'user', content: text });
    userInput.value = '';
    appendMessageToDOM('user', text);
    updateConversationTitle(conv);

    // 2. 添加助理占位消息到数据 + DOM
    conv.messages.push({ role: 'assistant', content: '', typing: true });
    appendMessageToDOM('assistant', '', true);
    
    // 【修复】先保存到 localStorage，供历史构建用
    // 注意助手消息还没回复，所以要排除占位消息
    saveConversations();

    const sharedMemoryText = getAllSharedMemoryText();

    // 3. 构造历史消息（截断：保留最近约 30 轮 或 ~8000 字符，
    //    超出部分由服务端 L1/L2 记忆层补充，避免请求体无限膨胀）
    const MAX_HISTORY_TURNS = 30;
    const MAX_HISTORY_CHARS = 8000;
    const allHistory = [];
    for (const msg of conv.messages) {
      if (msg.role === 'user' && msg.content === text) continue;  // 跳过当前用户消息
      if ((msg.role === 'user' || msg.role === 'assistant') && msg.content && msg.content.length > 0) {
        allHistory.push({ role: msg.role, content: msg.content });
      }
    }
    // 从最新往旧截断，同时受轮数与字符数双重约束（至少保留 1 条）
    const historyMessages = [];
    let totalChars = 0;
    for (let i = allHistory.length - 1; i >= 0 && historyMessages.length < MAX_HISTORY_TURNS; i--) {
      const m = allHistory[i];
      const nextChars = totalChars + m.content.length;
      if (historyMessages.length > 0 && nextChars > MAX_HISTORY_CHARS) break;
      historyMessages.push(m);
      totalChars = nextChars;
    }
    historyMessages.reverse();

    console.log('[Debug] history:', JSON.stringify(historyMessages));
    
    isSending = true;
    sendBtn.disabled = true;
    if (sendStatusEl) sendStatusEl.textContent = 'AI 生成中…';
    
    let timeoutId = null;
    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), usePlan ? 420000 : 90000);

      // === 【调试】看看到底发了什么 ===
      console.log('[Send]', JSON.stringify({
        query: text,
        mode: currentMode,
        history: historyMessages,
      }));
      
      const response = await fetch(`${AI_SERVICE_URL}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': authToken,
        },
        body: JSON.stringify({
          query: text,
          mode: currentMode,
          history: historyMessages,
          session_id: conv.session_id,   // 新增：会话 UUID，服务端直接使用
          shared_memory: sharedMemoryText,
          plan_mode: usePlan,    
          // 不再传 skip_tools！服务端始终启用工具
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      
      // 4. 流式读取 + 处理工具确认
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullAnswer = '';
      let readBuffer = '';
      let streamDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        readBuffer += chunk;

        const lines = readBuffer.split('\n');
        readBuffer = lines.pop() || ''; // 保留不完整的行

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // [DONE] = 服务端回复完毕 → 立即收尾。
          // 不能等 EOF：连接可能因后台写库迟迟不关闭，等了就卡"生成中"
          if (trimmed === 'data: [DONE]') {
            streamDone = true;
            await reader.cancel();
            break;
          }

          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.substring(6);
            try {
              const data = JSON.parse(dataStr);

              if (data.type === 'tool_call') {
                // 不阻塞 SSE 流：对话框独立弹窗，点击时再发 /tool-approve 或 /tool-deny
                showToolConfirmation(data.request_id, data.tool_calls);
                continue;
              }
              // === OOC 警告 ===
              if (data.type === 'ooc_warning') {
                showOOCWarning(data.warning, data.score);
                continue;
              }
              // === 计划模式事件 ===
              if (data.type === 'plan_generating') {
                updateLastAssistantMessage('正在生成执行计划…', true);
                continue;
              }
              if (data.type === 'tool_plan') {
                showPlanDialog(data.plan_id, data.goal, data.steps, false);
                continue;
              }
              if (data.type === 'plan_revision') {
                showPlanDialog(data.plan_id, data.goal, data.steps, true);
                continue;
              }
              if (data.type === 'plan_deviation') {
                showDeviationDialog(data.plan_id, data.tool_calls);
                continue;
              }
              if (data.type === 'plan_approved') {
                appendSystemNote('计划已批准，开始执行…');
                continue;
              }
              if (data.type === 'plan_rejected') {
                appendSystemNote('已拒绝执行计划');
                continue;
              }
              if (data.type === 'plan_aborted') {
                appendSystemNote((data.reason || '执行已中止'));
                continue;
              }

              // === 正常回答内容 ===
              if (data.answer) {
                fullAnswer += data.answer;
                // 同步更新 conv.messages 里的内容
                if (conv.messages.length > 0) {
                  const lastAssistant = conv.messages[conv.messages.length - 1];
                  if (lastAssistant.role === 'assistant') {
                    lastAssistant.content = fullAnswer;
                  }
                }
                updateLastAssistantMessage(filterThinkTags(fullAnswer));
              }
              if (data.error) {
                console.error('[AI] 服务返回错误:', data.answer);
              }
            } catch (e) { }
          }
        }
        if (streamDone) break;   // 收到 [DONE] 立即跳出外层 while
      }

      let finalAnswer = cleanReply(fullAnswer);
      if (!finalAnswer.trim()) finalAnswer = '抱歉，我暂时无法回答。';

      // 5. 更新对话数据
      const lastMsg = conv.messages[conv.messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.content = finalAnswer;
        lastMsg.typing = false;
      }
      updateLastAssistantMessage(finalAnswer, false);
      saveConversations();

      // 6. TTS 语音播报（只在开关打开时调用）
      if (ttsSwitch.checked) {
        speakText(finalAnswer);
      }

    } catch (error) {
      console.error('请求失败：', error);
      let errMsg = '网络请求失败';
      if (error.name === 'AbortError') {
        errMsg = 'AI 服务响应超时（超过90秒），请重试';
      } else if (error.message.includes('Failed to fetch') || error.message.includes('ERR_CONNECTION_REFUSED')) {
        errMsg = '无法连接 AI 服务（127.0.0.1:18892），请确保 ai_service.py 已启动';
      } else if (error.message.includes('500')) {
        errMsg = 'AI 服务内部错误，请查看终端日志';
      } else {
        errMsg = 'AI 服务错误：' + error.message;
      }
      updateLastAssistantMessage(errMsg, false);
      const lastMsg = conv.messages[conv.messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.content = errMsg;
        lastMsg.typing = false;
      }
      saveConversations();
    } finally {
      isSending = false;
      sendBtn.disabled = false;
      if (sendStatusEl) sendStatusEl.textContent = '';
      if (timeoutId) clearTimeout(timeoutId);   // ← null 安全
    }
  }

  // ========== 工具调用确认框（逐工具批准 + 全局快捷键 F8/F7/F9） ==========
  async function showToolConfirmation(requestId, toolCalls) {
    // 窗口不在前台时额外发系统通知提示，但页内确认框照常弹出（不再 return）
    if (!document.hasFocus() && window.electronAPI && window.electronAPI.notifyToolConfirm) {
      window.electronAPI.notifyToolConfirm({ requestId, toolCalls });
    }

    // 本次任务"剩余全部允许"已开启：非高风险工具直接批准，不弹窗
    const normal = toolCalls.filter(tc => !tc.t3);
    const risky = toolCalls.filter(tc => tc.t3);
    if (approveAllRemaining) {
      await Promise.all(normal.map(tc =>
        fetch(`${AI_SERVICE_URL}/tool-approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
          body: JSON.stringify({ request_id: requestId, tool_call_id: tc.tool_call_id })
        }).catch(() => {})
      ));
      if (risky.length === 0) return;   // 全部自动批准，无需弹窗
      toolCalls = risky;                // 只剩高风险工具还要确认
    }

    return new Promise((resolve) => {
      // 如果已经有确认框，先移除
      const oldOverlay = document.querySelector('.tool-confirm-overlay');
      if (oldOverlay) oldOverlay.remove();

      const overlay = document.createElement('div');
      overlay.className = 'tool-confirm-overlay';

      let toolListHTML = '';
      toolCalls.forEach(tc => {
        const desc = tc.description || `${tc.name} ${JSON.stringify(tc.args || {})}`;
        const riskBadge = tc.t3 ? '<span style="color:#f87171;font-size:11px;margin-left:6px;">[高风险]</span>' : '';
        toolListHTML += `
          <div class="tool-confirm-item">
            <div class="tool-confirm-icon">${tc.t3 ? '⚠️' : '🛠'}</div>
            <div class="tool-confirm-desc">
              <div class="tool-confirm-name">${escapeHtml(tc.name)}${riskBadge}</div>
              <div>${escapeHtml(desc)}</div>
            </div>
            <div class="tool-confirm-actions">
              <button class="tool-confirm-btn tool-confirm-btn-no" data-id="${escapeHtml(tc.tool_call_id)}">拒绝</button>
              <button class="tool-confirm-btn tool-confirm-btn-yes" data-id="${escapeHtml(tc.tool_call_id)}">允许</button>
            </div>
          </div>
        `;
      });

      overlay.innerHTML = `
        <div class="tool-confirm-dialog">
          <div class="tool-confirm-header">🔧 爱弥斯想执行以下操作</div>
          <div class="tool-confirm-body">${toolListHTML}</div>
          <div class="tool-confirm-timeout">⌨ 全局键（无需切窗口）：<b>F8</b> 全部允许 · <b>F7</b> 全部拒绝 · <b>F9</b> 剩余全部允许 · 60秒未操作自动拒绝</div>
        </div>
      `;

      document.body.appendChild(overlay);

      let pending = toolCalls.length;
      const decided = new Set();

      const finishIfDone = () => {
        if (pending <= 0) {
          currentConfirmActions = null;
          overlay.remove();
          resolve(true);
        }
      };

      const approveOne = async (toolCallId) => {
        if (decided.has(toolCallId)) return;
        decided.add(toolCallId);
        pending--;
        const btn = overlay.querySelector(`.tool-confirm-btn-yes[data-id="${CSS.escape(toolCallId)}"]`);
        if (btn) { btn.disabled = true; btn.style.opacity = '0.4'; }
        await fetch(`${AI_SERVICE_URL}/tool-approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
          body: JSON.stringify({ request_id: requestId, tool_call_id: toolCallId })
        }).catch(() => {});
        finishIfDone();
      };

      const denyOne = async (toolCallId) => {
        if (decided.has(toolCallId)) return;
        decided.add(toolCallId);
        pending--;
        const btn = overlay.querySelector(`.tool-confirm-btn-no[data-id="${CSS.escape(toolCallId)}"]`);
        if (btn) { btn.disabled = true; btn.style.opacity = '0.4'; }
        await fetch(`${AI_SERVICE_URL}/tool-deny`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
          body: JSON.stringify({ request_id: requestId, tool_call_id: toolCallId })
        }).catch(() => {});
        finishIfDone();
      };

      // 自动拒绝计时：所有未决定的工具默认拒绝
      const timeoutId = setTimeout(async () => {
        toolCalls.forEach((tc) => {
          if (!decided.has(tc.tool_call_id)) {
            fetch(`${AI_SERVICE_URL}/tool-deny`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
              body: JSON.stringify({ request_id: requestId, tool_call_id: tc.tool_call_id })
            }).catch(() => {});
          }
        });
        currentConfirmActions = null;
        overlay.remove();
        resolve(true);
      }, 60000);

      // 页内确认框：注册快捷键委托（F8/F7/F9 由 init 里的常驻监听转发到这里）
      currentConfirmActions = {
        approve: () => toolCalls.forEach(tc => { if (!decided.has(tc.tool_call_id)) approveOne(tc.tool_call_id); }),
        deny:    () => toolCalls.forEach(tc => { if (!decided.has(tc.tool_call_id)) denyOne(tc.tool_call_id); }),
        'approve-all': () => {
          approveAllRemaining = true;
          toolCalls.forEach(tc => { if (!decided.has(tc.tool_call_id) && !tc.t3) approveOne(tc.tool_call_id); });
        },
      };

      // 按钮事件：委托处理
      overlay.querySelectorAll('.tool-confirm-btn').forEach(btn => {
        btn.onclick = async () => {
          const toolCallId = btn.dataset.id;
          if (decided.has(toolCallId)) return;
          const isApprove = btn.classList.contains('tool-confirm-btn-yes');
          if (isApprove) await approveOne(toolCallId);
          else await denyOne(toolCallId);
        };
      });
    });
  }


  // ========== 系统提示条 ==========
  function appendSystemNote(text) {
    const note = document.createElement('div');
    note.className = 'message assistant';
    note.style.cssText = 'color:#94a3b8;font-size:13px;padding:4px 12px;';
    note.textContent = text;
    messagesContainer.appendChild(note);
  }

  // ========== 计划确认框（整份计划一次批准） ==========
  async function showPlanDialog(planId, goal, steps, isRevision) {
    const old = document.querySelector('.plan-confirm-overlay');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.className = 'tool-confirm-overlay plan-confirm-overlay';

    const tierMeta = [
      ['无副作用', '#34d399'],
      ['轻微', '#60a5fa'],
      ['中等', '#fbbf24'],
      ['高风险', '#f87171']
    ];
    const stepCards = (steps || []).map(s => {
      const tier = Math.min(Math.max(s.risk_tier || 1, 0), 3);
      const [tierLabel, tierColor] = tierMeta[tier];
      return `
        <div class="tool-confirm-item">
          <div class="tool-confirm-icon">${tier >= 3 ? '⚠️' : '🔧'}</div>
          <div class="tool-confirm-desc">
            <div class="tool-confirm-name">${escapeHtml(s.tool)} <span style="color:${tierColor};font-size:11px;margin-left:6px;">[${tierLabel}]</span></div>
            <div style="font-size:13px;">${escapeHtml(JSON.stringify(s.args || {}))}</div>
            <div style="color:#94a3b8;font-size:12px;">预期: ${escapeHtml(s.expected || '—')}</div>
          </div>
        </div>`;
    }).join('');

    overlay.innerHTML = `
      <div class="tool-confirm-dialog" style="max-width:540px;">
        <div style="padding:8px 16px;font-size:13px;color:#94a3b8;display:flex;align-items:center;gap:8px;">
        <input type="checkbox" id="plan-loose-cb" checked> 批准后自动执行，不再逐步骤询问（运行代码 / 写文件除外）
        </div>
        <div class="tool-confirm-header">${isRevision ? '🔄 修订后的执行计划' : '📋 AI 的执行计划'}</div>
        <div style="padding:10px 16px;font-size:14px;color:#cbd5e1;">${escapeHtml(goal || '')}</div>
        <div class="tool-confirm-body" style="max-height:60vh;overflow-y:auto;">${stepCards}</div>
        <div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 16px;">
          <button class="tool-confirm-btn tool-confirm-btn-no" id="plan-reject-btn">${isRevision ? '拒绝并停止' : '拒绝'}</button>
          <button class="tool-confirm-btn tool-confirm-btn-yes" id="plan-approve-btn">批准执行</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#plan-approve-btn').onclick = async () => {
      const loose = overlay.querySelector('#plan-loose-cb')?.checked ?? false;
      await fetch(`${AI_SERVICE_URL}/plan-approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
        body: JSON.stringify({ plan_id: planId, loose })
      }).catch(() => {});
      overlay.remove();
    };
  }

  // ========== 计划外操作警告（偏离计划） ==========
  async function showDeviationDialog(planId, toolCalls) {
    const old = document.querySelector('.deviation-overlay');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.className = 'tool-confirm-overlay deviation-overlay';

    const items = (toolCalls || []).map(tc => `
      <div class="tool-confirm-item">
        <div class="tool-confirm-icon"></div>
        <div class="tool-confirm-desc">
          <div class="tool-confirm-name">${escapeHtml(tc.name)}</div>
          <div>${escapeHtml(tc.description || JSON.stringify(tc.args || {}))}</div>
        </div>
      </div>`).join('');

    overlay.innerHTML = `
      <div class="tool-confirm-dialog" style="max-width:480px;border-color:#fbbf24;">
        <div class="tool-confirm-header" style="color:#fbbf24;">AI 偏离了已批准的计划</div>
        <div style="padding:8px 16px;font-size:13px;color:#94a3b8;">它请求执行以下计划外的操作：</div>
        <div class="tool-confirm-body">${items}</div>
        <div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 16px;">
          <button class="tool-confirm-btn tool-confirm-btn-no" id="dev-stop-btn">停止</button>
          <button class="tool-confirm-btn" id="dev-replan-btn" style="background:#fbbf24;color:#1e293b;">重新规划</button>
          <button class="tool-confirm-btn tool-confirm-btn-yes" id="dev-continue-btn">仅此一次，继续</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const send = (decision) => fetch(`${AI_SERVICE_URL}/plan-deviation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': authToken },
      body: JSON.stringify({ plan_id: planId, decision })
    }).catch(() => {});

    overlay.querySelector('#dev-stop-btn').onclick = async () => { await send('stop'); overlay.remove(); };
    overlay.querySelector('#dev-replan-btn').onclick = async () => { await send('replan'); overlay.remove(); };
    overlay.querySelector('#dev-continue-btn').onclick = async () => { await send('continue'); overlay.remove(); };
  }

    // HTML 转义（防止 args 里有 HTML 标签）
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // ========== OOC 警告显示 ==========
    function showOOCWarning(warning, score) {
      const messages = messagesContainer.querySelectorAll('.message.assistant');
      if (messages.length === 0) return;
      const lastMsgDiv = messages[messages.length - 1];
      
      // 移除旧警告
      const oldWarning = lastMsgDiv.querySelector('.ooc-warning');
      if (oldWarning) oldWarning.remove();
      
      const warnDiv = document.createElement('div');
      warnDiv.className = 'ooc-warning';
      const color = score < 4 ? '#f87171' : '#fbbf24';
      const level = score < 4 ? '严重越界' : '轻微越界';
      warnDiv.style.borderColor = color;
      warnDiv.style.color = color;
      warnDiv.innerHTML = `⚠️ <strong>角色一致性 ${level}</strong>（评分 ${score}/10）<br>${escapeHtml(warning)}`;
      lastMsgDiv.appendChild(warnDiv);
    }

    // ========== 语音识别 ==========
    function initSpeechRecognition() {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        alert('Browser speech recognition not supported');
        return null;
      }
      const recog = new SpeechRecognition();
      recog.lang = 'zh-CN';
      recog.interimResults = false;
      recog.continuous = false;
      return recog;
    }

    function startRecording() {
      if (!recognition) {
        recognition = initSpeechRecognition();
        if (!recognition) return;
        recognition.addEventListener('result', (event) => {
          userInput.value = event.results[0][0].transcript;
        });
        recognition.addEventListener('error', (event) => {
          console.error('语音识别错误:', event.error);
          stopRecording();
        });
        recognition.addEventListener('end', () => { stopRecording(); });
      }
      recognition.start();
      isRecording = true;
      micBtn.classList.add('recording');
      micBtn.textContent = '⏹️';
    }

    function stopRecording() {
      if (recognition) recognition.stop();
      isRecording = false;
      micBtn.classList.remove('recording');
      micBtn.textContent = '🎤';
    }

    function toggleRecording() {
      if (isRecording) stopRecording();
      else startRecording();
    }

    // ========== 绑定事件 ==========
    sendBtn.addEventListener('click', sendMessage);
    micBtn.addEventListener('click', toggleRecording);
    newChatBtn.addEventListener('click', newChat);
    userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    modeToggleBtn.addEventListener('click', () => {
      const nextMode = currentMode === 'aemeath' ? 'physicist' : 'aemeath';
      switchMode(nextMode);
    });
    // ========== TTS 暖机监测（后台自动检测，不影响使用） ==========
    let ttsWarmedUp = false;
    const ttsStatusEl = document.getElementById('tts-status');

    async function warmupTTS() {
      if (!ttsStatusEl) return;
      // 最多检查 2 分钟（24次 × 5秒）
      for (let i = 0; i < 24; i++) {
        try {
          const resp = await fetch('http://127.0.0.1:18900/health', {
            signal: AbortSignal.timeout(3000),
            headers: { 'X-Auth-Token': authToken }
          });
          const data = await resp.json();
          if (data.engine_loaded === true) {
            ttsWarmedUp = true;
            ttsStatusEl.textContent = '✔';
            ttsStatusEl.style.color = '#34d399';
            ttsStatusEl.title = 'TTS 已就绪';
            console.log('[TTS] 暖机完成');
            return;
          }
        } catch (e) {
          // 服务还没起来，继续等
        }
        ttsStatusEl.textContent = '⟳';
        ttsStatusEl.title = 'TTS 加载中...';
        await new Promise(r => setTimeout(r, 5000));
      }
      // 超时
      ttsStatusEl.textContent = '!';
      ttsStatusEl.style.color = '#f87171';
      ttsStatusEl.title = 'TTS 服务未就绪';
      console.log('[TTS] 暖机超时');
    }

    // ===== 启动 =====
    init();
});