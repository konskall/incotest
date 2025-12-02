import React, { useEffect, useRef, useState, useCallback } from 'react';
import { collection, query, orderBy, onSnapshot, addDoc, serverTimestamp, doc, setDoc, deleteDoc, getDocs, writeBatch, updateDoc, getDoc } from 'firebase/firestore';
import { signInAnonymously } from 'firebase/auth';
import { getToken } from 'firebase/messaging';
import { db, auth, messaging } from '../services/firebase';
import { ChatConfig, Message, User, Attachment, Presence } from '../types';
import { decodeMessage, encodeMessage, playBeep } from '../utils/helpers';
import MessageList from './MessageList';
import EmojiPicker from './EmojiPicker';
import { Send, Smile, LogOut, Trash2, ShieldAlert, Paperclip, X, FileText, Image as ImageIcon, Bell, BellOff, Edit2 } from 'lucide-react';

interface ChatScreenProps {
  config: ChatConfig;
  onExit: () => void;
}

const MAX_FILE_SIZE = 700 * 1024; // 700KB limit (Firestore doc limit is 1MB)

const ChatScreen: React.FC<ChatScreenProps> = ({ config, onExit }) => {
  const [user, setUser] = useState<User | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [participants, setParticipants] = useState(0);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [showEmoji, setShowEmoji] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  
  // New state to prevent listeners from attaching before room exists
  const [isRoomReady, setIsRoomReady] = useState(false);
  
  // Edit State
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  // Notification State
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  
  // File handling state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 1. Authentication & Network Status
  useEffect(() => {
    const unsubAuth = auth.onAuthStateChanged((u) => {
      if (u) {
        setUser({ uid: u.uid, isAnonymous: u.isAnonymous });
      } else {
        signInAnonymously(auth).catch((error) => {
          console.error("Auth Error:", error);
        });
      }
    });

    const handleNetworkChange = () => setIsOffline(!navigator.onLine);
    window.addEventListener('online', handleNetworkChange);
    window.addEventListener('offline', handleNetworkChange);

    // Check if permission was already granted in a previous session
    if ('Notification' in window && Notification.permission === 'granted') {
      setNotificationsEnabled(true);
    }

    return () => {
      unsubAuth();
      window.removeEventListener('online', handleNetworkChange);
      window.removeEventListener('offline', handleNetworkChange);
    };
  }, []);

  // 1.5 Initialize Room Document
  useEffect(() => {
    const checkAndCreateRoom = async () => {
      if (!user || !config.roomKey) return;
      
      const roomRef = doc(db, "chats", config.roomKey);
      
      try {
        const roomDoc = await getDoc(roomRef);
        
        if (roomDoc.exists()) {
           // Room exists, just update timestamp
           await updateDoc(roomRef, {
             lastActive: serverTimestamp()
           });
        } else {
           // Room doesn't exist, create it
           await setDoc(roomRef, {
             createdAt: serverTimestamp(),
             roomKey: config.roomKey,
             roomName: config.roomName,
             createdBy: user.uid,
             lastActive: serverTimestamp()
           });
        }
        setIsRoomReady(true);
      } catch (error) {
        console.error("Error initializing room:", error);
        // Fallback: If creation fails (e.g. permission issues), we still set ready 
        // to true so we can attempt to read messages/subcollections if allowed.
        setIsRoomReady(true);
      }
    };
    
    checkAndCreateRoom();
  }, [user, config.roomKey, config.roomName]);

  // 2. Notification Setup (FCM Token Registration)
  useEffect(() => {
      // Only attempt FCM registration if messaging is supported and user enabled notifications
      if (notificationsEnabled && user && messaging && isRoomReady) {
          
          // Helper to register token
          const registerToken = async () => {
              try {
                  if ('serviceWorker' in navigator) {
                     // We ignore errors here because in some dev environments SW registration might fail
                     // or the file might be missing in specific bundler setups.
                     await navigator.serviceWorker.register('./firebase-messaging-sw.js').catch(err => console.log("SW Register fail (harmless for local notifications):", err));
                  }

                  // We removed the 'vapidKey' option. It will try to use the default project config.
                  // If you haven't generated a Web Push Certificate in Firebase Console, this might still fail,
                  // but we catch it so it doesn't break the app.
                  const currentToken = await getToken(messaging).catch(err => {
                      console.log("FCM Token generation failed (Push notifications won't work, but Local will):", err);
                      return null;
                  });

                  if (currentToken) {
                      const tokenRef = doc(db, "chats", config.roomKey, "fcm_tokens", user.uid);
                      await setDoc(tokenRef, {
                          token: currentToken,
                          uid: user.uid,
                          username: config.username,
                          updatedAt: serverTimestamp()
                      });
                  }
              } catch (err) {
                  console.log("Notification setup warning:", err);
              }
          };

          registerToken();
      }
  }, [notificationsEnabled, user, config.roomKey, config.username, isRoomReady]);

  // Helper function to update presence
  const updatePresence = useCallback((overrides: Partial<Presence> = {}) => {
    if (!user || !config.roomKey || !isRoomReady) return;
    const uid = user.uid;
    const presRef = doc(db, "chats", config.roomKey, "presence", uid);

    setDoc(presRef, {
        uid,
        username: config.username,
        avatar: config.avatarURL,
        lastSeen: serverTimestamp(),
        status: "active",
        ...overrides
    }, { merge: true }).catch(console.error);
  }, [user, config.roomKey, config.username, config.avatarURL, isRoomReady]);

  // 3. Presence Heartbeat
  useEffect(() => {
    if (!user || !config.roomKey || !isRoomReady) return;

    updatePresence({ isTyping: false });
    
    const interval = setInterval(() => {
        updatePresence();
    }, 30000);

    return () => {
        clearInterval(interval);
        const presRef = doc(db, "chats", config.roomKey, "presence", user.uid);
        deleteDoc(presRef).catch(() => {});
    };
  }, [user, config.roomKey, updatePresence, isRoomReady]);

  // 4. Presence Listener
  useEffect(() => {
     if (!config.roomKey || !user || !isRoomReady) return;

     const q = collection(db, "chats", config.roomKey, "presence");
     const unsubscribe = onSnapshot(q, (snapshot) => {
         setParticipants(snapshot.size);
         const typers: string[] = [];
         snapshot.forEach(doc => {
             const data = doc.data() as Presence;
             if (data.uid !== user.uid && data.isTyping) {
                 typers.push(data.username);
             }
         });
         setTypingUsers(typers);
     }, (error) => {
         console.log("Presence listener warning:", error.message);
     });

     return () => unsubscribe();
  }, [config.roomKey, user, isRoomReady]);

  // 5. Message Listener
  useEffect(() => {
    if (!config.roomKey || !user || !isRoomReady) return;

    const q = query(
      collection(db, "chats", config.roomKey, "messages"),
      orderBy("createdAt", "asc")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs: Message[] = [];
      let lastMsg: Message | null = null;
      let hasNewMessageFromOthers = false;

      // Use for-of loop instead of forEach to ensure TypeScript correctly infers closure mutations
      for (const change of snapshot.docChanges()) {
        if (change.type === "added") {
           const data = change.doc.data();
           // Ensure it's not a local optimistic write and not our own message
           if (!snapshot.metadata.fromCache && data.uid !== user.uid) {
               hasNewMessageFromOthers = true;
               lastMsg = { 
                   id: change.doc.id, 
                   text: decodeMessage(data.text || ''), 
                   username: data.username, 
                   uid: data.uid,
                   avatarURL: data.avatarURL,
                   createdAt: data.createdAt,
                   attachment: data.attachment // Include attachment!
               };
           }
        }
      }

      snapshot.forEach((doc) => {
        const data = doc.data();
        msgs.push({
          id: doc.id,
          text: decodeMessage(data.text || ''),
          uid: data.uid,
          username: data.username,
          avatarURL: data.avatarURL,
          createdAt: data.createdAt,
          attachment: data.attachment,
          isEdited: data.isEdited
        });
      });

      setMessages(msgs);

      if (hasNewMessageFromOthers && lastMsg) {
          playBeep();
          if (navigator.vibrate) navigator.vibrate(100);

          // Local Notification Logic (Works when tab is hidden but app is running)
          if (document.hidden && notificationsEnabled) {
             const title = `New message from ${lastMsg.username}`;
             const body = lastMsg.attachment ? `Sent a file: ${lastMsg.attachment.name}` : lastMsg.text;
             
             try {
                new Notification(title, {
                    body: body,
                    icon: '/favicon-96x96.png',
                    tag: 'chat-msg'
                });
             } catch (e) {
                 console.error("Local notification failed", e);
             }
          }
      }
    }, (error) => {
        console.error("Message listener error:", error);
    });

    return () => unsubscribe();
  }, [config.roomKey, user, notificationsEnabled, isRoomReady]);

  // Scroll logic
  useEffect(() => {
    if (!editingMessageId) {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, typingUsers, editingMessageId]); 

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [inputText]);

  const requestNotifications = async () => {
      if (!('Notification' in window)) {
          alert('This browser does not support desktop notifications.');
          return;
      }

      if (window.location.protocol === 'http:' && window.location.hostname !== 'localhost') {
          alert('Notifications require HTTPS (or localhost).');
          return;
      }

      try {
          const permission = await Notification.requestPermission();
          if (permission === 'granted') {
              setNotificationsEnabled(true);
              new Notification("Notifications Enabled", { body: "You will be notified when the tab is in the background." });
          } else if (permission === 'denied') {
              alert("Notifications are blocked in your browser settings. Please enable them manually.");
          }
      } catch (error) {
          console.error("Error requesting permission", error);
          alert("Error requesting notification permissions.");
      }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.size > MAX_FILE_SIZE) {
        alert(`File is too large. Max size is 700KB.`);
        e.target.value = '';
        return;
      }
      setSelectedFile(file);
    }
  };

  const clearFile = () => {
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const convertFileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = (error) => reject(error);
    });
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInputText(e.target.value);
      if (!user) return;
      if (!typingTimeoutRef.current) updatePresence({ isTyping: true });
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => {
          updatePresence({ isTyping: false });
          typingTimeoutRef.current = null;
      }, 2000);
  };

  const handleEditMessage = (msg: Message) => {
      setInputText(msg.text);
      setEditingMessageId(msg.id);
      setSelectedFile(null);
      textareaRef.current?.focus();
  };

  const cancelEdit = () => {
      setEditingMessageId(null);
      setInputText('');
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if ((!inputText.trim() && !selectedFile) || !user || isOffline || isUploading || !isRoomReady) return;

    const textToSend = inputText.trim();
    
    setInputText('');
    setShowEmoji(false);
    setIsUploading(true);
    
    if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
    }
    updatePresence({ isTyping: false });
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    try {
      if (editingMessageId) {
          const msgRef = doc(db, "chats", config.roomKey, "messages", editingMessageId);
          await updateDoc(msgRef, {
              text: encodeMessage(textToSend),
              isEdited: true
          });
          setEditingMessageId(null);
      } else {
          let attachment: Attachment | null = null;

          if (selectedFile) {
            const base64 = await convertFileToBase64(selectedFile);
            attachment = {
              url: base64,
              name: selectedFile.name,
              type: selectedFile.type,
              size: selectedFile.size
            };
          }

          const messageData: any = {
            uid: user.uid,
            username: config.username,
            avatarURL: config.avatarURL,
            text: encodeMessage(textToSend),
            createdAt: serverTimestamp()
          };
          if (attachment) messageData.attachment = attachment;

          await addDoc(collection(db, "chats", config.roomKey, "messages"), messageData);
          clearFile();
      }
    } catch (error) {
      console.error("Error sending message:", error);
      alert("Failed to send/edit message: Missing permissions or connection error.");
      setInputText(textToSend);
    } finally {
      setIsUploading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape' && editingMessageId) {
        cancelEdit();
    }
  };

  // Improved Delete Chat - Handles permissions gracefully and batch limits
  const handleDeleteChat = async () => {
    if (!config.roomKey) return;
    setIsDeleting(true);

    try {
        const chatRef = doc(db, "chats", config.roomKey);
        
        // 1. Delete contents (Messages & Presence & Tokens)
        // Helper to delete a collection in batches
        const deleteCollection = async (collName: string) => {
            const collRef = collection(chatRef, collName);
            const snapshot = await getDocs(collRef);
            
            // Firestore batch limit is 500
            const chunk = 400; 
            for (let i = 0; i < snapshot.docs.length; i += chunk) {
                const batch = writeBatch(db);
                snapshot.docs.slice(i, i + chunk).forEach(d => batch.delete(d.ref));
                await batch.commit();
            }
        };

        // Try deleting subcollections first
        await Promise.allSettled([
            deleteCollection("presence"),
            deleteCollection("messages"),
            deleteCollection("fcm_tokens")
        ]);

        // 2. Try deleting the room document
        // This might fail if user is not the creator, but messages are already gone
        try {
            await deleteDoc(chatRef);
        } catch (roomError) {
            console.warn("Could not delete room doc (likely permission issue), but contents cleared.", roomError);
        }

        onExit(); 
    } catch (error) {
        console.error("Delete failed", error);
        alert("Error clearing chat. Please try again.");
    } finally {
        setIsDeleting(false);
        setShowDeleteModal(false);
    }
  };

  const handleEmojiSelect = (emoji: string) => {
      setInputText(prev => prev + emoji);
  };

  return (
    // Use fixed inset-0 on mobile to lock the view preventing body scroll
    // On desktop (md), use relative positioning and standard flex layout
    <div className="fixed inset-0 flex flex-col h-[100dvh] w-full bg-slate-100 max-w-5xl mx-auto shadow-2xl overflow-hidden z-50 md:relative md:inset-auto md:rounded-2xl md:my-4 md:h-[95vh] md:border border-white/40">
      {isOffline && (
        <div className="bg-red-500 text-white text-center py-1 text-sm font-bold animate-pulse absolute top-0 w-full z-50">
          📴 You are offline. Messages will not be sent.
        </div>
      )}

      {/* Header: sticky with top padding for safe area (iPhone Notch) */}
      <header className="glass-panel px-3 py-3 flex items-center justify-between z-10 sticky top-0 shadow-sm pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <div className="flex items-center gap-3 overflow-hidden">
             <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full flex items-center justify-center text-white font-bold shadow-lg flex-shrink-0">
                {config.roomName.substring(0,2).toUpperCase()}
             </div>
             <div className="min-w-0">
                 <h2 className="font-bold text-slate-800 leading-tight truncate">{config.roomName}</h2>
                 <div className="flex items-center gap-1.5">
                     <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                        <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${isRoomReady ? 'bg-green-400' : 'bg-yellow-400'} opacity-75`}></span>
                        <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${isRoomReady ? 'bg-green-500' : 'bg-yellow-500'}`}></span>
                    </span>
                    <span className="text-xs text-slate-500 font-medium truncate">{participants} Online</span>
                 </div>
             </div>
        </div>
        <div className="flex gap-1 sm:gap-2 flex-shrink-0">
            <button 
                onClick={requestNotifications}
                className={`p-2 rounded-lg transition ${notificationsEnabled ? 'text-blue-500 bg-blue-50' : 'text-slate-400 hover:bg-slate-100'}`}
                title={notificationsEnabled ? "Notifications Active" : "Enable Notifications"}
            >
                {notificationsEnabled ? <Bell size={20} /> : <BellOff size={20} />}
            </button>
            <button 
                onClick={() => setShowDeleteModal(true)}
                className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition"
                title="Delete Chat"
            >
                <Trash2 size={20} />
            </button>
            <button 
                onClick={onExit}
                className="p-2 text-slate-500 hover:bg-slate-200 rounded-lg transition"
                title="Exit"
            >
                <LogOut size={20} />
            </button>
        </div>
      </header>

      {/* Main content: overscroll-contain prevents scrolling parent on mobile */}
      <main className="flex-1 overflow-y-auto overscroll-contain p-4 bg-slate-50/50" style={{backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)', backgroundSize: '20px 20px'}}>
        <MessageList 
            messages={messages} 
            currentUserUid={user?.uid || ''} 
            onEdit={handleEditMessage}
        />
        <div ref={messagesEndRef} />
      </main>

      {/* Footer: safe area padding bottom (iPhone Home Bar) */}
      <footer className="bg-white p-2 sm:p-3 border-t border-slate-200 shadow-lg z-20 relative pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
         {typingUsers.length > 0 && (
             <div className="absolute -top-6 left-6 text-xs text-slate-500 bg-white/80 backdrop-blur px-2 py-0.5 rounded-t-lg animate-pulse flex items-center gap-1">
                 <span className="flex gap-0.5">
                    <span className="w-1 h-1 bg-slate-400 rounded-full animate-bounce" style={{animationDelay: '0ms'}}></span>
                    <span className="w-1 h-1 bg-slate-400 rounded-full animate-bounce" style={{animationDelay: '150ms'}}></span>
                    <span className="w-1 h-1 bg-slate-400 rounded-full animate-bounce" style={{animationDelay: '300ms'}}></span>
                 </span>
                 <span className="font-medium italic">
                    {typingUsers.length === 1 
                        ? `${typingUsers[0]} is typing...` 
                        : `${typingUsers.length} people are typing...`}
                 </span>
             </div>
         )}

         {editingMessageId && (
            <div className="flex items-center justify-between bg-blue-50 px-4 py-2 rounded-t-xl border-t border-l border-r border-blue-100 mb-2 animate-in slide-in-from-bottom-2">
                <div className="flex items-center gap-2 text-blue-600">
                    <Edit2 size={16} />
                    <span className="text-sm font-semibold">Editing message</span>
                </div>
                <button onClick={cancelEdit} className="p-1 hover:bg-blue-100 rounded-full text-slate-500">
                    <X size={16} />
                </button>
            </div>
         )}

         <div className="relative flex flex-col gap-2 max-w-4xl mx-auto">
             {selectedFile && !editingMessageId && (
               <div className="flex items-center gap-3 p-2 bg-blue-50 border border-blue-100 rounded-xl w-fit animate-in slide-in-from-bottom-2">
                  <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center text-blue-500">
                    {selectedFile.type.startsWith('image/') ? <ImageIcon size={20}/> : <FileText size={20}/>}
                  </div>
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-slate-700 max-w-[150px] truncate">{selectedFile.name}</span>
                    <span className="text-[10px] text-slate-500">{(selectedFile.size / 1024).toFixed(1)} KB</span>
                  </div>
                  <button onClick={clearFile} className="p-1 hover:bg-blue-200 rounded-full text-slate-500 transition">
                    <X size={16} />
                  </button>
               </div>
             )}

             <div className="flex items-end gap-1.5 sm:gap-2">
                 {showEmoji && <EmojiPicker onSelect={handleEmojiSelect} onClose={() => setShowEmoji(false)} />}
                 
                 <input 
                    type="file" 
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                    className="hidden"
                    accept="image/*,.pdf,.doc,.docx,.txt"
                 />
                 {!editingMessageId && (
                    <button 
                        onClick={() => fileInputRef.current?.click()}
                        className={`p-2 rounded-full mb-1 transition flex-shrink-0 ${selectedFile ? 'text-blue-500 bg-blue-50' : 'text-slate-400 hover:text-blue-500 hover:bg-blue-50'}`}
                        title="Attach File"
                    >
                        <Paperclip size={24} />
                    </button>
                 )}

                 <button 
                    onClick={() => setShowEmoji(!showEmoji)}
                    className="p-2 mb-1 text-slate-400 hover:text-blue-500 hover:bg-blue-50 rounded-full transition hidden sm:block flex-shrink-0"
                 >
                     <Smile size={24} />
                 </button>

                 <div className="flex-1 relative min-w-0">
                     <textarea
                        ref={textareaRef}
                        value={inputText}
                        onChange={handleInputChange}
                        onKeyDown={handleKeyDown}
                        rows={1}
                        placeholder={selectedFile ? "Add a caption..." : (editingMessageId ? "Edit..." : "Message...")}
                        className="w-full bg-slate-100 border-0 rounded-2xl px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all outline-none resize-none max-h-[120px] overflow-y-auto leading-normal text-base"
                        style={{ minHeight: '40px' }}
                     />
                 </div>
                 
                 <button 
                    onClick={() => handleSend()}
                    disabled={(!inputText.trim() && !selectedFile) || isOffline || isUploading || !isRoomReady}
                    className="bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white p-2.5 mb-1 rounded-full shadow-lg shadow-blue-500/30 transition-all transform active:scale-95 flex items-center justify-center flex-shrink-0"
                 >
                     {isUploading ? (
                         <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                     ) : (
                         <Send size={20} />
                     )}
                 </button>
             </div>
         </div>
      </footer>

      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl scale-100 animate-in zoom-in-95 duration-200">
                <div className="flex flex-col items-center text-center gap-4">
                    <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center text-red-500">
                        <ShieldAlert size={32} />
                    </div>
                    <h3 className="text-xl font-bold text-slate-800">Delete Conversation?</h3>
                    <p className="text-slate-500 text-sm">
                        This will permanently delete the room and all messages for everyone. This action cannot be undone.
                    </p>
                    <div className="flex gap-3 w-full mt-2">
                        <button 
                            onClick={() => setShowDeleteModal(false)}
                            className="flex-1 py-3 text-slate-600 font-semibold hover:bg-slate-100 rounded-xl transition"
                        >
                            Cancel
                        </button>
                        <button 
                            onClick={handleDeleteChat}
                            disabled={isDeleting}
                            className="flex-1 py-3 bg-red-500 hover:bg-red-600 text-white font-semibold rounded-xl shadow-lg shadow-red-500/30 transition"
                        >
                            {isDeleting ? 'Deleting...' : 'Delete All'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
      )}
    </div>
  );
};

export default ChatScreen;
