import React, { useState } from 'react';
import { ChatConfig } from '../types';
import { generateRoomKey } from '../utils/helpers';
import { Info, ChevronDown, ChevronUp } from 'lucide-react';

interface LoginScreenProps {
  onJoin: (config: ChatConfig) => void;
}

const LoginScreen: React.FC<LoginScreenProps> = ({ onJoin }) => {
  const [username, setUsername] = useState(localStorage.getItem('chatUsername') || '');
  const [avatar, setAvatar] = useState(localStorage.getItem('chatAvatarURL') || '');
  const [roomName, setRoomName] = useState(localStorage.getItem('chatRoomName') || '');
  const [pin, setPin] = useState('');
  const [showGuide, setShowGuide] = useState(false);
  
  // Advanced Avatar State
  const [avatarStyle, setAvatarStyle] = useState('bottts');
  const [avatarSeed, setAvatarSeed] = useState(Math.random().toString(36).substring(7));
  const [useCustomUrl, setUseCustomUrl] = useState(!!localStorage.getItem('chatAvatarURL') && !localStorage.getItem('chatAvatarURL')?.includes('dicebear'));

  const AVATAR_STYLES = [
      { id: 'bottts', label: 'Robots' },
      { id: 'avataaars', label: 'People' },
      { id: 'micah', label: 'Minimal' },
      { id: 'adventurer', label: 'Fun' },
      { id: 'fun-emoji', label: 'Emoji' }
  ];

  const getDiceBearUrl = (style: string, seed: string) => {
      return `https://api.dicebear.com/9.x/${style}/svg?seed=${seed}`;
  };

  const regenerateAvatar = (e: React.MouseEvent) => {
      e.preventDefault();
      setAvatarSeed(Math.random().toString(36).substring(7));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (username.length < 2) {
      alert("Username must have at least 2 characters.");
      return;
    }
    if (!pin.match(/^[\w\d]{4,}$/)) {
      alert("PIN must be at least 4 characters (letters/numbers).");
      return;
    }
    if (!roomName.match(/^[\w\d]{3,}$/)) {
      alert("Room name must be at least 3 Latin characters.");
      return;
    }

    const roomKey = generateRoomKey(pin, roomName);

    // Finalize Avatar URL
    const finalAvatar = useCustomUrl ? avatar : getDiceBearUrl(avatarStyle, avatarSeed);

    // Save to local storage
    localStorage.setItem('chatUsername', username);
    localStorage.setItem('chatAvatarURL', finalAvatar);
    localStorage.setItem('chatRoomName', roomName);

    onJoin({
      username,
      avatarURL: finalAvatar,
      roomName,
      pin,
      roomKey
    });
  };

  return (
    <div className="flex flex-col items-center justify-start min-h-[100dvh] p-4 pt-2 md:pt-6 w-full max-w-md mx-auto animate-in slide-in-from-bottom-4 duration-500">
      <div className="bg-white/80 backdrop-blur-xl rounded-3xl shadow-2xl shadow-blue-500/10 w-full p-8 border border-white/50">
        <div className="flex flex-col items-center mb-6">
           <img 
            src="https://konskall.github.io/incognitochatapp/favicon-96x96.png" 
            alt="Logo" 
            className="w-16 h-16 rounded-2xl shadow-lg mb-4"
          />
          <h1 className="text-2xl font-bold text-slate-800">Incognito Chat</h1>
          <p className="text-slate-500 text-sm">Secure, anonymous, real-time.</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="text-xs font-semibold text-slate-500 ml-1 mb-1 block uppercase">Identity</label>
            <input
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={20}
              className="w-full px-4 py-3 rounded-xl bg-white border border-slate-200 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all text-base"
            />
          </div>
          
          {/* Avatar Section */}
          <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
             <div className="flex justify-between items-center mb-2">
                 <label className="text-xs font-bold text-slate-500 uppercase">Avatar</label>
                 <button 
                    type="button" 
                    onClick={() => setUseCustomUrl(!useCustomUrl)}
                    className="text-xs text-blue-500 font-semibold hover:underline"
                 >
                     {useCustomUrl ? 'Use Generator' : 'Use Custom URL'}
                 </button>
             </div>

             {useCustomUrl ? (
                <input
                    type="text"
                    placeholder="Image URL (http://...)"
                    value={avatar}
                    onChange={(e) => setAvatar(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm focus:border-blue-500 outline-none text-base"
                />
             ) : (
                <div className="flex items-center gap-3">
                    <img 
                        src={getDiceBearUrl(avatarStyle, avatarSeed)} 
                        alt="Avatar Preview" 
                        className="w-16 h-16 rounded-full bg-white shadow-sm border border-slate-200"
                    />
                    <div className="flex-1 flex flex-col gap-2">
                        <select 
                            value={avatarStyle}
                            onChange={(e) => setAvatarStyle(e.target.value)}
                            className="w-full px-2 py-1.5 rounded-lg bg-white border border-slate-200 text-sm outline-none text-base"
                        >
                            {AVATAR_STYLES.map(style => (
                                <option key={style.id} value={style.id}>{style.label}</option>
                            ))}
                        </select>
                        <button 
                            onClick={regenerateAvatar}
                            className="text-xs bg-blue-100 text-blue-600 py-1.5 rounded-lg font-semibold hover:bg-blue-200 transition"
                        >
                            🔀 Shuffle Look
                        </button>
                    </div>
                </div>
             )}
          </div>

          <div className="h-px bg-slate-200 my-2"></div>

          <div>
             <label className="text-xs font-semibold text-slate-500 ml-1 mb-1 block uppercase">Destination</label>
             <input
              type="text"
              placeholder="Room Name (e.g. secretbase)"
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              maxLength={30}
              className="w-full px-4 py-3 rounded-xl bg-white border border-slate-200 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all mb-4 text-base"
            />
            <input
              type="password"
              placeholder="Room PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              maxLength={12}
              className="w-full px-4 py-3 rounded-xl bg-white border border-slate-200 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all text-base"
            />
          </div>

          <button
            type="submit"
            className="mt-4 w-full py-3.5 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600 text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 transform transition active:scale-95 flex items-center justify-center gap-2"
          >
            Enter Room
          </button>
        </form>

        <div className="mt-6 border border-blue-100 bg-blue-50/50 rounded-xl overflow-hidden">
            <button 
                onClick={() => setShowGuide(!showGuide)}
                className="w-full flex items-center justify-between p-3 text-blue-600 font-semibold text-sm hover:bg-blue-50 transition"
            >
                <div className="flex items-center gap-2">
                    <Info size={16} />
                    <span>Quick Start Guide</span>
                </div>
                {showGuide ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            
            {showGuide && (
                <div className="p-4 bg-white/50 text-sm text-slate-600 space-y-2 border-t border-blue-100 animate-in slide-in-from-top-2">
                    <p className="flex gap-2"><span className="text-blue-500">👤</span> <strong>Username:</strong> Your display name.</p>
                    <p className="flex gap-2"><span className="text-blue-500">🔐</span> <strong>PIN:</strong> 4+ chars key.</p>
                    <p className="flex gap-2"><span className="text-blue-500">🏠</span> <strong>Room:</strong> 3+ Latin chars.</p>
                    <p className="text-xs text-slate-400 mt-2 italic">Share the Room Name and PIN to invite others.</p>
                </div>
            )}
        </div>
      </div>
      
      <footer className="mt-8 text-center text-slate-400 text-xs pb-6">
        <p>
          Incognito Chat © 2025 • Powered by{' '}
          <a 
            href="http://linkedin.com/in/konstantinos-kalliakoudis-902b90103" 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-blue-500 hover:text-blue-600 font-semibold hover:underline transition-colors"
          >
            KonsKall
          </a>
        </p>
      </footer>
    </div>
  );
};

export default LoginScreen;
