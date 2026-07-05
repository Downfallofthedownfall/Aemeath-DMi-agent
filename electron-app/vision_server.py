# ============================================================
# vision_server.py - YOLO + OCR 视觉识别 HTTP 服务
# 端口：18901
# ============================================================

import os, sys, json, io, tempfile, uuid, base64, traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
import numpy as np

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

# 导入依赖
try:
    from ultralytics import YOLO
    import cv2
    import numpy as np
    from PIL import Image
    import mss
except ImportError as e:
    print(f"缺少依赖: {e}，请运行: pip install ultralytics opencv-python pillow mss")
    sys.exit(1)

# 加载 YOLO 模型
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'yolov8n.pt')
if os.path.exists(MODEL_PATH):
    print("正在加载 YOLOv8 模型...")
    model = YOLO(MODEL_PATH)
    print("YOLOv8 模型加载完成！")
else:
    print(f"YOLO 模型不存在 ({MODEL_PATH})，检测端点不可用")
    model = None

COCO_CLASSES = [
    'person','bicycle','car','motorcycle','airplane','bus','train','truck','boat',
    'traffic light','fire hydrant','stop sign','parking meter','bench','bird','cat',
    'dog','horse','sheep','cow','elephant','bear','zebra','giraffe','backpack',
    'umbrella','handbag','tie','suitcase','frisbee','skis','snowboard','sports ball',
    'kite','baseball bat','baseball glove','skateboard','surfboard','tennis racket',
    'bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple',
    'sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair',
    'couch','potted plant','bed','dining table','toilet','tv','laptop','mouse',
    'remote','keyboard','cell phone','microwave','oven','toaster','sink',
    'refrigerator','book','clock','vase','scissors','teddy bear','hair drier','toothbrush'
]


class VisionHandler(BaseHTTPRequestHandler):

    def do_GET(self):
        if self.path == '/health':
            self.send_json(200, {"status": "ok", "yolo": model is not None})
        else:
            self.send_json(404, {"error": "not found"})

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

    # ===== YOLO 截图检测 =====
    def handle_detect_screen(self):
        if model is None:
            self.send_json(400, {"success": False, "error": "YOLO 模型未加载"})
            return

        with mss.mss() as sct:
            monitor = sct.monitors[1]
            screenshot = sct.grab(monitor)
            img = Image.frombytes('RGB', screenshot.size, screenshot.rgb)

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
        summary = "屏幕检测到：" + "；".join(f"{k}: {v}个" for k, v in summary_parts.items()) if summary_parts else "未检测到明显物体"

        self.send_json(200, {
            "success": True,
            "detections": detections[:30],
            "total": len(detections),
            "summary": summary
        })

        # ===== OCR 屏幕文字识别 =====
    def handle_ocr_screen(self):
        # 截图
        with mss.mss() as sct:
            monitor = sct.monitors[1]
            screenshot = sct.grab(monitor)
            img = Image.frombytes('RGB', screenshot.size, screenshot.rgb)

        # 转为灰度 numpy 数组（直接传给 easyocr，不走文件）
        img_gray = np.array(img.convert('L'))

        lines = []
        try:
            import easyocr
            reader = easyocr.Reader(['ch_sim', 'en'], gpu=True)
            results = reader.readtext(img_gray)
            lines = [r[1] for r in results if r[2] > 0.25]
        except ImportError:
            lines = ["OCR 库未安装，请运行: pip install easyocr"]
        except Exception as e:
            lines = [f"OCR 识别失败: {str(e)}"]

        summary = "屏幕上识别到的文字：\n" + "\n".join(lines[:30]) if lines else "未识别到文字"

        self.send_json(200, {
            "success": True,
            "text_lines": lines[:50],
            "total": len(lines),
            "summary": summary
        })

    # ===== 工具函数 =====
    def send_json(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

    def log_message(self, format, *args):
        pass


# ========== 启动 ==========
def main():
    HOST = "0.0.0.0"
    PORT = 18901
    server = HTTPServer((HOST, PORT), VisionHandler)
    print(f"视觉识别服务启动中...")
    print(f"  监听: http://{HOST}:{PORT}")
    print(f"  POST /detect_screen  - YOLO 截图检测")
    print(f"  POST /ocr_screen     - 屏幕文字识别")
    print(f"  GET  /health         - 健康检查")
    print(f"  按 Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务器已停止。")
        server.server_close()

if __name__ == "__main__":
    main()
 # ===== 屏幕场景描述（YOLO + OCR → LLM） =====
def handle_describe_screen(self):
     # 1. 先做 YOLO 检测
    yolo_result = {}
    if model is not None:
        with mss.mss() as sct:
            monitor = sct.monitors[1]
            screenshot = sct.grab(monitor)
            img = Image.frombytes('RGB', screenshot.size, screenshot.rgb)
        img_cv = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
        results = model(img_cv, conf=0.3)
            
        detections = []
        for r in results:
            for box in r.boxes:
                cls_id = int(box.cls[0])
                cls_name = COCO_CLASSES[cls_id] if cls_id < len(COCO_CLASSES) else f'class_{cls_id}'
                conf = float(box.conf[0])
                detections.append(f"{cls_name}(置信度:{round(conf,2)})")
            
        # 统计各类别数量
        counts = {}
        for d in detections:
            name = d.split('(')[0]
            counts[name] = counts.get(name, 0) + 1
        yolo_desc = "；".join([f"{k}: {v}个" for k, v in counts.items()])
    else:
        yolo_desc = "YOLO 未加载"

    # 2. OCR 识别文字
    ocr_lines = []
    try:
        with mss.mss() as sct:
            monitor = sct.monitors[1]
            screenshot = sct.grab(monitor)
            img = Image.frombytes('RGB', screenshot.size, screenshot.rgb)
        img_gray = np.array(img.convert('L'))
        import easyocr
        reader = easyocr.Reader(['ch_sim', 'en'], gpu=True)
        results = reader.readtext(img_gray)
        ocr_lines = [r[1] for r in results if r[2] > 0.25]
    except ImportError:
        ocr_lines = []

    # 3. 拼成描述文本
    scene_text = f"屏幕检测到以下物体：{yolo_desc}。"
    if ocr_lines:
        scene_text += f"屏幕上识别到的文字包括：{'、'.join(ocr_lines[:20])}。"

    self.send_json(200, {
        "success": True,
        "scene_description": scene_text,
        "yolo_objects": yolo_desc,
        "ocr_texts": ocr_lines[:30],
        "total_ocr": len(ocr_lines)
    })

