// Base64 encode
export function encodeMessage(str: string): string {
  try {
    return btoa(unescape(encodeURIComponent(str)));
  } catch (e) {
    console.error("Encoding error", e);
    return str;
  }
}

// Base64 decode
export function decodeMessage(str: string): string {
  try {
    return decodeURIComponent(escape(atob(str)));
  } catch (e) {
    return str;
  }
}

export function generateRoomKey(pin: string, roomName: string): string {
  return `${roomName.toLowerCase().trim()}_${pin.trim()}`;
}

// Singleton AudioContext to prevent running out of hardware contexts
let audioCtx: AudioContext | null = null;
let ringNodes: AudioNode[] = []; // Store active ringtone nodes

export function initAudio() {
  try {
    if (!audioCtx) {
       audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(console.error);
    }
    // Play a silent oscillator to fully unlock audio on iOS/Chrome without making noise
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0; // Silence
    oscillator.connect(gain);
    gain.connect(audioCtx.destination);
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.01);
  } catch (e) {
    // Ignore errors if audio is not supported
  }
}

export function playBeep() {
  try {
    if (!audioCtx) {
       initAudio();
    }
    if (!audioCtx) return;
    
    // Resume if suspended (common in browsers preventing autoplay)
    if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(console.error);
    }

    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    oscillator.type = 'sine';
    oscillator.frequency.value = 600;
    gain.gain.value = 0.17;
    
    oscillator.connect(gain);
    gain.connect(audioCtx.destination);
    
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.18);
  } catch (e) {
    console.log('Audio not supported or blocked');
  }
}

// Starts a persistent ringtone (phone ringing sound)
export function startRingtone() {
    try {
        if (!audioCtx) initAudio();
        if (!audioCtx) return;
        
        // Ensure context is running (crucial for iOS)
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(console.error);

        stopRingtone(); // Stop any existing ring

        const t = audioCtx.currentTime;
        const gain = audioCtx.createGain();
        // Increased gain for visibility on desktop speakers
        gain.gain.value = 0.5; 
        gain.connect(audioCtx.destination);
        ringNodes.push(gain);

        // Schedule a repeating ring pattern for 45 seconds
        // Pattern: "Drring-Drring" ... pause ...
        for (let i = 0; i < 15; i++) {
            const start = t + (i * 3); // Loop every 3s
            
            // Tone 1 (0.4s)
            createRingOsc(start, 0.4, 600, gain);
            // Tone 2 (0.4s)
            createRingOsc(start + 0.5, 0.4, 500, gain);
        }
    } catch (e) {
        console.error("Ringtone error:", e);
    }
}

function createRingOsc(time: number, duration: number, freq: number, dest: AudioNode) {
    if(!audioCtx) return;
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, time);
    // Slight modulation for a "phone" feel
    osc.frequency.linearRampToValueAtTime(freq * 0.95, time + duration);
    
    osc.connect(dest);
    osc.start(time);
    osc.stop(time + duration);
    ringNodes.push(osc);
}

export function stopRingtone() {
    ringNodes.forEach(n => {
        try { 
            if (n instanceof OscillatorNode) n.stop();
            n.disconnect(); 
        } catch(e) {}
    });
    ringNodes = [];
}

// Helper to extract YouTube ID
export function getYouTubeId(url: string): string | null {
  // Updated regex to include shorts/
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=|shorts\/)([^#&?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}
