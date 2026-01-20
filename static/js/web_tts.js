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

    // Text Preprocessing (Ported from core.py)
    preprocessText(text, lang = 'ko') {
        // 1. Unicode Normalization (NFKD)
        text = text.normalize('NFKD');

        // 2. Remove Emojis (simplified pattern)
        text = text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|\u2600-\u26FF|\u2700-\u27BF/g, "");

        // 3. Normalize Symbols
        const replacements = { "_": " ", "[": " ", "]": " ", "|": " ", "/": " ", "#": " " };
        for (const [k, v] of Object.entries(replacements)) text = text.split(k).join(v);

        // 4. Basic cleaning
        text = text.replace(/\s+/g, " ").trim();
        if (!/[.!?;:,'")\]}…。「』】〉》›»]$/.test(text)) text += ".";

        // 5. Wrap in lang tags
        if (lang === 'auto') {
            const hasKorean = /[\u3131-\u314e|\u314f-\u3163|\uac00-\ud7a3]/.test(text);
            lang = hasKorean ? 'ko' : 'en';
        }
        return `<${lang}>${text}</${lang}>`;
    }

    async generate(text, options) {
        if (!this.isInitialized) throw new Error("Engine not initialized");
        
        const { voice, speed = 1.0, steps = 5, lang = 'ko' } = options;
        this.log(`Starting synthesis: "${text.substring(0, 20)}..." (${lang}, ${speed}x, steps=${steps})`);
        
        const startTime = Date.now();
        const preprocessed = this.preprocessText(text, lang);
        
        // Convert to IDs
        const charCodes = Array.from(preprocessed).map(c => c.charCodeAt(0));
        const textIds = new BigInt64Array(charCodes.map(code => BigInt(this.indexer[code] || 0)));
        const textLen = BigInt(textIds.length);
        
        // Prepare Inputs
        const textIdsTensor = new ort.Tensor('int64', textIds, [1, textIds.length]);
        const textMaskTensor = new ort.Tensor('float32', new Float32Array(textIds.length).fill(1.0), [1, 1, textIds.length]);

        // 1. Fetch Voice Style
        this.log("Loading voice style...");
        const styleData = await $.getJSON(`/${pkg}/ajax/get_file?file=voice_styles/${voice}.json`);
        const style_ttl = new ort.Tensor('float32', new Float32Array(styleData.style_ttl_onnx.flat()), [1, 256]);
        const style_dp = new ort.Tensor('float32', new Float32Array(styleData.style_dp_onnx.flat()), [1, 256]);

        // 2. Duration Predictor
        this.log("Predicting duration...");
        const dpFeeds = { text_ids: textIdsTensor, style_dp: style_dp, text_mask: text_maskTensor };
        const dpResults = await this.sessions.dp.run(dpFeeds);
        const dur = dpResults.dur_onnx; // Float32Tensor [1, 1]
        
        // Adjust duration by speed
        const adjustedDur = dur.data[0] / speed;
        this.log(`Predicted duration: ${adjustedDur.toFixed(2)}s`);

        // 3. Text Encoder
        this.log("Encoding text...");
        const encFeeds = { text_ids: textIdsTensor, style_ttl: style_ttl, text_mask: text_maskTensor };
        const encResults = await this.sessions.encoder.run(encFeeds);
        const textEmb = encResults.text_emb_onnx;

        // 4. Vector Estimator Loop (Diffusion)
        this.log(`Diffusion steps (steps=${steps})...`);
        const sampleRate = 24000;
        const baseChunk = 80;
        const compress = 4;
        const wavLenMax = Math.round(adjustedDur * sampleRate);
        const latentLen = Math.ceil(wavLenMax / (baseChunk * compress));
        const latentDim = 128 * compress;
        
        // Random noisy latent (Fixed seed 42 simulation: use predictable pseudo-random if needed, but Math.random for now)
        let xtData = new Float32Array(latentDim * latentLen).map(() => this.gaussianRandom());
        let xt = new ort.Tensor('float32', xtData, [1, latentDim, latentLen]);
        const latentMask = new ort.Tensor('float32', new Float32Array(latentLen).fill(1.0), [1, 1, latentLen]);
        
        const totalStepsTensor = new ort.Tensor('float32', new Float32Array([steps]), [1]);

        for (let i = 0; i < steps; i++) {
            const currentStepTensor = new ort.Tensor('float32', new Float32Array([i]), [1]);
            const estFeeds = {
                noisy_latent: xt,
                text_emb: textEmb,
                style_ttl: style_ttl,
                text_mask: textMaskTensor,
                latent_mask: latentMask,
                current_step: currentStepTensor,
                total_step: totalStepsTensor
            };
            const estResults = await this.sessions.estimator.run(estFeeds);
            xt = estResults.xt_onnx || estResults.out; // Check exact output name in session if needed
            if (!xt) xt = Object.values(estResults)[0]; // Fallback to first output
        }

        // 5. Vocoder
        this.log("Generating waveform...");
        const vocResults = await this.sessions.vocoder.run({ latent: xt });
        const wav = Object.values(vocResults)[0]; // wav_onnx

        const latency = Date.now() - startTime;
        this.log(`Synthesis complete in ${latency}ms`);
        
        return { wav: wav.data, sampleRate, latency, duration: adjustedDur };
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
            tts.config.voices.forEach(v => {
                $('#voice-select').append(`<option value="${v}">${v}</option>`);
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
        
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        source.start();
        
        // For download link
        const blob = bufferToWav(buffer);
        const url = URL.createObjectURL(blob);
        $('#main-audio').attr('src', url);
        $('#btn-download').attr('href', url);
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
