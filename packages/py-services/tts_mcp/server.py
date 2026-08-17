# -*- coding: utf-8 -*-
# ============================================================
# tts_mcp/server.py — IndexTTS2 语音合成 MCP server（自 v1 tts_server.py 移植）
# 工具（dsh 侧名称 mcp__tts__tts_generate）：
#   输入 text（可选 voice 参考音频路径）→ 合成 wav
#   输出：写入 <repo>/voices/tts/<uuid>.wav，返回 path/size/duration；
#         需要内联音频时 include_base64=true 返回 base64。
# 运行环境：IndexTTS venv python（torch 2.8 + transformers 4.52）
#   解释器：环境变量 AEMEATH_TTS_PYTHON（未设置回退 D:\index-tts\.venv\Scripts\python.exe）。
#           MCP profile 以系统 python 拉起本脚本时，_maybe_relaunch() 会重新执行到
#           目标解释器（stdin/stdout 管道句柄不变），换机器只需设环境变量。
#   模型目录：环境变量 AEMEATH_TTS_MODEL_DIR（未设置回退 D:\index-tts）。
#   引擎加载：首次调用懒加载（FP16 → FP32 自动回退 + 预热），加锁串行推理。
# ============================================================
import os
import sys
import io
import json
import base64
import gc
import uuid
import threading
import argparse
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# torch 在引擎加载时导入（本服务须在 IndexTTS venv 下运行；懒加载保证 MCP 启动零延迟）

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mcp_core import McpServer  # noqa: E402

server = McpServer("tts_mcp", "2.0.0-m0")

# ============================================================
# HTTP 模式（--http <port>，2026-08-17 新增）：
#   前端「朗读」按钮走 <repo> 3081 host 端点 → 本 HTTP 服务（进程内共享已加载模型）。
#   端点：
#     GET  /health        → {"ok":true,"model_loaded":bool}
#     POST /tts           → {"success":true,"audio_base64":"...","size_bytes":N,...}
#   安全：仅绑定 127.0.0.1；Host 头必须为回环地址（DNS rebinding 防护，S3 同款）；
#   除 /health 外只接受 POST；文本长度由 tts_generate 强制上限。
# ============================================================
TTS_HTTP_PORT = 18896

def _is_loopback_host(host):
    try:
        h = (host or '').split(':')[0].lower()
        return h in ('localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0')
    except Exception:  # noqa: BLE001
        return False

class _TtsHttpHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # 静默访问日志（避免刷屏）
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not _is_loopback_host(self.headers.get('Host', '')):
            self._send(403, {'ok': False, 'error': 'non-loopback host'})
            return
        if self.path.rstrip('/') == '/health':
            self._send(200, {'ok': True, 'model_loaded': _engine is not None, 'pid': os.getpid()})
        else:
            self._send(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        if not _is_loopback_host(self.headers.get('Host', '')):
            self._send(403, {'ok': False, 'error': 'non-loopback host'})
            return
        path = self.path.rstrip('/')
        if path == '/warmup':
            # 懒加载预热：仅加载模型（含内部预热推理），不合成音频。
            # 前端「开启朗读」/首次朗读前调用，期间弹 99% 进度条 popup。
            with _engine_lock:
                if _engine is None:
                    ok = _init_engine()
                else:
                    ok = True
            self._send(200, {'ok': ok, 'model_loaded': _engine is not None})
            return
        if path != '/tts':
            self._send(404, {'ok': False, 'error': 'not found'})
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if length <= 0 or length > 1024 * 1024:
                self._send(400, {'ok': False, 'error': 'bad body size'})
                return
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
            text = str(payload.get('text') or '')
            voice = str(payload.get('voice') or '')
            result = tts_generate(text, voice=voice, include_base64=True)
            self._send(200 if result.get('success') else 400, result)
        except Exception as e:  # noqa: BLE001
            self._send(400, {'ok': False, 'error': str(e)})


def run_http_server(port=TTS_HTTP_PORT):
    """HTTP 模式入口：以本进程（IndexTTS venv，已 _maybe_relaunch）运行。"""
    httpd = ThreadingHTTPServer(('127.0.0.1', port), _TtsHttpHandler)
    print(f'[tts_mcp] HTTP 模式已启动: http://127.0.0.1:{port}/ (共享 IndexTTS2 引擎，首次合成加载模型)', file=sys.stderr)
    httpd.serve_forever()

_engine = None
_engine_lock = threading.Lock()

# 模型目录：优先环境变量 AEMEATH_TTS_MODEL_DIR（经 mcp-client 的父进程环境透传），
# 兜底 D:\index-tts（C7：机器相关路径只留这一处，且可被环境变量覆盖）。
MODEL_DIR = os.environ.get('AEMEATH_TTS_MODEL_DIR', 'D:\\index-tts')

# 输出目录：<repo>/voices/tts/
REPO_ROOT = Path(__file__).resolve().parents[3]
VOICES_DIR = REPO_ROOT / 'voices'
TTS_OUT_DIR = VOICES_DIR / 'tts'

# C22：文本长度上限（与工具描述一致）与内联 base64 音频大小上限（防模型传入
# 超长文本/超大 base64 撑爆响应）。
MAX_TEXT_LEN = 500
MAX_BASE64_BYTES = 3 * 1024 * 1024  # 3MB：超出则返回错误（不内联）
# 输出目录 LRU 上限：voices/tts/ 最多保留的文件数（超出删除最旧，防磁盘无限增长）
MAX_TTS_FILES = 50


def _trim_tts_outputs():
    """voices/tts/ 输出目录 LRU 清理：超出 MAX_TTS_FILES 时删除最旧 wav。"""
    try:
        if not TTS_OUT_DIR.exists():
            return
        files = sorted(
            (f for f in TTS_OUT_DIR.iterdir() if f.is_file() and f.suffix.lower() == '.wav'),
            key=lambda f: f.stat().st_mtime,
        )
        for old in files[:-MAX_TTS_FILES]:
            try:
                old.unlink()
            except OSError:
                pass
    except Exception:  # noqa: BLE001
        pass  # 清理失败不阻塞合成


def _is_voice_allowed(voice_path):
    """C22：参考音频只允许项目 voices/ 或模型目录下的 wav（防模型指向任意已存在路径）。"""
    try:
        p = Path(voice_path).resolve()
        if p.suffix.lower() != '.wav' or not p.exists():
            return False
        allowed_roots = [VOICES_DIR.resolve(), Path(MODEL_DIR).resolve()]
        return any(p == root or root in p.parents for root in allowed_roots)
    except Exception:  # noqa: BLE001
        return False


def _get_default_voice():
    """先找项目 voices/ 目录的 wav，再找模型目录 examples/（v1 同款顺序）。"""
    if VOICES_DIR.exists():
        wavs = [f for f in os.listdir(VOICES_DIR) if f.endswith('.wav')]
        if wavs:
            return os.path.join(VOICES_DIR, wavs[0])
    examples_dir = os.path.join(MODEL_DIR, 'examples')
    if os.path.exists(examples_dir):
        wavs = [f for f in os.listdir(examples_dir) if f.endswith('.wav')]
        if wavs:
            return os.path.join(examples_dir, wavs[0])
    return None


def _init_engine(use_fp16=True):
    """懒加载 IndexTTS2 引擎（线程安全；FP16 失败自动降级 FP32）。"""
    global _engine
    if _engine is not None:
        return True

    cfg_path = os.path.join(MODEL_DIR, 'checkpoints', 'config.yaml')
    if not os.path.exists(cfg_path):
        print(f"[tts_mcp] 错误: 模型配置文件不存在 {cfg_path}", file=sys.stderr)
        return False

    print(f"[tts_mcp] 加载 IndexTTS2 模型: {MODEL_DIR}", file=sys.stderr)
    sys.path.insert(0, MODEL_DIR)

    try:
        import torch  # noqa: F401
        from indextts.infer_v2 import IndexTTS2
        modes = ([True] if use_fp16 else []) + [False]
        last_error = None
        for try_fp16 in modes:
            mode_name = "FP16" if try_fp16 else "FP32"
            try:
                print(f"[tts_mcp] 尝试 {mode_name}…", file=sys.stderr)
                _engine = IndexTTS2(
                    cfg_path=cfg_path,
                    model_dir=os.path.join(MODEL_DIR, 'checkpoints'),
                    use_fp16=try_fp16,
                    use_cuda_kernel=False,
                    use_deepspeed=False,
                )
                # 预热（失败不影响使用，v1 同款）；输出到系统临时目录，不写进模型目录
                voice = _get_default_voice()
                if voice:
                    try:
                        import tempfile
                        _warm_path = os.path.join(tempfile.gettempdir(), f'_aemeath_warmup_{os.getpid()}.wav')
                        _engine.infer(spk_audio_prompt=voice, text="预热。",
                                      output_path=_warm_path,
                                      verbose=False)
                        try:
                            os.remove(_warm_path)
                        except Exception:  # noqa: BLE001
                            pass
                    except Exception:  # noqa: BLE001
                        pass
                print(f"[tts_mcp] {mode_name} 加载成功", file=sys.stderr)
                return True
            except Exception as e:  # noqa: BLE001
                last_error = e
                _engine = None
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                print(f"[tts_mcp] {mode_name} 失败（{e}）", file=sys.stderr)
        raise last_error if last_error else RuntimeError("所有加载模式均失败")
    except Exception as e:  # noqa: BLE001
        import traceback
        print(f"[tts_mcp] 模型加载失败:\n{traceback.format_exc()}", file=sys.stderr)
        _engine = None
        return False


@server.tool(
    "tts_generate",
    "IndexTTS2 语音合成：把文本合成为 wav 音频（爱弥斯音色）。"
    "输出写入 <repo>/voices/tts/ 并返回文件路径；需要内联播放时设 include_base64=true。"
    "注意：首次调用需加载 3.4GB 模型，可能耗时 1-3 分钟；文本不宜含 emoji/颜文字。",
    {
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "要合成的文本（≤500 字，避免 emoji/颜文字）"},
            "voice": {"type": "string", "description": "参考音频 wav 路径（可选，默认 voices/ 下的音色）"},
            "include_base64": {"type": "boolean", "description": "是否在结果里附带 base64 音频（默认 false）"},
        },
        "required": ["text"],
        "additionalProperties": False,
    },
)
def tts_generate(text: str, voice="", include_base64=False):
    global _engine
    if not text or not text.strip():
        return {"success": False, "error": "缺少 text 字段"}
    # C22：文本长度强制上限（描述说 ≤500 字但此前未强制）
    text = text.strip()
    if len(text) > MAX_TEXT_LEN:
        return {"success": False, "error": f"text 过长（{len(text)} 字，上限 {MAX_TEXT_LEN}）"}

    with _engine_lock:
        if _engine is None:
            if not _init_engine():
                return {"success": False, "error": "TTS 引擎加载失败（检查模型目录/venv）"}

        voice_path = voice or _get_default_voice()
        if voice_path and not _is_voice_allowed(voice_path):
            # C22：voice 只允许 voices/ 与模型目录下的 wav；非法则回退默认音色
            voice_path = None
        if not voice_path:
            voice_path = _get_default_voice()
        if not voice_path or not os.path.exists(voice_path):
            return {"success": False, "error": "未找到参考音频（voices/ 或模型 examples/）"}

        try:
            TTS_OUT_DIR.mkdir(parents=True, exist_ok=True)
            # 完整 32 位 uuid（此前 hex[:8] 仅 32 位，约 6.5 万文件后可能碰撞覆盖）
            output_path = TTS_OUT_DIR / f"aemeath_tts_{uuid.uuid4().hex}.wav"
            _engine.infer(spk_audio_prompt=voice_path, text=text,
                          output_path=str(output_path), verbose=False)
            if not output_path.exists():
                return {"success": False, "error": "语音生成失败（无输出文件）"}
            _trim_tts_outputs()  # LRU 清理（防目录无限增长）
            size = output_path.stat().st_size
            result = {
                "success": True,
                "path": str(output_path),
                "relative_path": str(output_path.relative_to(REPO_ROOT)).replace('\\', '/'),
                "size_bytes": size,
                "text_length": len(text),
            }
            if include_base64:
                # C22：base64 内联有大小上限（防超大响应撑爆 MCP 通道）
                if size > MAX_BASE64_BYTES:
                    result["audio_base64_error"] = f"音频 {size} 字节超过内联上限（{MAX_BASE64_BYTES}），未附带 base64（文件仍在 path）"
                else:
                    result["audio_base64"] = base64.b64encode(output_path.read_bytes()).decode('ascii')
            return result
        except Exception as e:  # noqa: BLE001
            return {"success": False, "error": str(e)}


def _maybe_relaunch():
    """第三关补全：MCP profile 用系统 python（PATH）拉起本脚本时，重新执行到
    IndexTTS venv python（AEMEATH_TTS_PYTHON 环境变量，未设置回退 D:\\index-tts）。

    dsh-mcp-client 的 command 是字面量、无 env 插值——靠本函数在进程内完成
    "env 变量决定解释器"的接线：os.execv 同进程替换（MCP stdin/stdout 管道句柄
    不变）；execv 在 Windows 上不可靠（实测 Errno 12），失败则回退为子进程默认
    继承句柄运行（不显式传 stdio，避免父进程持有副本导致 EOF 语义变化）。
    已在目标解释器下运行则直接返回。
    """
    py = os.environ.get('AEMEATH_TTS_PYTHON') or r'D:\index-tts\.venv\Scripts\python.exe'
    if not os.path.exists(py):
        print(f'[tts_mcp] 未找到 IndexTTS venv python: {py}', file=sys.stderr)
        print('[tts_mcp] 请设置环境变量 AEMEATH_TTS_PYTHON 指向本机 IndexTTS venv 的 python.exe（否则 tts_generate 不可用，不影响其他服务）', file=sys.stderr)
        sys.exit(3)
    if os.path.abspath(sys.executable) == os.path.abspath(py):
        return  # 已在目标解释器下
    script = os.path.abspath(__file__)
    args = [py, script] + sys.argv[1:]
    try:
        os.execv(py, args)  # 同进程替换；成功则不返回
    except Exception as e:  # noqa: BLE001
        print(f'[tts_mcp] execv 失败（{e}），改用子进程运行（继承 stdio 句柄）', file=sys.stderr)
    import subprocess
    proc = subprocess.run(args)  # 不显式传 stdio：子进程继承同一组 OS 句柄（MCP 管道）
    sys.exit(proc.returncode)


if __name__ == "__main__":
    _maybe_relaunch()
    parser = argparse.ArgumentParser(description='IndexTTS2 MCP server')
    parser.add_argument('--model-dir', type=str, default=MODEL_DIR, help='IndexTTS2 模型目录')
    parser.add_argument('--no-fp16', action='store_true', help='跳过 FP16 直接 FP32')
    parser.add_argument('--http', type=int, default=0, help='以 HTTP 模式运行（端口，默认 18896），不启动 MCP stdio')
    args, _ = parser.parse_known_args()
    MODEL_DIR = args.model_dir
    if args.http:
        run_http_server(args.http)
    else:
        server.run()
