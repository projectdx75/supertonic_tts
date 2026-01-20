/**
 * Web-side TTS Engine for Supertonic
 * Performs ONNX inference directly in the browser.
 */

const pkg = 'supertonic_tts';

class WebTTS {
    constructor() {
        this.sessions = {};
        this.indexer = null;
        this.config = null;
        this.isInitialized = false;
        this.initializedEP = null;
    }

    // Constants ported from core.py
    static SYMBOL_REPLACEMENTS = {
        "\u2013": "-", "\u2011": "-", "\u2014": "-", "\u00af": " ", "_": " ",
        "\u201c": '"', "\u201d": '"', "\u2018": "'", "\u2019": "'", "\u00b4": "'",
        "`": "'", "[": " ", "]": " ", "|": " ", "/": " ", "#": " ", "→": " ", "←": " "
    };

    static EMOJI_PATTERN = /[\uD800-\uDBFF][\uDC00-\uDFFF]|\u2600-\u26FF|\u2700-\u27BF/g;
    static DIACRITICS_PATTERN = /[\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u030A\u030B\u030C\u0327\u0328\u0329\u032A\u032B\u032C\u032D\u032E\u032F]/g;
    static SPECIAL_SYMBOLS_PATTERN = /[♥☆♡©\\]/g;
    static ENDING_PUNCTUATION_PATTERN = /[.!?;:,'")\]}…。「』】〉》›»]$/;

    log(msg, type = 'info') {
        const win = $('#log-window');
        const color = type === 'error' ? '#f00' : (type === 'warn' ? '#ff0' : '#0f0');
        win.append(`<div style="color: ${color}">[${new Date().toLocaleTimeString()}] ${msg}</div>`);
        win.scrollTop(win[0].scrollHeight);
    }

    async init(ep = 'wasm') {
        this.log(`Initializing engine with backend: ${ep}...`);
        try {
            const configResp = await $.ajax({ url: `/${pkg}/ajax/get_model_config`, type: 'POST' });
            if (configResp.ret !== 'success') throw new Error("Failed to get model config");
            
            this.config = configResp;
            this.initializedEP = ep;

            // 1. Load Indexer & Config JSON
            this.log("Fetching indexer and config...");
            this.indexer = await $.getJSON(`/${pkg}/ajax/get_file?file=unicode_indexer.json`);
            this.engineConfig = await $.getJSON(`/${pkg}/ajax/get_file?file=tts.json`);

            // 2. Load ONNX Models (with progress)
            const modelsToLoad = [
                { id: 'dp', file: configResp.models.dp, name: 'Duration Predictor' },
                { id: 'encoder', file: configResp.models.encoder, name: 'Text Encoder' },
                { id: 'estimator', file: configResp.models.estimator, name: 'Vector Estimator' },
                { id: 'vocoder', file: configResp.models.vocoder, name: 'Vocoder' }
            ];

            $('#model-progress-area').empty();
            for (const m of modelsToLoad) {
                this.log(`Loading ${m.name}...`);
                const session = await this.loadModelWithProgress(m, ep);
                this.sessions[m.id] = session;
            }

            this.isInitialized = true;
            this.log("Engine initialized successfully!", 'info');
            return true;
        } catch (err) {
            this.log(`Initialization failed: ${err.message}`, 'error');
            return false;
        }
    }

    async loadModelWithProgress(model, ep) {
        const url = `/${pkg}/ajax/get_file?file=${model.file}`;
        const container = $(`<div class="mb-2">
            <div class="d-flex justify-content-between x-small text-muted mb-1">
                <span>${model.name}</span>
                <span id="prog-val-${model.id}">0%</span>
            </div>
            <div class="progress progress-compact bg-dark border border-secondary">
                <div id="prog-bar-${model.id}" class="progress-bar bg-warning" style="width: 0%"></div>
            </div>
        </div>`).appendTo('#model-progress-area');

        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'arraybuffer';
            
            xhr.onprogress = (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    $(`#prog-bar-${model.id}`).css('width', pct + '%');
                    $(`#prog-val-${model.id}`).text(pct + '%');
                }
            };

            xhr.onload = async () => {
                try {
                    const session = await ort.InferenceSession.create(xhr.response, {
                        executionProviders: [ep],
                        graphOptimizationLevel: 'all'
                    });
                    $(`#prog-bar-${model.id}`).removeClass('bg-warning').addClass('bg-success');
                    resolve(session);
                } catch (e) { reject(e); }
            };

            xhr.onerror = () => reject(new Error(`XHR Error during ${model.name} download`));
            xhr.send();
        });
    }

    // Text Preprocessing (Fully ported from core.py)
    preprocessText(text, lang = 'ko') {
        // 1. Unicode Normalization (NFKD)
        try {
            text = text.normalize('NFKD');
        } catch (e) {}

        // 2. Remove Emojis
        text = text.replace(WebTTS.EMOJI_PATTERN, "");

        // 3. Normalize Symbols
        for (const [old, newVal] of Object.entries(WebTTS.SYMBOL_REPLACEMENTS)) {
            text = text.split(old).join(newVal);
        }

        // 4. Remove diacritics and special symbols
        text = text.replace(WebTTS.DIACRITICS_PATTERN, "");
        text = text.replace(WebTTS.SPECIAL_SYMBOLS_PATTERN, "");

        // 5. Expand abbreviations
        const exprReplacements = { "@": " at ", "e.g.,": "for example, ", "i.e.,": "that is, " };
        for (const [k, v] of Object.entries(exprReplacements)) text = text.split(k).join(v);

        // 6. Fix punctuation spacing
        text = text.replace(/\s+,/g, ",").replace(/\s+\./g, ".").replace(/\s+!/g, "!")
                   .replace(/\s+\?/g, "?").replace(/\s+;/g, ";").replace(/\s+:/g, ":")
                   .replace(/\s+'/g, "'");

        // 7. Remove duplicate quotes
        text = text.replace(/(["'`])\1+/g, "$1");

        // 8. Basic cleaning & Whitespace
        text = text.replace(/\s+/g, " ").trim();

        // 9. Add period if needed
        if (text && !WebTTS.ENDING_PUNCTUATION_PATTERN.test(text)) {
            text += ".";
        }

        // 10. Wrap in lang tags (Improved for Japanese)
        if (lang === 'auto') {
            const hasKorean = /[\u3131-\u314e|\u314f-\u3163|\uac00-\ud7a3]/.test(text);
            const hasJapanese = /[\u3040-\u309F|\u30A0-\u30FF|\u4E00-\u9FAF]/.test(text);
            lang = hasKorean ? 'ko' : (hasJapanese ? 'ja' : 'en');
        }
        return `<${lang}>${text}</${lang}>`;
    }

    // Chunk Text (Ported from utils.py)
    chunkText(text, maxLen = 300) {
        if (maxLen < 10) maxLen = 10;
        
        // Split by paragraph
        const paragraphs = text.split(/\n\s*\n+/).filter(p => p.trim());
        const chunks = [];
        let currentChunk = "";

        for (let paragraph of paragraphs) {
            paragraph = paragraph.trim();
            if (!paragraph) continue;

            // Split into sentences (roughly)
            // Pattern: lookbehind for .!? followed by space OR lookbehind for .!? followed by non-.!?
            const sentences = paragraph.split(/(?<=[.!?])\s+|(?<=[.!?])(?=[^.!?])/).filter(s => s.trim());

            for (let sentence of sentences) {
                sentence = sentence.trim();
                if (!sentence) continue;

                if (sentence.length > maxLen) {
                    // Sub-split by comma
                    const subParts = sentence.split(/(?<=[,])\s*/).filter(p => p.trim());
                    for (let part of subParts) {
                        part = part.trim();
                        if (!part) continue;

                        if (part.length > maxLen) {
                            // Hard split
                            let remaining = part;
                            while (remaining.length > maxLen) {
                                let splitIdx = remaining.lastIndexOf(' ', maxLen);
                                if (splitIdx === -1) splitIdx = maxLen;

                                const subChunk = remaining.substring(0, splitIdx);
                                if ((currentChunk.length + subChunk.length + 1) > maxLen) {
                                    if (currentChunk) chunks.push(currentChunk.trim());
                                    currentChunk = subChunk;
                                } else {
                                    currentChunk += (currentChunk ? " " : "") + subChunk;
                                }
                                remaining = remaining.substring(splitIdx).trim();
                            }
                            // Handle leftover from hard split
                            if (remaining) {
                                if ((currentChunk.length + remaining.length + 1) > maxLen) {
                                    if (currentChunk) chunks.push(currentChunk.trim());
                                    currentChunk = remaining;
                                } else {
                                    currentChunk += (currentChunk ? " " : "") + remaining;
                                }
                            }
                        } else {
                            // Normal part
                            if ((currentChunk.length + part.length + 1) > maxLen) {
                                if (currentChunk) chunks.push(currentChunk.trim());
                                currentChunk = part;
                            } else {
                                currentChunk += (currentChunk ? " " : "") + part;
                            }
                        }
                    }
                } else {
                    // Normal sentence
                    if ((currentChunk.length + sentence.length + 1) > maxLen) {
                        if (currentChunk) chunks.push(currentChunk.trim());
                        currentChunk = sentence;
                    } else {
                        currentChunk += (currentChunk ? " " : "") + sentence;
                    }
                }
            }
        }

        if (currentChunk) chunks.push(currentChunk.trim());
        return chunks;
    }

    async generate(text, options) {
        if (!this.isInitialized) throw new Error("Engine not initialized");
        
        const { voice, speed = 1.0, steps = 5, lang = 'ko' } = options;
        
        // 1. Chunk Text
        const chunks = this.chunkText(text);
        this.log(`Starting synthesis: "${text.substring(0, 20)}..." (${lang}, chunks=${chunks.length})`);
        
        const startTime = Date.now();
        const allWavs = [];
        let totalDuration = 0;

        // 2. Fetch Voice Style (Once)
        this.log(`Loading voice style: ${voice}...`);
        let styleData;
        try {
            styleData = await $.getJSON(`/${pkg}/ajax/get_file?file=voice_styles/${voice}.json`);
        } catch (e) {
            throw new Error(`목소리 파일을 불러오지 못했습니다 (${voice}).`);
        }
        
        const ttlData = styleData.style_ttl.data ? styleData.style_ttl.data.flat(Infinity) : null;
        const dpData = styleData.style_dp.data ? styleData.style_dp.data.flat(Infinity) : null;
        if (!ttlData || !dpData) throw new Error("목소리 스타일 벡터 데이터를 찾을 수 없습니다.");

        const style_ttl = new ort.Tensor('float32', new Float32Array(ttlData), [1, 50, 256]);
        const style_dp = new ort.Tensor('float32', new Float32Array(dpData), [1, 8, 16]);

        const sampleRate = this.engineConfig.ae.sample_rate || 44100;
        const baseChunk = this.engineConfig.ae.base_chunk_size || 512;
        const compress = this.engineConfig.ttl.chunk_compress_factor || 6;
        const ldim = this.engineConfig.ae.ldim || 24;
        const totalStepsTensor = new ort.Tensor('float32', new Float32Array([steps]), [1]);

        // 3. Process each chunk
        for (let i = 0; i < chunks.length; i++) {
            const chunkText = chunks[i];
            this.log(`Processing chunk ${i+1}/${chunks.length}: "${chunkText.substring(0, 20)}..."`);
            
            const preprocessed = this.preprocessText(chunkText, lang);
            const charCodes = Array.from(preprocessed).map(c => c.charCodeAt(0));
            const textIds = new BigInt64Array(charCodes.map(code => BigInt(this.indexer[code] || 0)));
            
            const textIdsTensor = new ort.Tensor('int64', textIds, [1, textIds.length]);
            const textMaskTensor = new ort.Tensor('float32', new Float32Array(textIds.length).fill(1.0), [1, 1, textIds.length]);

            // DP
            const dpResults = await this.sessions.dp.run({ text_ids: textIdsTensor, style_dp, text_mask: textMaskTensor });
            const dur = dpResults.dur_onnx || Object.values(dpResults)[0];
            const adjustedDur = dur.data[0] / speed;
            totalDuration += adjustedDur;

            // Encoder
            const encResults = await this.sessions.encoder.run({ text_ids: textIdsTensor, style_ttl, text_mask: textMaskTensor });
            const textEmb = encResults.text_emb_onnx || Object.values(encResults)[0];

            // Estimator Loop
            const wavLenMax = Math.round(adjustedDur * sampleRate);
            const latentLen = Math.ceil(wavLenMax / (baseChunk * compress));
            const latentDim = ldim * compress;
            let xtData = new Float32Array(latentDim * latentLen).map(() => this.gaussianRandom());
            let xt = new ort.Tensor('float32', xtData, [1, latentDim, latentLen]);
            const latentMask = new ort.Tensor('float32', new Float32Array(latentLen).fill(1.0), [1, 1, latentLen]);

            for (let s = 0; s < steps; s++) {
                const currentStepTensor = new ort.Tensor('float32', new Float32Array([s]), [1]);
                const estResults = await this.sessions.estimator.run({
                    noisy_latent: xt, text_emb: textEmb, style_ttl,
                    text_mask: textMaskTensor, latent_mask: latentMask,
                    current_step: currentStepTensor, total_step: totalStepsTensor
                });
                xt = estResults.xt_onnx || estResults.out || Object.values(estResults)[0];
            }

            // Vocoder
            const vocResults = await this.sessions.vocoder.run({ latent: xt });
            const wav = vocResults.wav_onnx || Object.values(vocResults)[0];
            allWavs.push(wav.data);
        }

        const combinedWav = this.concatenateBuffers(allWavs);
        const latency = Date.now() - startTime;
        this.log(`Synthesis complete. Total duration: ${totalDuration.toFixed(2)}s, Latency: ${latency}ms`);
        
        return { wav: combinedWav, sampleRate, latency, duration: totalDuration };
    }

    concatenateBuffers(buffers) {
        let totalLength = 0;
        for (const buf of buffers) totalLength += buf.length;
        const result = new Float32Array(totalLength);
        let offset = 0;
        for (const buf of buffers) {
            result.set(buf, offset);
            offset += buf.length;
        }
        return result;
    }

    gaussianRandom() {
        let u = 0, v = 0;
        while(u === 0) u = Math.random();
        while(v === 0) v = Math.random();
        return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    }
}

// UI Bridge
$(document).ready(() => {
    const tts = new WebTTS();
    
    $('#btn-init-engine').click(async function() {
        $(this).prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin mr-2"></i>Initializing...');
        const ep = $('#ep-select').val();
        const success = await tts.init(ep);
        if (success) {
            $('#engine-init-msg').hide();
            $('#btn-generate-web').removeClass('d-none');
            // Fetch voices for select
            const $vselect = $('#voice-select');
            $vselect.empty();
            tts.config.voices.forEach(v => {
                $vselect.append(`<option value="${v}">${v}</option>`);
            });
            $('#env-info').text(`${ep.toUpperCase()} | Browser: ${navigator.userAgent.split(' ').pop()}`);
        } else {
            $(this).prop('disabled', false).text('Init Failed. Retry?');
        }
    });

    $('#btn-generate-web').click(async function() {
        const text = $('#tts-input').val().trim();
        if (!text) return alert("Enter text!");

        $(this).prop('disabled', true).html('<i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Synthesizing...');
        
        try {
            const result = await tts.generate(text, {
                voice: $('#voice-select').val(),
                speed: parseFloat($('#speed-range').val()),
                steps: parseInt($('#steps-range').val()),
                lang: $('#lang-select').val()
            });

            // Play Audio
            playAudio(result.wav, result.sampleRate);
            $('#stat-latency').text(result.latency);
            $('#audio-result').removeClass('d-none');
        } catch (err) {
            tts.log(`Error: ${err.message}`, 'error');
            alert(err.message);
        } finally {
            $(this).prop('disabled', false).html('<i class="fa-solid fa-bolt mr-2"></i>브라우저에서 광속 합성');
        }
    });

    function playAudio(floatData, sampleRate) {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const buffer = audioCtx.createBuffer(1, floatData.length, sampleRate);
        buffer.getChannelData(0).set(floatData);
        
        // For playback and download
        const blob = bufferToWav(buffer);
        const url = URL.createObjectURL(blob);
        const $audio = $('#main-audio');
        
        $audio.attr('src', url);
        $('#btn-download').attr('href', url);
        
        // Play via audio tag only (so it can be stopped by the UI)
        $audio[0].play().catch(e => console.warn("Auto-play blocked:", e));
    }

    // Minimal WAV encoder
    function bufferToWav(abuffer) {
        let numOfChan = abuffer.numberOfChannels,
            length = abuffer.length * numOfChan * 2 + 44,
            buffer = new ArrayBuffer(length),
            view = new DataView(buffer),
            channels = [], i, sample,
            offset = 0,
            pos = 0;

        function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
        function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }

        setUint32(0x46464952); // "RIFF"
        setUint32(length - 8); // file length - 8
        setUint32(0x45564157); // "WAVE"
        setUint32(0x20746d66); // "fmt " chunk
        setUint32(16);         // length = 16
        setUint16(1);          // PCM (uncompressed)
        setUint16(numOfChan);
        setUint32(abuffer.sampleRate);
        setUint32(abuffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
        setUint16(numOfChan * 2);                      // block-align
        setUint16(16);         // 16-bit (hardcoded)
        setUint32(0x61746164); // "data" - chunk
        setUint32(length - pos - 4); // chunk length

        for(i=0; i<abuffer.numberOfChannels; i++) channels.push(abuffer.getChannelData(i));

        while(pos < length) {
            for(i=0; i<numOfChan; i++) {
                sample = Math.max(-1, Math.min(1, channels[i][offset]));
                sample = (sample < 0 ? sample * 0x8000 : sample * 0x7FFF);
                view.setInt16(pos, sample, true);
                pos += 2;
            }
            offset++;
        }
        return new Blob([buffer], {type: "audio/wav"});
    }

    $('#btn-clear-log').click(() => $('#log-window').empty());
    
    // UI Sliders
    $('#speed-range').on('input', function() { $('#speed-val').text($(this).val() + 'x'); });
    $('#steps-range').on('input', function() { $('#steps-val').text($(this).val()); });
    $('#tts-input').on('input', function() { $('#char-count').text($(this).val().length + '자 / 5000자'); });
});
