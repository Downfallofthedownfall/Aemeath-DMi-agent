# ============================================================
# tts_server.py - IndexTTS2 HTTP API 服务
# 位置：electron-app/tts_server.py（和其他服务放一起）
# 模型路径通过命令行参数 --model-dir 传入
# 监听端口：18900
# ============================================================

import os
import gc
import torch
import sys
import json
import uuid
import tempfile
import io
import threading
import argparse
from pathlib import Path

from flask import Flask, request, send_file, jsonify
from flask_cors import CORS
import librosa
import soundfile as sf

if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

app = Flask(__name__)
CORS(app)

tts_engine = None
tts_lock = threading.Lock() 
MODEL_DIR = ""  # 由命令行参数设置

# ===== 初始化 TTS 引擎（自动检测 FP16/FP32） =====
def init_engine(model_dir, use_fp16=True):
    global tts_engine
    if tts_engine is not None:
        return True
    
    cfg_path = os.path.join(model_dir, "checkpoints", "config.yaml")
    if not os.path.exists(cfg_path):
        print(f"[TTS] 错误: 模型配置文件不存在 {cfg_path}")
        return False
    
    print(f"[TTS] 正在加载 IndexTTS2 模型...")
    print(f"[TTS]   模型目录: {model_dir}")
    sys.path.insert(0, model_dir)
    
    try:
        from indextts.infer_v2 import IndexTTS2
        
        # ===== 尝试加载（先试 FP16，不行就降级 FP32） =====
        modes_to_try = []
        if use_fp16:
            modes_to_try.append(True)   # 先试 FP16
        modes_to_try.append(False)      # 再试 FP32（兜底）
        
        last_error = None
        for try_fp16 in modes_to_try:
            mode_name = "FP16" if try_fp16 else "FP32"
            try:
                print(f"[TTS] 尝试 {mode_name} 模式...")
                tts_engine = IndexTTS2(
                    cfg_path=cfg_path,
                    model_dir=os.path.join(model_dir, "checkpoints"),
                    use_fp16=try_fp16,
                    use_cuda_kernel=False,
                    use_deepspeed=False
                )
                print(f"[TTS] {mode_name} 模式加载成功")
                
                # 预热
                print("[TTS] 正在预热模型...")
                default_voice = get_default_voice()
                if default_voice:
                    try:
                        tts_engine.infer(
                            spk_audio_prompt=default_voice,
                            text="预热。",
                            output_path=os.path.join(tempfile.gettempdir(), "_warmup.wav"),
                            verbose=False
                        )
                        print("[TTS] 模型预热完成")
                    except Exception as warm_err:
                        print(f"[TTS] 预热失败（不影响使用）: {warm_err}")
                
                print(f"[TTS] IndexTTS2 模型加载完成！（{mode_name} 模式）")
                return True
                
            except Exception as e:
                last_error = e
                error_msg = str(e).lower()
                
                # 判断是否是不支持 FP16 的错误
                is_fp16_error = any(kw in error_msg for kw in [
                    'fp16', 'half', 'float16', 'cuda', 'not supported',
                    'no executable', 'out of memory', 'memory'
                ])
                
                if try_fp16 and is_fp16_error:
                    print(f"[TTS] {mode_name} 模式失败（{e}），自动降级...")
                    # 清理失败的实例
                    tts_engine = None
                    gc.collect()
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                    continue
                elif try_fp16:
                    # FP16 失败但不是硬件问题，可能其他原因，也试试 FP32
                    print(f"[TTS] {mode_name} 模式失败（{e}），尝试 FP32...")
                    tts_engine = None
                    gc.collect()
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                    continue
                else:
                    # FP32 也失败了，真不行了
                    raise e
        
        # 所有模式都试过了还是失败
        raise last_error if last_error else Exception("所有加载模式均失败")
        
    except Exception as e:
        print(f"[TTS] 模型加载失败: {e}")
        import traceback
        traceback.print_exc()
        return False

# ===== 获取默认参考音频 =====
def get_default_voice():
    """先找项目里的 voices/ 目录，再找模型目录里的 examples/"""
    # 1. 项目 voices 目录
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_dir = os.path.dirname(script_dir)  # Aemeath-DMi-agent/
    voices_dir = os.path.join(project_dir, "voices")
    if os.path.exists(voices_dir):
        wavs = [f for f in os.listdir(voices_dir) if f.endswith('.wav')]
        if wavs:
            return os.path.join(voices_dir, wavs[0])
    
    # 2. 模型目录里的 examples
    examples_dir = os.path.join(MODEL_DIR, "examples")
    if os.path.exists(examples_dir):
        wavs = [f for f in os.listdir(examples_dir) if f.endswith('.wav')]
        if wavs:
            return os.path.join(examples_dir, wavs[0])
    
    return None

# ===== TTS 生成接口 =====
@app.route('/tts', methods=['POST'])
def tts_generate():
    if tts_engine is None:
        return jsonify({"error": "TTS 引擎未加载"}), 500
    
    data = request.get_json()
    if not data or 'text' not in data:
        return jsonify({"error": "缺少 text 字段"}), 400
    
    text = data['text']
    voice_path = data.get('voice', None)
    
    # 如果前端传了音色路径，用它；否则用默认
    if voice_path and not os.path.exists(voice_path):
        voice_path = None
    if not voice_path:
        voice_path = get_default_voice()
    
    if not voice_path or not os.path.exists(voice_path):
        return jsonify({"error": "未找到参考音频"}), 400
        # 如果有特殊分隔标记，用 ||| 连接多句
        # 前端传来的 text 可能包含 ||| 分隔符
        # IndexTTS2 本身支持长文本，所以直接全量推理
    print(f"[TTS] 生成: text={text[:50]}... ({len(text)}字) voice={os.path.basename(voice_path)}")

    
    try:
        output_path = os.path.join(tempfile.gettempdir(), f"aemeath_tts_{uuid.uuid4().hex[:8]}.wav")
        
        # 【修复】加锁！同一时间只处理一个推理请求
        with tts_lock:
            tts_engine.infer(
                spk_audio_prompt=voice_path,
                text=text,
                output_path=output_path,
                verbose=False
            )
        
        if not os.path.exists(output_path):
            return jsonify({"error": "语音生成失败"}), 500

        
        with open(output_path, 'rb') as f:
            audio_data = f.read()
        
        try:
            os.remove(output_path)
        except:
            pass
        
        return (
            audio_data,
            200,
            {
                'Content-Type': 'audio/wav',
                'Content-Disposition': 'inline; filename="aemeath_tts.wav"'
            }
        )
    
    except Exception as e:
        import traceback
        print(f"[TTS] 错误: {e}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# ===== 健康检查 =====
@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({
        "status": "ok",
        "engine_loaded": tts_engine is not None
    })

# ===== 主程序 =====
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='IndexTTS2 HTTP API')
    parser.add_argument('--host', type=str, default='127.0.0.1', help='监听地址')
    parser.add_argument('--port', type=int, default=18900, help='监听端口')
    parser.add_argument('--model-dir', type=str, required=True, help='IndexTTS2 模型目录路径')
    parser.add_argument('--fp16', action='store_true', default=True)
    parser.add_argument('--no-fp16', action='store_true')
    
    args = parser.parse_args()
    MODEL_DIR = args.model_dir
    
    if not os.path.exists(MODEL_DIR):
        print(f"[TTS] 错误: 模型目录不存在 {MODEL_DIR}")
        sys.exit(1)
    
    success = init_engine(MODEL_DIR, use_fp16=not args.no_fp16)
    
    if not success:
        print("[TTS] 模型加载失败，服务将以降级模式运行（/health 会返回 engine_loaded: false）")
    
    print(f"[TTS] API 服务启动中...")
    print(f"  监听: http://{args.host}:{args.port}")
    print(f"  模型: {MODEL_DIR}")
    print(f"  POST /tts - 生成语音")
    print(f"  GET /health - 健康检查")
    
    app.run(host=args.host, port=args.port, debug=False)
