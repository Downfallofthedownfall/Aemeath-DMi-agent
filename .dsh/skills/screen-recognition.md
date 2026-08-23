---
name: screen-recognition
description: Two-tier screen reading: simple tasks use local OCR (ocr_screen / detect_screen); complex visual tasks capture a screenshot (capture_screen) which is attached directly to the vision-capable model. / 两级屏幕识别：简单任务用本地 OCR（ocr_screen / detect_screen）；复杂视觉任务用 capture_screen 截图直接发给支持图片的模型（deepseek-v4-flash-vision-exp / GPT-4o 等）。
whenToUse: When you need to understand the user's screen — read text, locate objects, or analyze diagrams/charts/formulas/handwriting/layouts shown on screen (including physics problems and figures in screenshots). / 需要理解用户屏幕内容时：读文字、找物体、分析屏幕上的图表/公式/手写/布局，或从截图读取题目与图形。
---

# Screen recognition: OCR for simple, screenshot-to-model for complex
# 屏幕识别：简单任务走本地 OCR，复杂任务截图直发模型

## Two-tier rule / 两级铁律

1. **Simple (text / object presence only)** → `ocr_screen` (text) / `detect_screen` (objects): fast, local, no model tokens. / **简单任务**（只要文字、物体存在性）用本地 OCR / YOLO：快、不耗模型 token。
2. **Complex (visual understanding)** → `capture_screen`: the screenshot is saved to the cache (`temp/screenshots/`) AND attached directly to the model as an image — IF the active model supports image input. / **复杂任务**（图表、电路图、几何图形、手写、公式、小字、界面布局、整页文档）用 `capture_screen`：截图存入缓存并作为图片附件直接发给模型。
3. **Model capability gate** / 模型能力门槛: the image only reaches the model when the active model declares image input (`deepseek-v4-flash-vision-exp`, GPT-4o, ...). On a text-only model the image block degrades to a diagnostic text — fall back to `ocr_screen` + `describe_screen`. / 只有声明图片能力的模型才收得到图片；纯文本模型下图片块会降级为提示文本，此时退回 `ocr_screen` + `describe_screen`。

## How to / 怎么做

1. **Pick the tier by the task, not by habit** / 按任务分级，不按习惯：
   - "屏幕上这个标题/报错/按钮/代码写了什么" → `ocr_screen`
   - "屏幕上有没有 XX / 在哪个位置" → `detect_screen`
   - "看看这张电路图/图表/手写/公式/这个界面，然后……" → `capture_screen`
2. **Reuse the cache** / 复用缓存：`capture_screen` 返回缓存文件路径（`temp/screenshots/screen_<时间戳>.png`）。屏幕没变时，后续局部放大/裁剪/再次引用直接基于该路径，不要重复截图。
3. **Reason from the image directly** / 直接看图作答：截图后模型已收到图片（工具结果图片自动附加），无需再让用户重新贴图或描述。

## What NOT to do / 不要做什么

- ❌ 图表/图形/小字/布局不要用 OCR —— 会丢失结构、颜色与位置信息（OCR 只适合纯文字）。
- ❌ 模型能看图时不要用 `describe_screen` —— 它是有损的 YOLO+OCR 合成回退方案。
- ❌ 屏幕没变且有新鲜缓存时不要重复截图 —— 直接用缓存路径。

## Screenshot cache / 截图缓存

- 位置：`temp/screenshots/`（相对仓库根，即 MCP 的 cwd；可用环境变量 `AEMEATH_SCREENSHOT_DIR` 覆盖）。
- 命名：`screen_YYYYMMDD_HHMMSS.png`；自动清理：超过 24 小时或超过 50 张。
- 缓存文件保留全分辨率；模型收到的是其标准缩放视图。极小文字优先用 `ocr_screen`（本地全分辨率）或裁剪局部区域后再发。
