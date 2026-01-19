from framework import F
from plugin import PluginModuleBase
from flask import jsonify, request
import os
import numpy as np
import traceback
import sys
import platform

class Logic(PluginModuleBase):
    def __init__(self, P):
        super(Logic, self).__init__(P, name='logic')
        self.tts = None
        self.voices = []
        # Dummy trio to bypass the "unsupported platform" error in httpcore/trio on macOS
        if 'trio' not in sys.modules:
            try:
                from unittest.mock import MagicMock
                sys.modules['trio'] = MagicMock()
            except ImportError:
                pass
        
        # Configure for Multilingual support (Supertone/supertonic-2)
        os.environ["SUPERTONIC_MODEL_REPO"] = "Supertone/supertonic-2"
        os.environ["SUPERTONIC_MODEL_REVISION"] = "main"
        os.environ["SUPERTONIC_CACHE_DIR"] = os.path.expanduser("~/.cache/supertonic-2")

    def _get_engine(self):
        if self.tts is None:
            try:
                from supertonic import TTS
                # Default cache is ~/.cache/supertonic
                self.tts = TTS(auto_download=True)
                self.voices = self.tts.voice_style_names
                self.P.logger.info(f"[TTS] Engine initialized. Voices: {self.voices}")
            except Exception as e:
                self.P.logger.error(f"[TTS] Initialization failed: {e}")
                self.P.logger.error(traceback.format_exc())
        return self.tts

    # Core TTS logic
    def generate_tts(self, text, voice='default', speed=1.0, pitch=1.0, steps=5):
        try:
            if not text:
                return {"ret": "error", "message": "Text is empty"}
                
            # AUTO-FIX: MacOS NFD -> NFC normalization
            # Supertonic/Hangul generally expects NFC (composed) characters.
            import unicodedata
            text = unicodedata.normalize('NFC', text)
                
            engine = self._get_engine()
            if engine is None:
                return {"ret": "error", "message": "Engine not initialized"}

            # Handle speed constraints
            # Supertonic supports 0.7 ~ 2.0 natively.
            # If user requests outside this range (e.g. 0.5), we generate at 1.0 
            # and use FFmpeg 'atempo' to slow it down post-process.
            target_speed = float(speed)
            native_speed = target_speed
            use_ffmpeg_speed = False
            
            if target_speed < 0.7 or target_speed > 2.0:
                self.P.logger.info(f"[TTS] Speed {target_speed} is outside native range (0.7-2.0). Using FFmpeg post-processing.")
                native_speed = 1.0
                use_ffmpeg_speed = True
            
            self.P.logger.info(f"[TTS] Generating for: {text[:50]}...")
            
            # Map simple voice names if needed, or use directly
            voice_name = voice if voice in self.voices else (self.voices[0] if self.voices else "M1")
            style = engine.get_voice_style(voice_name)
            
            # Synthesize
            self.P.logger.info(f"[TTS] Synthesize params - TargetSpeed: {target_speed}, NativeSpeed: {native_speed}, Steps: {steps}, Voice: {voice_name}")
            
            # Trust engine sample rate (usually 44100)
            try:
                engine_sr = getattr(engine, 'sample_rate', 
                                  getattr(engine, 'fs', 
                                          getattr(engine, 'sampling_rate', 44100)))
            except:
                engine_sr = 44100

            # Synthesize with retry logic for unsupported characters
            max_retries = 3
            for attempt in range(max_retries):
                try:
                    wav, duration = engine.synthesize(
                        text=text,
                        voice_style=style,
                        speed=native_speed,
                        total_steps=steps, # Quality
                        verbose=False # Production
                    )
                    break # Success
                except ValueError as ve:
                    error_msg = str(ve)
                    if "unsupported character" in error_msg and attempt < max_retries - 1:
                        # Extract characters from error message
                        # Msg format: "Found X unsupported character(s): ['A', 'B']"
                        import re
                        match = re.search(r"\[(.*?)\]", error_msg)
                        if match:
                            chars_str = match.group(1)
                            # Parse expected list format " 'A', 'B' "
                            bad_chars = [c.strip().strip("'").strip('"') for c in chars_str.split(',')]
                            self.P.logger.warning(f"[TTS] Removing unsupported characters: {bad_chars}")
                            
                            for char in bad_chars:
                                text = text.replace(char, '')
                                
                            if not text.strip():
                                raise ValueError("Text became empty after removing unsupported characters")
                            continue
                    raise ve # Re-raise if not unsupported char error or retries exhausted
            
            # Save to temporary/static location
            filename = f"tts_{os.urandom(4).hex()}.wav"
            static_dir = os.path.join(os.path.dirname(__file__), 'static', 'output')
            if not os.path.exists(static_dir):
                os.makedirs(static_dir)
            
            output_path = os.path.join(static_dir, filename)
            engine.save_audio(wav, output_path)
            
            # POST-PROCESSING: Speed Adjustment (atempo)
            # Apply if we decided to use ffmpeg, OR if we want to support broader range safely
            if use_ffmpeg_speed:
                try:
                    import subprocess
                    self.P.logger.info(f"[TTS] Applying ffmpeg atempo: {target_speed}x")
                    
                    temp_output = output_path + ".tmp.wav"
                    # atempo filter changes speed without changing pitch
                    # Limits: atempo only supports 0.5 to 2.0 in one pass.
                    # If we need more extreme, we might need chaining, but user range is 0.5-2.0 so single pass is fine.
                    
                    cmd = [
                        'ffmpeg', '-y', '-i', output_path,
                        '-af', f'atempo={target_speed}',
                        temp_output
                    ]
                    
                    # Run ffmpeg
                    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    
                    # Replace original if successful
                    if os.path.exists(temp_output):
                        os.replace(temp_output, output_path)
                        self.P.logger.info("[TTS] Speed adjustment successful")
                        
                        # Update duration roughly
                        duration = [duration[0] / target_speed] 
                except Exception as e:
                    self.P.logger.error(f"[TTS] Speed adjustment failed: {e}")
                    import traceback
                    self.P.logger.error(traceback.format_exc())
            
            # Return URL for frontend
            url = f"/{self.P.package_name}/static/output/{filename}"
            return {
                "ret": "success", 
                "url": url, 
                "latency": int(round(float(duration[0]) * 1000)), 
                "duration": float(round(float(duration[0]), 2))
            }
        except Exception as e:
            self.P.logger.error(f"TTS Error: {e}")
            import traceback
            self.P.logger.error(traceback.format_exc())
            return {"ret": "error", "message": str(e)}

    def process_ajax(self, sub, req):
        try:
            if sub == 'generate':
                text = req.form.get('text')
                voice = req.form.get('voice', 'default')
                speed = float(req.form.get('speed', 1.0))
                pitch = float(req.form.get('pitch', 1.0))
                steps = int(req.form.get('steps', 5))
                
                result = self.generate_tts(text, voice, speed, pitch, steps)
                return jsonify(result)
            
            elif sub == 'get_voices':
                engine = self._get_engine()
                return jsonify({
                    "ret": "success", 
                    "voices": self.voices
                })
            
            elif sub == 'log':
                log_path = os.path.join(F.config['path_log'], f"{self.P.package_name}.log")
                if os.path.exists(log_path):
                    with open(log_path, 'r', encoding='utf-8') as f:
                        return f.read()
                return "로그 파일이 존재하지 않습니다."
        except Exception as e:
            self.P.logger.error(f"process_ajax error: {e}")
            self.P.logger.error(traceback.format_exc())
            return jsonify({"ret": "error", "message": str(e)})
