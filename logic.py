from typing import List, Dict, Any, Optional, Union
import os
import numpy as np
import traceback
import sys
import unicodedata
import re
import subprocess
from datetime import datetime

from framework import F
from plugin import PluginModuleBase
from flask import jsonify, request, Response, send_from_directory

import importlib
import inspect

class Logic(PluginModuleBase):
    def __init__(self, P: Any) -> None:
        super(Logic, self).__init__(P, name='logic')
        self.tts: Optional[Any] = None
        self.voices: List[str] = []
        
        # [REFACTORED] Dummy trio mock - centralized and cleaner
        if 'trio' not in sys.modules:
            try:
                from unittest.mock import MagicMock
                sys.modules['trio'] = MagicMock()
                self.P.logger.debug("[TTS] MagicMock for 'trio' applied to bypass platform constraints.")
            except ImportError:
                pass
        
        # Configure for Multilingual support (Supertone/supertonic-2)
        # Using environment variables to configure internal library behavior
        os.environ["SUPERTONIC_MODEL_REPO"] = "Supertone/supertonic-2"
        os.environ["SUPERTONIC_MODEL_REVISION"] = "main"
        os.environ["SUPERTONIC_CACHE_DIR"] = os.path.expanduser("~/.cache/supertonic-2")
        
        # Self-Check and Patch on start
        self._check_and_install_dependencies()
        self._check_and_patch_library()

    def _check_and_install_dependencies(self) -> None:
        """Check for missing dependencies and install them if necessary."""
        required = ["supertonic", "onnxruntime", "soundfile", "huggingface_hub", "numpy", "unicodedata2"]
        missing = []
        for pkg in required:
            try:
                if pkg == "supertonic": import supertonic
                elif pkg == "onnxruntime": import onnxruntime
                elif pkg == "soundfile": import soundfile
                elif pkg == "huggingface_hub": import huggingface_hub
                elif pkg == "numpy": import numpy
                elif pkg == "unicodedata2": import unicodedata2
            except ImportError:
                missing.append(pkg)
        
        if missing:
            self.P.logger.warning(f"[TTS] Missing dependencies: {missing}. Attempting installation...")
            try:
                import subprocess
                subprocess.check_call([sys.executable, "-m", "pip", "install"] + missing)
                self.P.logger.info(f"[TTS] Successfully installed: {missing}")
            except Exception as e:
                self.P.logger.error(f"[TTS] Failed to install dependencies: {e}")

    def _check_and_patch_library(self) -> None:
        """Check if the internal supertonic library has been patched with our fixes."""
        try:
            import supertonic
            import shutil
            lib_path = os.path.dirname(supertonic.__file__)
            core_py = os.path.join(lib_path, "core.py")
            pipeline_py = os.path.join(lib_path, "pipeline.py")
            
            patch_dir = os.path.join(os.path.dirname(__file__), "lib_patches")
            patch_core = os.path.join(patch_dir, "core.py")
            patch_pipeline = os.path.join(patch_dir, "pipeline.py")
            
            patched = True
            
            # 1. Check core.py for random seed fix
            if os.path.exists(core_py) and os.path.exists(patch_core):
                with open(core_py, 'r', encoding='utf-8') as f:
                    if "np.random.seed(42)" not in f.read():
                        self.P.logger.warning("[TTS] core.py not patched. Patching from plugin...")
                        shutil.copy(patch_core, core_py)
                        patched = False
            
            # 2. Check pipeline.py for lang propagation
            if os.path.exists(pipeline_py) and os.path.exists(patch_pipeline):
                 with open(pipeline_py, 'r', encoding='utf-8') as f:
                    if "lang: Optional[str] = None" not in f.read():
                         self.P.logger.warning("[TTS] pipeline.py not patched. Patching from plugin...")
                         shutil.copy(patch_pipeline, pipeline_py)
                         patched = False
            
            if not patched:
                self.P.logger.info("[TTS] Library self-patching completed. Forcing module reload...")
                try:
                    importlib.reload(supertonic)
                    if hasattr(supertonic, 'core'): importlib.reload(supertonic.core)
                    if hasattr(supertonic, 'pipeline'): importlib.reload(supertonic.pipeline)
                    self.P.logger.info("[TTS] Supertonic modules reloaded successfully.")
                except Exception as re_err:
                    self.P.logger.error(f"[TTS] Module reload failed: {re_err}")
            else:
                self.P.logger.info("[TTS] Library already patched.")
                
        except PermissionError:
            self.P.logger.error("[TTS] Permission denied while patching library. Please run: sudo chmod -R 777 /path/to/supertonic")
        except Exception as e:
            self.P.logger.error(f"[TTS] Library patching failed: {e}")
            self.P.logger.error(traceback.format_exc())

    def get_patch_status(self) -> Dict[str, Any]:
        """Check the current patch status of the library (On-disk and In-memory)."""
        try:
            import supertonic
            lib_path = os.path.dirname(supertonic.__file__)
            core_py = os.path.join(lib_path, "core.py")
            pipeline_py = os.path.join(lib_path, "pipeline.py")
            
            # 1. On-Disk Check
            disk_core_ok = "np.random.seed(42)" in open(core_py, 'r', encoding='utf-8').read() if os.path.exists(core_py) else False
            disk_pipe_ok = "lang: Optional[str] = None" in open(pipeline_py, 'r', encoding='utf-8').read() if os.path.exists(pipeline_py) else False
            
            # 2. In-Memory Check (Check if 'lang' exists in synthesize signature)
            from supertonic import TTS
            sig = inspect.signature(TTS.synthesize)
            memory_ok = 'lang' in sig.parameters
            
            return {
                'disk': {'core': disk_core_ok, 'pipeline': disk_pipe_ok},
                'memory': memory_ok,
                'overall': disk_pipe_ok and memory_ok
            }
        except Exception as e:
            return {'overall': False, 'error': str(e)}

    def _get_engine(self) -> Optional[Any]:
        """Lazy initialization of the TTS engine with error handling."""
        if self.tts is None:
            try:
                from supertonic import TTS
                # Default cache is ~/.cache/supertonic-2 due to env vars above
                self.tts = TTS(auto_download=True)
                self.voices = getattr(self.tts, 'voice_style_names', [])
                self.P.logger.info(f"[TTS] Engine initialized. Available voices: {len(self.voices)}")
            except Exception as e:
                self.P.logger.error(f"[TTS] Engine initialization failed: {str(e)}")
                self.P.logger.error(traceback.format_exc())
                return None
        return self.tts

    def generate_tts(
        self, 
        text: str, 
        voice: str = 'default', 
        speed: float = 1.0, 
        pitch: float = 1.0, 
        steps: int = 5,
        lang: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Generate TTS audio from text with specified parameters and post-processing.
        
        Returns: 
            Dict containing 'ret', 'url', 'latency', 'duration' or 'message' on error.
        """
        try:
            if not text or not text.strip():
                return {"ret": "error", "message": "입력 텍스트가 비어있습니다."}
                
            # AUTO-FIX: MacOS NFD -> NFC normalization
            # Supertonic engine expects NFC (composed) characters for better accuracy.
            text = unicodedata.normalize('NFC', text)
                
            engine = self._get_engine()
            if engine is None:
                return {"ret": "error", "message": "TTS 엔진 초기화에 실패했습니다."}

            # Speed constraints post-processing determination
            # Native range: 0.7 ~ 2.0. Outside this, we use FFmpeg post-processing.
            target_speed = float(speed)
            native_speed = target_speed
            use_ffmpeg_speed = False
            
            if target_speed < 0.7 or target_speed > 2.0:
                self.P.logger.info(f"[TTS] Requested speed ({target_speed}) outside native range (0.7-2.0). Using FFmpeg.")
                native_speed = 1.0
                use_ffmpeg_speed = True
            
            self.P.logger.info(f"[TTS] Generating (Voice: {voice}, Steps: {steps}, Speed: {target_speed}) for text length: {len(text)}")
            
            # Voice Mapping logic
            voice_name = voice if voice in self.voices else (self.voices[0] if self.voices else "M1")
            
            try:
                style = engine.get_voice_style(voice_name)
            except Exception as style_err:
                self.P.logger.warning(f"[TTS] Failed to get voice style '{voice_name}': {style_err}. Falling back.")
                style = engine.get_voice_style(self.voices[0]) if self.voices else None

            # Synthesize with retry logic for unsupported characters
            max_retries = 3
            wav = None
            duration = [0.0]
            
            for attempt in range(max_retries):
                try:
                    wav, duration = engine.synthesize(
                        text=text,
                        voice_style=style,
                        speed=native_speed,
                        total_steps=steps, 
                        verbose=False,
                        lang=lang
                    )
                    break
                except ValueError as ve:
                    error_msg = str(ve)
                    if "unsupported character" in error_msg.lower() and attempt < max_retries - 1:
                        match = re.search(r"\[(.*?)\]", error_msg)
                        if match:
                            chars_str = match.group(1)
                            bad_chars = [c.strip().strip("'").strip('"') for c in chars_str.split(',')]
                            self.P.logger.warning(f"[TTS] Removing unsupported characters (Attempt {attempt+1}): {bad_chars}")
                            for char in bad_chars:
                                text = text.replace(char, '')
                            if not text.strip():
                                raise ValueError("지원하지 않는 문자를 제거한 후 텍스트가 비어버렸습니다.")
                            continue
                    raise ve
            
            if wav is None:
                throw_err = "음성 생성 결과가 비어있습니다."
                raise ValueError(throw_err)

            # File Management
            filename = f"tts_{os.urandom(4).hex()}.wav"
            static_dir = os.path.join(os.path.dirname(__file__), 'static', 'output')
            os.makedirs(static_dir, exist_ok=True)
            
            output_path = os.path.join(static_dir, filename)
            engine.save_audio(wav, output_path)
            
            # Post-processing: FFmpeg atempo for extended speed range
            if use_ffmpeg_speed:
                try:
                    temp_output = output_path + ".tmp.wav"
                    self.P.logger.debug(f"[TTS] FFmpeg atempo processing: {output_path}")
                    
                    cmd = [
                        'ffmpeg', '-y', '-i', output_path,
                        '-af', f'atempo={target_speed}',
                        temp_output
                    ]
                    
                    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    
                    if os.path.exists(temp_output):
                        os.replace(temp_output, output_path)
                        duration = [duration[0] / target_speed] 
                        self.P.logger.info(f"[TTS] FFmpeg speed adjustment ({target_speed}x) completed.")
                except Exception as ffmpeg_err:
                    self.P.logger.error(f"[TTS] FFmpeg post-processing failed: {ffmpeg_err}")

            # Return metadata for frontend
            url = f"/{self.P.package_name}/static/output/{filename}"
            return {
                "ret": "success", 
                "url": url, 
                "latency": int(round(float(duration[0]) * 1000)), 
                "duration": float(round(float(duration[0]), 2))
            }
        except Exception as e:
            self.P.logger.error(f"[TTS] Global generation error: {str(e)}")
            self.P.logger.error(traceback.format_exc())
            return {"ret": "error", "message": f"생성 실패: {str(e)}"}

    def process_ajax(self, sub: str, req: Any) -> Union[Response, str]:
        """Unified AJAX handler for the plugin."""
        try:
            if sub == 'generate':
                text = req.form.get('text', '')
                voice = req.form.get('voice', 'default')
                speed = float(req.form.get('speed', 1.0))
                pitch = float(req.form.get('pitch', 1.0))
                steps = int(req.form.get('steps', 5))
                lang = req.form.get('lang')
                if lang == 'auto': lang = None
                
                result = self.generate_tts(text, voice, speed, pitch, steps, lang)
                return jsonify(result)
            
            elif sub == 'get_voices':
                current_engine = self._get_engine()
                return jsonify({
                    "ret": "success" if current_engine else "error", 
                    "voices": self.voices
                })
            
            elif sub == 'get_status':
                import sys
                return jsonify({
                    'ret': 'success',
                    'patch': self.get_patch_status(),
                    'env': {
                        'python': sys.version,
                        'platform': sys.platform,
                    }
                })

            elif sub == 'get_model_config':
                import supertonic
                lib_path = os.path.dirname(supertonic.__file__)
                # We use the same cache dir as the server
                cache_dir = os.environ.get("SUPERTONIC_CACHE_DIR", os.path.expanduser("~/.cache/supertonic-2"))
                
                return jsonify({
                    'ret': 'success',
                    'cache_dir': cache_dir,
                    'voices': self.voices,
                    'models': {
                        'encoder': 'text_encoder.onnx',
                        'dp': 'duration_predictor.onnx',
                        'estimator': 'vector_estimator.onnx',
                        'vocoder': 'vocoder.onnx',
                        'indexer': 'unicode_indexer.json',
                        'config': 'tts.json'
                    }
                })
            
                })

            elif sub == 'get_file':
                # Serve model files from cache dir
                filename = req.args.get('file')
                if not filename: return jsonify({'ret': 'error', 'msg': 'No file specified'})
                
                cache_dir = os.environ.get("SUPERTONIC_CACHE_DIR", os.path.expanduser("~/.cache/supertonic-2"))
                
                # Security: check if file is in voice_styles subfolder or root cache
                if filename.startswith('voice_styles/'):
                    return send_from_directory(cache_dir, filename)
                else:
                    # restrict to root cache files (onnx, json)
                    basename = os.path.basename(filename)
                    return send_from_directory(cache_dir, basename)
            
            elif sub == 'log':
                log_path = os.path.join(F.config['path_log'], f"{self.P.package_name}.log")
                if os.path.exists(log_path):
                    with open(log_path, 'r', encoding='utf-8') as f:
                        return f.read()
                return "로그 파일이 존재하지 않습니다."
            
            return jsonify({"ret": "error", "message": f"Unknown sub-command: {sub}"})
            
        except Exception as e:
            self.P.logger.error(f"[TTS] AJAX error ({sub}): {str(e)}")
            self.P.logger.error(traceback.format_exc())
            return jsonify({"ret": "error", "message": f"시스템 오류: {str(e)}"})
