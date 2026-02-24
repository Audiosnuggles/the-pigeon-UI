export let audioCtx;
export let masterGain;
export let analyser;
export const fxNodes = { delay: {}, reverb: {}, vibrato: {}, filter: {}, stutter: {} };
export const trackSends = [[], [], [], []];
export const trackAnalysers = [];

export function initAudio(tracks, updateRoutingCallback) {
    if (audioCtx) return;
    
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContext();
    
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.8;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    
    masterGain.connect(analyser);
    analyser.connect(audioCtx.destination);

    // 1. DELAY
    fxNodes.delay.node = audioCtx.createDelay(5.0);
    fxNodes.delay.feedback = audioCtx.createGain();
    fxNodes.delay.input = audioCtx.createGain();
    
    fxNodes.delay.node.delayTime.value = 0.4;
    fxNodes.delay.feedback.gain.value = 0.3;
    
    fxNodes.delay.input.connect(fxNodes.delay.node);
    fxNodes.delay.node.connect(fxNodes.delay.feedback);
    fxNodes.delay.feedback.connect(fxNodes.delay.node);
    fxNodes.delay.node.connect(masterGain);

    // 2. REVERB (Algorithmic "Schroeder" Reverb - Warm & Echtzeit-fähig)
    fxNodes.reverb.input = audioCtx.createGain();
    fxNodes.reverb.mix = audioCtx.createGain();
    fxNodes.reverb.mix.gain.value = 0.2;

    // Der Filter macht den Raum "warm"
    fxNodes.reverb.filter = audioCtx.createBiquadFilter();
    fxNodes.reverb.filter.type = 'lowpass';
    fxNodes.reverb.filter.frequency.value = 2500; 

    // 4 parallele Delay-Lines erzeugen die Dichte des Raums
    const delayTimes = [0.0297, 0.0371, 0.0411, 0.0437];
    fxNodes.reverb.feedbacks = [];
    const reverbSum = audioCtx.createGain();

    delayTimes.forEach(time => {
        const delay = audioCtx.createDelay(1.0);
        delay.delayTime.value = time;
        const feedback = audioCtx.createGain();
        feedback.gain.value = 0.5;

        fxNodes.reverb.input.connect(delay);
        delay.connect(feedback);
        feedback.connect(delay);
        delay.connect(reverbSum);

        fxNodes.reverb.feedbacks.push(feedback);
    });

    // Allpass-Filter verschmieren die Echos zu einem sauberen Hall
    const allpass1 = audioCtx.createBiquadFilter();
    allpass1.type = "allpass"; allpass1.frequency.value = 300;
    
    const allpass2 = audioCtx.createBiquadFilter();
    allpass2.type = "allpass"; allpass2.frequency.value = 1000;

    reverbSum.connect(allpass1);
    allpass1.connect(allpass2);
    allpass2.connect(fxNodes.reverb.filter);
    fxNodes.reverb.filter.connect(fxNodes.reverb.mix);
    fxNodes.reverb.mix.connect(masterGain);

    updateReverbDecay(0.5); 

    // 3. VIBRATO
    fxNodes.vibrato.node = audioCtx.createDelay(1.0);
    fxNodes.vibrato.input = audioCtx.createGain();
    fxNodes.vibrato.lfo = audioCtx.createOscillator();
    fxNodes.vibrato.depthNode = audioCtx.createGain();
    
    fxNodes.vibrato.node.delayTime.value = 0.03;
    fxNodes.vibrato.lfo.frequency.value = 5;
    fxNodes.vibrato.depthNode.gain.value = 0;
    
    fxNodes.vibrato.lfo.connect(fxNodes.vibrato.depthNode);
    fxNodes.vibrato.depthNode.connect(fxNodes.vibrato.node.delayTime);
    fxNodes.vibrato.lfo.start();
    
    fxNodes.vibrato.input.connect(fxNodes.vibrato.node);
    fxNodes.vibrato.node.connect(masterGain);

    // 4. FILTER
    fxNodes.filter.input = audioCtx.createGain();
    fxNodes.filter.node1 = audioCtx.createBiquadFilter(); 
    fxNodes.filter.node2 = audioCtx.createBiquadFilter(); 
    fxNodes.filter.drive = audioCtx.createWaveShaper();
    
    fxNodes.filter.node1.type = 'lowpass';
    fxNodes.filter.node2.type = 'lowpass';
    fxNodes.filter.node1.frequency.value = 20000;
    fxNodes.filter.node2.frequency.value = 20000;
    fxNodes.filter.node1.Q.value = 0;
    fxNodes.filter.node2.Q.value = 0;
    
    fxNodes.filter.drive.curve = getWarmDistortionCurve(0);
    fxNodes.filter.drive.oversample = '4x';
    
    fxNodes.filter.input.connect(fxNodes.filter.drive);
    fxNodes.filter.drive.connect(fxNodes.filter.node1);
    fxNodes.filter.node1.connect(fxNodes.filter.node2);
    fxNodes.filter.node2.connect(masterGain);

    // 5. STUTTER GATE
    fxNodes.stutter.input = audioCtx.createGain();
    fxNodes.stutter.gate = audioCtx.createGain();
    fxNodes.stutter.lfo = audioCtx.createOscillator();
    
    fxNodes.stutter.lfo.type = 'square';
    fxNodes.stutter.lfo.frequency.value = 8;

    fxNodes.stutter.smoother = audioCtx.createBiquadFilter();
    fxNodes.stutter.smoother.type = 'lowpass';
    fxNodes.stutter.smoother.frequency.value = 40; 
    
    const stutterAmp = audioCtx.createGain();
    stutterAmp.gain.value = 0.5;
    const stutterOffset = audioCtx.createConstantSource();
    stutterOffset.offset.value = 0.5;
    stutterOffset.start();

    fxNodes.stutter.gate.gain.value = 0;
    fxNodes.stutter.lfo.connect(fxNodes.stutter.smoother);
    fxNodes.stutter.smoother.connect(stutterAmp);
    
    stutterAmp.connect(fxNodes.stutter.gate.gain);
    stutterOffset.connect(fxNodes.stutter.gate.gain);
    fxNodes.stutter.lfo.start();

    fxNodes.stutter.input.connect(fxNodes.stutter.gate);
    fxNodes.stutter.gate.connect(masterGain); 

    tracks.forEach((t, i) => {
        trackAnalysers[i] = audioCtx.createAnalyser();
        trackAnalysers[i].fftSize = 256;

        trackSends[i] = {
            dry: audioCtx.createGain(),
            delay: audioCtx.createGain(),
            reverb: audioCtx.createGain(),
            vibrato: audioCtx.createGain(),
            filter: audioCtx.createGain(),
            stutter: audioCtx.createGain()
        };
        
        trackSends[i].dry.gain.value = 1.0;
        trackSends[i].delay.gain.value = 0;
        trackSends[i].reverb.gain.value = 0;
        trackSends[i].vibrato.gain.value = 0;
        trackSends[i].filter.gain.value = 0;
        trackSends[i].stutter.gain.value = 0;

        trackSends[i].dry.connect(trackAnalysers[i]);
        trackAnalysers[i].connect(masterGain);

        trackSends[i].delay.connect(fxNodes.delay.input);
        trackSends[i].reverb.connect(fxNodes.reverb.input);
        trackSends[i].vibrato.connect(fxNodes.vibrato.input);
        trackSends[i].filter.connect(fxNodes.filter.input);
        trackSends[i].stutter.connect(fxNodes.stutter.input);
    });

    if (updateRoutingCallback) updateRoutingCallback();
}

// Steuert jetzt live das Feedback-Netzwerk statt Puffer neu zu berechnen!
export function updateReverbDecay(decayVal) {
    if (!audioCtx || !fxNodes.reverb.feedbacks) return;
    // Mappt den Regler (0-1) auf sichere Feedback-Werte, damit es sich nicht aufschaukelt
    const fbValue = 0.3 + (decayVal * 0.58); 
    fxNodes.reverb.feedbacks.forEach(fb => {
        fb.gain.setTargetAtTime(fbValue, audioCtx.currentTime, 0.05);
    });
}

export function connectTrackToFX(trackGain, index) {
    if (!audioCtx || !trackSends[index]) return;
    trackGain.connect(trackSends[index].dry); 
    trackGain.connect(trackSends[index].delay);
    trackGain.connect(trackSends[index].reverb);
    trackGain.connect(trackSends[index].vibrato);
    trackGain.connect(trackSends[index].filter);
    trackGain.connect(trackSends[index].stutter);
}

export function updateTrackVolume(track) {
    if (track.gainNode && audioCtx) {
        track.gainNode.gain.setTargetAtTime(track.mute ? 0 : track.vol, audioCtx.currentTime, 0.05);
    }
}

export function getDistortionCurve(amount = 50) {
    const k = typeof amount === 'number' ? amount : 50;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
        const x = i * 2 / n_samples - 1;
        curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

export function getWarmDistortionCurve(amount = 0) {
    const k = amount / 10; 
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    for (let i = 0; i < n_samples; ++i) {
        let x = i * 2 / n_samples - 1;
        curve[i] = Math.tanh(x * (1 + k));
    }
    return curve;
}

export function mapYToFrequency(y, height) {
    return Math.max(20, Math.min(1000 - (y / height) * 920, 20000));
}

export function quantizeFrequency(freq, scale) {
    const scales = {
        major: [0, 2, 4, 5, 7, 9, 11],
        minor: [0, 2, 3, 5, 7, 8, 10],
        pentatonic: [0, 3, 5, 7, 10], 
        blues: [0, 3, 5, 6, 7, 10]
    };
    const activeScale = scales[scale] || scales.major;
    
    let m = Math.round(69 + 12 * Math.log2(freq / 440));
    let mod = m % 12;
    let b = activeScale[0];
    let md = 99;
    
    activeScale.forEach(p => {
        if (Math.abs(p - mod) < md) { md = Math.abs(p - mod); b = p; }
    });
    
    return 440 * Math.pow(2, (m - mod + b - 69) / 12);
}