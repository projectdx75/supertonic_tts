# Supertonic TTS Plugin

![Supertonic TTS](static/img/app_icon.png)

High-performance ONNX-based Text-to-Speech plugin for FlaskFarm, utilizing the Supertone Supertonic-2 engine. Optimized for multilingual support (Korean/English) and seamless integration with EPUB viewers.

## Features

- **High-Fidelity Multilingual TTS**: Uses Supertonic-2 Flow Matching model for natural-sounding speech.
- **Dynamic Quality Control**: Adjustable synthesis steps (1-100) via UI to balance speed and quality.
- **Improved EPUB Navigation**: Smart text extraction that ignores hidden elements and ruby text (furigana), preventing duplicate reading.
- **Consistency Engine**: Fixed random seed initialization to ensure stable voice timbre across long document segments.
- **Language Auto-Tagging**: Automatically wraps content in `<ko>` or `<en>` tags for optimal model performance based on character detection.
- **Flexible Playback**: Integrated audio player with speed and pitch control (via post-processing).

## Installation

1. Clone this repository into your FlaskFarm `ff_dev_plugins` directory:
   ```bash
   git clone https://github.com/projectdx75/supertonic_tts.git
   ```
2. Install dependencies:
   ```bash
   pip install supertonic soundfile requests ffmpeg-python
   ```
3. Ensure `ffmpeg` is installed on your system.

## Configuration

The plugin automatically handles model downloading from HuggingFace (`Supertone/supertonic-2`). Models are cached in `~/.cache/supertonic-2`.

## Version History

### 0.2.0 (Latest)
- **Quality Debugging & Stability**:
    - Fixed duplicate reading issues in EPUB and long text.
    - Implemented random seed pinning (Seed: 42) for consistent voice tone.
    - Added automatic language tag wrapping for Supertonic-2 compatibility.
    - Improved EPUB text extraction using `TreeWalker`.
- **UI Improvements**:
    - Added "Quality (Steps)" slider to the main TTS page and EPUB bridge.
    - Fixed missing FontAwesome icons in the EPUB viewer modal.
    - Added support for unsupported character filtering with auto-retry.

### 0.1.0
- Initial release with basic synthesis and speed/pitch controls.

## License

MIT License
