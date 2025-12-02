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

export function playBeep() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 600;
    gain.gain.value = 0.17;
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.18);
    // Cleanup
    setTimeout(() => {
        if(ctx.state !== 'closed') ctx.close();
    }, 250);
  } catch (e) {
    console.log('Audio not supported');
  }
}

// Helper to extract YouTube ID
export function getYouTubeId(url: string): string | null {
  // Updated regex to include shorts/
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=|shorts\/)([^#&?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}