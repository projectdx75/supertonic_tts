try:
    from supertonic import TTS
    import inspect
    
    # Initialize engine (mocking trio if needed as per logic.py)
    import sys
    if 'trio' not in sys.modules:
        from unittest.mock import MagicMock
        sys.modules['trio'] = MagicMock()

    print("--- TTS Class Info ---")
    tts = TTS(auto_download=False) # Avoid download if possible, or True if needed
    
    print("\n--- synthesize signature ---")
    sig = inspect.signature(tts.synthesize)
    print(sig)
    
    print("\n--- synthesize docstring ---")
    print(tts.synthesize.__doc__)

except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()
