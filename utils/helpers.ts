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

export function initAudio() {
  try {
    if (!audioCtx) {
       audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
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
       audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    
    // Resume if suspended (common in browsers preventing autoplay)
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
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
    
    // Note: We do NOT close the context anymore, we keep it alive for the session.
  } catch (e) {
    console.log('Audio not supported or blocked');
  }
}

// Helper to extract YouTube ID
export function getYouTubeId(url: string): string | null {
  // Updated regex to include shorts/
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=|shorts\/)([^#&?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}
