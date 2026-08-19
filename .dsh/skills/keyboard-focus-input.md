---
name: keyboard-focus-input
description: Focus input fields with keyboard navigation (Tab / app shortcuts) instead of OCR screen coordinates — coordinates are often inaccurate and cause failed clicks. / 向应用输入内容时优先用键盘导航（Tab / 应用快捷键）聚焦输入框，不要依赖 OCR 屏幕坐标——坐标定位经常不准导致点击落空、输入失败。
whenToUse: When typing into web/desktop app input fields (GeoGebra, online editors, forms, search boxes), especially when detect_screen/OCR cannot locate the input box or clicking coordinates has no effect. Physics-study scenario: entering expressions into GeoGebra / submitting answers to online homework. / 需要向 Web/桌面应用输入内容时（GeoGebra、在线编辑器、表单、搜索框等），尤其当 detect_screen/OCR 定位不到输入框、或点击坐标后输入无反应时。物理学习场景：向 GeoGebra 输入表达式/向在线作业提交答案。
---
# Keyboard focus for input: don't guess coordinates with OCR
# 键盘聚焦输入：别用 OCR 猜坐标

## Golden rule: do it all in ONE tool call / 铁律：一次请求做完（聚焦 + 输入合并成一次工具调用）

**Focus and input must happen in the SAME `control_keyboard_type` call** (`activate → tabFocus → paste` in one shot). **Never split into two calls ("focus first, then type").** / **聚焦和输入必须在同一次 `control_keyboard_type` 调用里完成**（`activate → tabFocus → 粘贴` 一气呵成），**绝不要拆成"先聚焦、再输入"两次调用**。

Why: every tool call triggers the system approval (bottom-right F5/Toast/permission). **The moment the user clicks the approval, focus leaves the input field** (clicking a notification/button activates the notification center or shifts window focus). If focusing is one call and typing another, by the time the second call runs, focus is gone and input fails. / 原因：每次工具调用都会触发系统审批（右下角 F5/Toast/权限确认）。**用户点击审批的那一刻焦点就会从输入框移走**——如果聚焦是一次调用、输入是另一次调用，审批通过后再来输入时焦点已经丢了，输入必然落空。

How it works: approval happens BEFORE the tool call (pre-execute), and `control_keyboard_type` re-activates the window and re-focuses via tabFocus when it runs — so approval inside one call does not break focus. / 原理：审批发生在工具调用**之前**（pre-execute），而 `control_keyboard_type` 执行时会重新激活窗口并按 tabFocus 重新聚焦，所以**一次调用内审批不会破坏聚焦**。

Safe / 安全写法：
```
✅ control_keyboard_type(text="f(x)=x^2", title="Edge", tabFocus=3)   ← one call / 一次做完
❌ press tab to focus first (triggers approval → focus lost) → then type  / 先聚焦（触发审批 → 焦点已丢）→ 再输入
```

## Priority flow / 优先流程（按顺序，命中即停）

1. **Activate the window** / **激活窗口**：`control_keyboard_type(title="<window title>", ...)` activates the window internally; you can also switch windows with a hotkey first. / 内部会激活窗口；也可先用热键切窗。
2. **Tab focus + input (preferred, one call)** / **Tab 聚焦 + 输入（首选，一次调用）**：pass `tabFocus=N` (N=1~20) — the tool presses Tab N times to move focus into the input box, then pastes. If you don't know N, start at 1 and **retry with a different N after this attempt fails** (each retry is a complete call); Shift+Tab goes backwards (try `control_keyboard_hotkey(['shift','tab'])`). / 直接传 `tabFocus=N`（N=1~20），工具会先按 N 次 Tab 把焦点移进输入框再输入。不知道 N 就从 1 开始，**本次输入失败后**再调整 N 重试（每次都是一次完整调用）；Shift+Tab 可反向。
3. **App shortcut to the input** / **应用快捷键直达**：many apps have an input shortcut (GeoGebra: type `/` or just start typing to open the input; web pages: `ctrl+k` for search). Combine the shortcut and the input into one call (prefix the text with the key sequence). / 把快捷键动作与输入合并到一次调用里（text 前置按键序列）。
4. **Verify** / **输入并验证**：optionally `detect_screen` or screenshot to confirm the content entered the field. / 完成后可选 `detect_screen` 或截图确认内容已进入输入框。

## When to use coordinates / 什么时候才用坐标

**Only after keyboard navigation fails** / **键盘导航失败之后**才考虑 OCR：`detect_screen` to locate the input coordinates → `control_keyboard_type(text, x, y)` click-to-focus then input. Fully-canvas apps or apps without a keyboard focus model (a few desktop programs) are the only cases. / 全 canvas 应用、无键盘焦点模型的应用（少数桌面程序）才属于这种情况。

## Troubleshooting / 失败排查

- Tab pressed but text didn't land / 按了 Tab 但输入没进框：wrong Tab count (focus went elsewhere) → change N or press Shift+Tab once to reset, then retry. / Tab 次数不对（焦点到了别处）→ 换 N 或先按一次 Shift+Tab 复位再试。
- Paste triggered a permission popup / 粘贴触发了权限弹窗：focus is not in the input box (paste landed on page background) → re-focus via step 2. / 焦点不在输入框（粘贴事件落在页面空白处）→ 回到第 2 步重新聚焦。
- Input box can't be focused at all / 输入框完全无法聚焦：check the app supports keyboard input (some canvas apps need a click to activate) → only then use the coordinate approach. / 确认该应用是否支持键盘输入（部分 canvas 应用需要先点击激活）→ 此时才用坐标方案。
