$(document).ready(function() {
    const pkg = 'supertonic_tts';
    
    const voiceNames = {
        'F1': 'Sarah',
        'F2': 'Lily',
        'F3': 'Jessica',
        'F4': 'Olivia',
        'F5': 'Emily',
        'M1': 'Alex',
        'M2': 'James',
        'M3': 'Robert',
        'M4': 'Sam',
        'M5': 'Daniel'
    };

    // 목소리 목록 가져오기
    function fetchVoices() {
        $.ajax({
            url: `/${pkg}/ajax/get_voices`,
            type: 'POST',
            success: function(resp) {
                if (resp.ret === 'success') {
                    const select = $('#voice-select');
                    select.empty();
                    resp.voices.forEach(v => {
                        const displayName = voiceNames[v] || v;
                        select.append(`<option value="${v}">${displayName}</option>`);
                    });
                }
            }
        });
    }

    fetchVoices();

    // UI 동기화
    $('#speed-range').on('input', function() {
        $('#speed-val').text($(this).val() + 'x');
    });

    $('#pitch-range').on('input', function() {
        $('#pitch-val').text($(this).val());
    });

    $('#steps-range').on('input', function() {
        $('#steps-val').text($(this).val());
    });

    $('#tts-input').on('input', function() {
        $('#char-count').text($(this).val().length + '자 / 5000자');
    });

    // 합성 버튼 클릭
    $('#btn-generate').on('click', function() {
        const text = $('#tts-input').val().trim();
        if (!text) {
            alert('텍스트를 입력하세요.');
            return;
        }

        $(this).prop('disabled', true).html('<i class="fa-solid fa-circle-notch fa-spin mr-2"></i>합성 중...');
        
        const startTime = Date.now();
        
        $.ajax({
            url: `/${pkg}/ajax/generate`,
            type: 'POST',
            data: {
                text: text,
                voice: $('#voice-select').val(),
                speed: $('#speed-range').val(),
                pitch: $('#pitch-range').val(),
                steps: $('#steps-range').val(),
                lang: $('#lang-select').val()
            },
            success: function(resp) {
                if (resp.ret === 'success') {
                    const latency = Date.now() - startTime;
                    $('#stat-latency').text(latency);
                    
                    $('#audio-result').removeClass('d-none');
                    $('#main-audio').attr('src', resp.url);
                    $('#btn-download').attr('href', resp.url);
                    
                    // 자동 재생
                    document.getElementById('main-audio').play();
                } else {
                    alert('실패: ' + resp.message);
                }
            },
            error: function() {
                alert('서버 오류 발생');
            },
            complete: function() {
                $('#btn-generate').prop('disabled', false).html('<i class="fa-solid fa-play mr-2"></i>합성하기');
            }
        });
    });
});
