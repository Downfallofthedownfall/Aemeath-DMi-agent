# ============================================================
# vision_server.py - YOLO + OCR 视觉识别 HTTP 服务
# 端口：18901
# ============================================================

import os
import sys
import json
import io
import time
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

# ===== 限制 OpenBLAS 线程数，防止内存爆炸 =====
os.environ['OPENBLAS_NUM_THREADS'] = '2'
os.environ['OMP_NUM_THREADS'] = '2'
os.environ['MKL_NUM_THREADS'] = '2'

# ===== 修复 Windows 控制台编码 =====
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ===== 导入第三方库 =====
try:
    import torch
    import numpy as np
    import cv2
    from PIL import Image
    import mss
    from ultralytics import YOLO
    import easyocr  # ← 关键！之前漏了这行
except ImportError as e:
    print(f"缺少依赖: {e}")
    print("请运行: pip install torch ultralytics opencv-python pillow mss easyocr")
    sys.exit(1)

# ===== 检查 GPU =====
if torch.cuda.is_available():
    device = 'cuda'
    print("GPU detected, enabling acceleration")
else:
    device = 'cpu'
    print("CUDA not detected, using CPU")

# ===== 加载 YOLO 模型 =====
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'yolov8n.pt')
if os.path.exists(MODEL_PATH):
    print("Loading YOLOv8 model...")
    model = YOLO(MODEL_PATH)
    model.to(device)
    print("YOLOv8 model loaded!")
else:
    print(f"YOLO model not found ({MODEL_PATH}), detection unavailable")
    model = None

# ===== 全局 OCR Reader（单例，只加载一次） =====
ocr_reader = None

def get_ocr_reader():
    """获取或创建全局 OCR reader（懒加载）"""
    global ocr_reader
    if ocr_reader is None:
        print("Loading EasyOCR model (first time, may take a moment)...")
        try:
            ocr_reader = easyocr.Reader(['ch_sim', 'en'], gpu=(device == 'cuda'))
            print("EasyOCR model loaded!")
        except Exception as e:
            print(f"EasyOCR failed to load: {e}")
            ocr_reader = False
    return ocr_reader if ocr_reader is not False else None

# ===== COCO 类别名称 =====
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

# ===== 截取主屏幕 =====
def capture_screen():
    with mss.mss() as sct:
        monitor = sct.monitors[1]
        screenshot = sct.grab(monitor)
        return Image.frombytes('RGB', screenshot.size, screenshot.rgb)


class VisionHandler(BaseHTTPRequestHandler):

    def do_GET(self):
        try:
            if self.path == '/health':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "ok",
                    "yolo": model is not None,
                    "ocr": ocr_reader is not None and ocr_reader is not False
                }).encode('utf-8'))
            else:
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}')
        except Exception:
            pass

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == '/detect_screen':
                self.handle_detect_screen()
            elif parsed.path == '/ocr_screen':
                self.handle_ocr_screen()
            elif parsed.path == '/describe_screen':
                self.handle_describe_screen()
            else:
                self.send_json(404, {"error": "not found"})
        except Exception as e:
            self.send_json(500, {"success": False, "error": str(e), "trace": traceback.format_exc()})

    # ---------- YOLO 检测 ----------
    def handle_detect_screen(self):
        if model is None:
            self.send_json(400, {"success": False, "error": "YOLO not loaded"})
            return

        img = capture_screen()
        img_cv = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
        results = model(img_cv, conf=0.3)

        detections = []
        for r in results:
            for box in r.boxes:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                conf = float(box.conf[0])
                cls_id = int(box.cls[0])
                cls_name = COCO_CLASSES[cls_id] if cls_id < len(COCO_CLASSES) else f'class_{cls_id}'
                detections.append({
                    "class": cls_name,
                    "confidence": round(conf, 2),
                    "bbox": [round(x1), round(y1), round(x2), round(y2)]
                })

        summary_parts = {}
        for d in detections:
            summary_parts[d['class']] = summary_parts.get(d['class'], 0) + 1
        summary = "Screen: " + "；".join(f"{k}: {v}" for k, v in summary_parts.items()) if summary_parts else "No objects detected"

        self.send_json(200, {
            "success": True,
            "detections": detections[:30],
            "total": len(detections),
            "summary": summary
        })

    # ---------- OCR 识别 ----------
    def handle_ocr_screen(self):
        img = capture_screen()
        img_gray = np.array(img.convert('L'))

        reader = get_ocr_reader()
        if reader is None:
            self.send_json(200, {
                "success": True,
                "text_lines": ["OCR unavailable"],
                "total": 0,
                "summary": "OCR not available"
            })
            return

        lines = []
        try:
            results = reader.readtext(img_gray)
            lines = [r[1] for r in results if r[2] > 0.25]
        except Exception as e:
            lines = [f"OCR error: {str(e)}"]

        summary = "Text on screen:\n" + "\n".join(lines[:30]) if lines else "No text detected"

        self.send_json(200, {
            "success": True,
            "text_lines": lines[:50],
            "total": len(lines),
            "summary": summary
        })

    # ---------- 场景描述 ----------
    def handle_describe_screen(self):
        yolo_desc = ""
        if model is not None:
            img = capture_screen()
            img_cv = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
            results = model(img_cv, conf=0.3)
            counts = {}
            for r in results:
                for box in r.boxes:
                    cls_id = int(box.cls[0])
                    cls_name = COCO_CLASSES[cls_id] if cls_id < len(COCO_CLASSES) else f'class_{cls_id}'
                    counts[cls_name] = counts.get(cls_name, 0) + 1
            yolo_desc = "；".join([f"{k}: {v}" for k, v in counts.items()])
            if not yolo_desc:
                yolo_desc = "No objects detected"
        else:
            yolo_desc = "YOLO not loaded"

        ocr_lines = []
        reader = get_ocr_reader()
        if reader is not None:
            try:
                img = capture_screen()
                img_gray = np.array(img.convert('L'))
                results = reader.readtext(img_gray)
                ocr_lines = [r[1] for r in results if r[2] > 0.25]
            except Exception:
                pass

        scene_text = f"Screen objects: {yolo_desc}."
        if ocr_lines:
            scene_text += f" Text: {'、'.join(ocr_lines[:20])}."

        self.send_json(200, {
            "success": True,
            "scene_description": scene_text,
            "yolo_objects": yolo_desc,
            "ocr_texts": ocr_lines[:30],
            "total_ocr": len(ocr_lines)
        })

    # ---------- 工具方法 ----------
    def send_json(self, status, data):
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Headers', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.end_headers()
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))
        except Exception:
            pass

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

    def log_message(self, format, *args):
        pass


# ========== 启动服务 ==========
def main():
    HOST = "127.0.0.1"
    PORT = 18901

    print("Vision service starting...")
    print(f"  Listening: http://{HOST}:{PORT}")
    print(f"  YOLO: {'ready' if model is not None else 'not loaded'}")
    print(f"  Device: {device}")
    print("  Press Ctrl+C to stop")

    while True:
        try:
            server = HTTPServer((HOST, PORT), VisionHandler)
            server.serve_forever()
            break
        except KeyboardInterrupt:
            print("\nServer stopped.")
            server.server_close()
            break
        except Exception as e:
            print(f"Server error ({e}), restarting in 5s...")
            time.sleep(5)
            continue


if __name__ == "__main__":
    main()
