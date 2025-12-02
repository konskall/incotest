import React, { useState, useEffect } from 'react';
import LoginScreen from './components/LoginScreen';
import ChatScreen from './components/ChatScreen';
import { ChatConfig } from './types';

const App: React.FC = () => {
  const [chatConfig, setChatConfig] = useState<ChatConfig | null>(null);

  useEffect(() => {
     // Check local storage for auto-login attempt logic could go here.
     // Currently we rely on LoginScreen to read from localStorage and pre-fill fields.
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
    <div className="h-[100dvh] w-full">
      {chatConfig ? (
        <ChatScreen config={chatConfig} onExit={handleExit} />
      ) : (
        <LoginScreen onJoin={handleJoin} />
      )}
    </div>
  );
};

export default App;
