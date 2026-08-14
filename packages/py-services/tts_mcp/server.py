# -*- coding: utf-8 -*-
# ============================================================
# tts_mcp/server.py — IndexTTS2 语音合成 MCP server（自 v1 tts_server.py 移植）
# 工具（dsh 侧名称 mcp__tts__tts_generate）：
#   输入 text（可选 voice 参考音频路径）→ 合成 wav
#   输出：写入 <repo>/voices/tts/<uuid>.wav，返回 path/size/duration；
#         需要内联音频时 include_base64=true 返回 base64。
# 运行环境：D:\index-tts\.venv\Scripts\python.exe（torch 2.8 + transformers 4.52）
#   模型目录：--model-dir 或环境变量 AEMEATH_TTS_MODEL_DIR，默认 D:\index-tts
#   引擎加载：首次调用懒加载（FP16 → FP32 自动回退 + 预热），加锁串行推理。
# 运行：D:\index-tts\.venv\Scripts\python.exe packages/py-services/tts_mcp/server.py
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

# torch 在引擎加载时导入（本服务须在 IndexTTS venv 下运行；懒加载保证 MCP 启动零延迟）

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mcp_core import McpServer  # noqa: E402

server = McpServer("tts_mcp", "2.0.0-m0")

_engine = None
_engine_lock = threading.Lock()
MODEL_DIR = os.environ.get('AEMEATH_TTS_MODEL_DIR', 'D:\\index-tts')

# 输出目录：<repo>/voices/tts/
REPO_ROOT = Path(__file__).resolve().parents[3]
VOICES_DIR = REPO_ROOT / 'voices'
TTS_OUT_DIR = VOICES_DIR / 'tts'


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
                # 预热（失败不影响使用，v1 同款）
                voice = _get_default_voice()
                if voice:
                    try:
                        _engine.infer(spk_audio_prompt=voice, text="预热。",
                                      output_path=os.path.join(Path(MODEL_DIR), '_warmup.wav'),
                                      verbose=False)
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

    with _engine_lock:
        if _engine is None:
            if not _init_engine():
                return {"success": False, "error": "TTS 引擎加载失败（检查模型目录/venv）"}

        voice_path = voice or _get_default_voice()
        if voice_path and not os.path.exists(voice_path):
            voice_path = None
        if not voice_path:
            voice_path = _get_default_voice()
        if not voice_path or not os.path.exists(voice_path):
            return {"success": False, "error": "未找到参考音频（voices/ 或模型 examples/）"}

        try:
            TTS_OUT_DIR.mkdir(parents=True, exist_ok=True)
            output_path = TTS_OUT_DIR / f"aemeath_tts_{uuid.uuid4().hex[:8]}.wav"
            _engine.infer(spk_audio_prompt=voice_path, text=text,
                          output_path=str(output_path), verbose=False)
            if not output_path.exists():
                return {"success": False, "error": "语音生成失败（无输出文件）"}
            size = output_path.stat().st_size
            result = {
                "success": True,
                "path": str(output_path),
                "relative_path": str(output_path.relative_to(REPO_ROOT)).replace('\\', '/'),
                "size_bytes": size,
                "text_length": len(text),
            }
            if include_base64:
                result["audio_base64"] = base64.b64encode(output_path.read_bytes()).decode('ascii')
            return result
        except Exception as e:  # noqa: BLE001
            return {"success": False, "error": str(e)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='IndexTTS2 MCP server')
    parser.add_argument('--model-dir', type=str, default=MODEL_DIR, help='IndexTTS2 模型目录')
    parser.add_argument('--no-fp16', action='store_true', help='跳过 FP16 直接 FP32')
    args, _ = parser.parse_known_args()
    MODEL_DIR = args.model_dir
    server.run()
