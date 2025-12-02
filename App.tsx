import React, { useState, useEffect } from 'react';
import LoginScreen from './components/LoginScreen';
import ChatScreen from './components/ChatScreen';
import { ChatConfig } from './types';
import { generateRoomKey } from './utils/helpers';

const App: React.FC = () => {
  const [chatConfig, setChatConfig] = useState<ChatConfig | null>(null);

  useEffect(() => {
    // Auto-login logic: Check local storage for session details
    const storedPin = localStorage.getItem('chatPin');
    const storedRoomName = localStorage.getItem('chatRoomName');
    const storedUsername = localStorage.getItem('chatUsername');
    const storedAvatar = localStorage.getItem('chatAvatarURL');

    if (storedPin && storedRoomName && storedUsername) {
      const roomKey = generateRoomKey(storedPin, storedRoomName);
      setChatConfig({
        username: storedUsername,
        avatarURL: storedAvatar || '',
        roomName: storedRoomName,
        pin: storedPin,
        roomKey: roomKey
      });
    }
  }, []);

  const handleJoin = (config: ChatConfig) => {
    setChatConfig(config);
  };

  const handleExit = () => {
    setChatConfig(null);
    localStorage.removeItem("chatPin");
    localStorage.removeItem("chatRoomName");
    // We keep username/avatar in localstorage for convenience
  };

  return (
    <div className="min-h-[100dvh] w-full">
      {chatConfig ? (
        <ChatScreen config={chatConfig} onExit={handleExit} />
      ) : (
        <LoginScreen onJoin={handleJoin} />
      )}
    </div>
  );
};

export default App;
