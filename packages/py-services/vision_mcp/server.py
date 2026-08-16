# -*- coding: utf-8 -*-
# ============================================================
# vision_mcp/server.py — 视觉识别 MCP server（自 v1 vision_server.py 移植）
# 工具（dsh 侧名称 mcp__vision__<name>）：
#   detect_screen     YOLOv8 目标检测（主屏幕，COCO 80 类，conf≥0.3）
#   ocr_screen        屏幕 OCR（EasyOCR 中文+英文，置信度>0.25）
#   describe_screen   场景描述（YOLO 物体 + OCR 文字合成一句描述）
# 模型资产：yolov8n.pt 与本文件同目录（自 electron-app/ 迁移）。
# 模型加载策略：YOLO 首次调用懒加载；EasyOCR 首次调用懒加载（v1 同款）。
# 运行：python packages/py-services/vision_mcp/server.py
# ============================================================
import os
import sys
import json
import threading

# ---- 限制 OpenBLAS/线程数，防止内存爆炸（v1 同款） ----
os.environ['OPENBLAS_NUM_THREADS'] = '2'
os.environ['OMP_NUM_THREADS'] = '2'
os.environ['MKL_NUM_THREADS'] = '2'

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mcp_core import McpServer  # noqa: E402

server = McpServer("vision_mcp", "2.0.0-m0")

# ---- 第三方库全部懒加载（MCP 启动零延迟；首次调用才 import + 加载模型） ----
DEVICE = None
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'yolov8n.pt')
_model = None
_ocr_reader = None
_ocr_lock = threading.Lock()      # EasyOCR reader 非线程安全（预热线程 vs 工具调用），readtext 串行化
_ocr_load_lock = threading.Lock()  # 加载互斥（双检锁，防预热与工具调用重复/交错加载）
_deps_lock = threading.Lock()      # 依赖导入互斥（全局赋值 np/cv2/Image/mss/YOLO 防竞争）
_model_lock = threading.Lock()     # YOLO 加载互斥
_model_infer_lock = threading.Lock()  # YOLO 推理互斥（ultralytics predictor 非线程安全）


def _ensure_deps():
    """首次调用时导入 torch/numpy/cv2/PIL/mss/ultralytics（较慢，双检锁防并发竞争）。"""
    global DEVICE, np, cv2, Image, mss, YOLO, HAS_YOLO_LIB  # noqa: PLW0603
    if DEVICE is not None:
        return
    with _deps_lock:
        if DEVICE is not None:
            return
        try:
            import torch
            import numpy as _np
            import cv2 as _cv2
            from PIL import Image as _Image
            import mss as _mss
        except ImportError as e:
            raise RuntimeError(
                f"缺少依赖: {e}（pip install torch ultralytics opencv-python pillow mss easyocr）"
            ) from e
        try:
            from ultralytics import YOLO as _YOLO
            YOLO = _YOLO
            HAS_YOLO_LIB = True
        except ImportError:
            YOLO = None
            HAS_YOLO_LIB = False
            print("[vision_mcp] ultralytics 未安装，detect/describe 不可用", file=sys.stderr)
        np, cv2, Image, mss = _np, _cv2, _Image, _mss
        DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'
        print(f"[vision_mcp] 依赖就绪（device={DEVICE}，yolo={'yes' if HAS_YOLO_LIB else 'no'}）",
              file=sys.stderr)

# ===== COCO 80 类名称（v1 同款） =====
COCO_CLASSES = [
    'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
    'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
    'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
    'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
    'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
    'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
    'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
    'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
    'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
    'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'
]


def _get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                _ensure_deps()
                if not HAS_YOLO_LIB:
                    raise RuntimeError("ultralytics 未安装（pip install ultralytics）")
                if not os.path.exists(MODEL_PATH):
                    raise RuntimeError(f"YOLO 模型不存在: {MODEL_PATH}")
                print(f"[vision_mcp] 加载 YOLOv8（{DEVICE}）…", file=sys.stderr)
                _model = YOLO(MODEL_PATH)
                _model.to(DEVICE)
                print("[vision_mcp] YOLOv8 加载完成", file=sys.stderr)
    return _model
def _get_ocr():
    global _ocr_reader
    if _ocr_reader not in (None, False):
        return _ocr_reader
    with _ocr_load_lock:
        if _ocr_reader not in (None, False):
            return _ocr_reader
        try:
            _ensure_deps()
            import easyocr
            print("[vision_mcp] 加载 EasyOCR（首次，较慢）…", file=sys.stderr)
            _ocr_reader = easyocr.Reader(['ch_sim', 'en'], gpu=(DEVICE == 'cuda'))
            print("[vision_mcp] EasyOCR 加载完成", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            # 置 False 而非保持失败态：允许下次调用重试加载（原实现失败后 OCR 永久失效）
            print(f"[vision_mcp] EasyOCR 加载失败: {e}（下次调用将重试）", file=sys.stderr)
            _ocr_reader = False
    return _ocr_reader if _ocr_reader not in (None, False) else None


def _capture_screen():
    _ensure_deps()
    with mss.mss() as sct:
        monitor = sct.monitors[1]
        shot = sct.grab(monitor)
        return Image.frombytes('RGB', shot.size, shot.rgb)


def _ocr_input_gray(img):
    """截图 → 灰度。EasyOCR 内部按 canvas_size=2560 缩放检测，
    输入分辨率对耗时影响极小（4K 全屏 ≈6s），故不做降采样保识别质量。"""
    return np.array(img.convert('L'))


def _yolo_detections(img_cv):
    model = _get_model()
    with _model_infer_lock:
        results = model(img_cv, conf=0.3)
    detections = []
    for r in results:
        # C21：空屏时 r.boxes 可能为 None（ultralytics 行为），返回空结果而非报错
        if r.boxes is None:
            continue
        for box in r.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            conf = float(box.conf[0])
            cls_id = int(box.cls[0])
            cls_name = COCO_CLASSES[cls_id] if 0 <= cls_id < len(COCO_CLASSES) else f'class_{cls_id}'
            detections.append({
                "class": cls_name,
                "confidence": round(conf, 2),
                "bbox": [round(x1), round(y1), round(x2), round(y2)],
            })
    return detections


def _ocr_lines(img_gray):
    reader = _get_ocr()
    if reader is None:
        return []
    try:
        with _ocr_lock:
            results = reader.readtext(img_gray)
        return [r[1] for r in results if r[2] > 0.25]
    except Exception as e:  # noqa: BLE001
        return [f"OCR error: {e}"]


def _start_warmup():
    """后台预热：模型在首个用户调用前就绪（首调不再等 30-45s）。"""
    def _warm():
        try:
            # stdout 已被 mcp_core.run() 永久重定向到 stderr（进程级、所有线程），
            # 预热线程的库输出不会污染协议通道，无需临时 redirect_stdout。
            _ensure_deps()
            # YOLO 首次推理不在此预热：与工具线程并发首推会触发 ultralytics
            # predictor 懒初始化竞态（self.predictor=None）。YOLO 首次推理
            # 由工具线程串行完成（_model_infer_lock），预热只负责 EasyOCR。
            try:
                # 只加载 reader（检测+识别模型在 init 时装载）。
                # ⚠ 不能在此做空图像 readtext：会把 reader 搞坏（后续 readtext 返回空）。
                _get_ocr()
            except Exception as e:  # noqa: BLE001
                print(f"[vision_mcp] 预热 EasyOCR 失败: {e}", file=sys.stderr)
            print("[vision_mcp] 预热完成（EasyOCR 已就绪）", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"[vision_mcp] 预热异常: {e}", file=sys.stderr)
    threading.Thread(target=_warm, daemon=True, name='vision-warmup').start()


@server.tool(
    "detect_screen",
    "YOLOv8 目标检测：识别当前主屏幕上的物体（COCO 80 类，置信度≥0.3），"
    "返回检测列表（类别/置信度/边框）与汇总。适合回答「屏幕上有什么」。",
    {"type": "object", "properties": {}, "additionalProperties": False},
)
def detect_screen():
    img = _capture_screen()
    img_cv = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
    detections = _yolo_detections(img_cv)
    summary_parts = {}
    for d in detections:
        summary_parts[d['class']] = summary_parts.get(d['class'], 0) + 1
    summary = ("Screen: " + "；".join(f"{k}: {v}" for k, v in summary_parts.items())
               if summary_parts else "No objects detected")
    return {
        "success": True,
        "detections": detections[:30],
        "total": len(detections),
        "summary": summary,
    }


@server.tool(
    "ocr_screen",
    "屏幕 OCR：识别当前主屏幕上的文字（中文+英文，置信度>0.25），"
    "返回文本行列表与汇总。适合读取屏幕上的标题/对话框/代码。",
    {"type": "object", "properties": {}, "additionalProperties": False},
)
def ocr_screen():
    img = _capture_screen()
    img_gray = _ocr_input_gray(img)
    lines = _ocr_lines(img_gray)
    if lines and not (len(lines) == 1 and str(lines[0]).startswith("OCR error")):
        summary = "Text on screen:\n" + "\n".join(lines[:30])
    else:
        summary = "No text detected"
    return {"success": True, "text_lines": lines[:50], "total": len(lines), "summary": summary}


@server.tool(
    "describe_screen",
    "场景描述：结合 YOLO 物体检测与 OCR 文字，生成当前屏幕的一段自然语言描述。",
    {"type": "object", "properties": {}, "additionalProperties": False},
)
def describe_screen():
    # 单次截图复用（YOLO 全分辨率 + OCR 降采样）
    img = None
    try:
        img = _capture_screen()
        img_cv = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
        detections = _yolo_detections(img_cv)
        counts = {}
        for d in detections:
            counts[d['class']] = counts.get(d['class'], 0) + 1
        yolo_desc = "；".join(f"{k}: {v}" for k, v in counts.items()) or "No objects detected"
    except Exception as e:  # noqa: BLE001
        yolo_desc = f"YOLO error: {e}"

    ocr_lines = []
    try:
        img_gray = _ocr_input_gray(img if img is not None else _capture_screen())
        ocr_lines = [ln for ln in _ocr_lines(img_gray) if not str(ln).startswith("OCR error")]
    except Exception:  # noqa: BLE001
        pass

    scene_text = f"Screen objects: {yolo_desc}."
    if ocr_lines:
        scene_text += f" Text: {'、'.join(ocr_lines[:20])}."
    return {
        "success": True,
        "scene_description": scene_text,
        "yolo_objects": yolo_desc,
        "ocr_texts": ocr_lines[:30],
        "total_ocr": len(ocr_lines),
    }


if __name__ == "__main__":
    _start_warmup()  # 后台预热模型，首个用户调用零等待
    server.run()
