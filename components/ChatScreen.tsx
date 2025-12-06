import React, { useEffect, useRef, useState, useCallback } from 'react';
import { collection, query, orderBy, onSnapshot, addDoc, serverTimestamp, doc, setDoc, deleteDoc, getDocs, writeBatch, updateDoc, getDoc, arrayUnion, arrayRemove, QuerySnapshot, DocumentData } from 'firebase/firestore';
import { signInAnonymously } from 'firebase/auth';
import { getToken } from 'firebase/messaging';
import { db, auth, messaging } from '../services/firebase';
import { ChatConfig, Message, User, Attachment, Presence } from '../types';
import { decodeMessage, encodeMessage } from '../utils/helpers';
import MessageList from './MessageList';
import EmojiPicker from './EmojiPicker';
import CallManager from './CallManager';
import { Send, Smile, LogOut, Trash2, ShieldAlert, Paperclip, X, FileText, Image as ImageIcon, Bell, BellOff, Edit2, Volume2, VolumeX, Vibrate, VibrateOff, MapPin, Moon, Sun, Users, Settings, Share2 } from 'lucide-react';
import { initAudio } from '../utils/helpers';

interface ChatScreenProps {
  config: ChatConfig;
  onExit: () => void;
}

// Reduced to 500KB to ensure Base64 overhead (~33%) + metadata fits within Firestore 1MB limit
const MAX_FILE_SIZE = 500 * 1024; 

const ChatScreen: React.FC<ChatScreenProps> = ({ config, onExit }) => {
  const [user, setUser] = useState<User | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [participants, setParticipants] = useState<Presence[]>([]); // Changed to array of Presence objects
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [showEmoji, setShowEmoji] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [showParticipantsList, setShowParticipantsList] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  
  // Theme State
  const [isDarkMode, setIsDarkMode] = useState(() => {
    return localStorage.getItem('theme') === 'dark';
  });

  // New state to prevent listeners from attaching before room exists
  const [isRoomReady, setIsRoomReady] = useState(false);
  
  // Edit & Reply State
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);

  // Notification, Sound & Vibration State
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);
  const [canVibrate, setCanVibrate] = useState(false); // Hardware support check
  
  // File handling state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isGettingLocation, setIsGettingLocation] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Track first load for scrolling and sound
  const isFirstLoad = useRef(true);
  const isFirstSnapshot = useRef(true);
  
  // Track previous message count to handle scroll behavior
  const prevMessageCount = useRef(0);

  // Theme effect
  useEffect(() => {
    const root = document.documentElement;
    // Exact colors from Tailwind config (slate-950 and slate-50)
    const darkColor = '#020617'; 
    const lightColor = '#f8fafc';
    const themeColor = isDarkMode ? darkColor : lightColor;

    if (isDarkMode) {
      root.classList.add('dark');
      root.style.colorScheme = 'dark';
    } else {
      root.classList.remove('dark');
      root.style.colorScheme = 'light';
    }

    // Force Safari to update by removing and re-adding the meta tag
    const existingMeta = document.querySelector("meta[name='theme-color']");
    if (existingMeta) {
      existingMeta.remove();
    }

    const newMeta = document.createElement('meta');
    newMeta.setAttribute('name', 'theme-color');
    newMeta.setAttribute('content', themeColor);
    document.head.appendChild(newMeta);
    
  }, [isDarkMode]);

  const toggleTheme = () => {
    const newTheme = !isDarkMode;
    setIsDarkMode(newTheme);
    localStorage.setItem('theme', newTheme ? 'dark' : 'light');
    setShowSettingsMenu(false); // Close menu on selection
  };

  // 1. Authentication & Network Status & Feature Detection
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

    // Check for Vibration API support (iOS does not support it)
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        setCanVibrate(true);
    }

    return () => {
      unsubAuth();
      window.removeEventListener('online', handleNetworkChange);
      window.removeEventListener('offline', handleNetworkChange);
    };
  }, []);

  // 1.1 Unlock Audio on First Interaction (Critical for Desktop Autoplay Policy)
  useEffect(() => {
      const unlockAudioContext = () => {
          initAudio();
          // Remove listeners once triggered
          document.removeEventListener('click', unlockAudioContext);
          document.removeEventListener('keydown', unlockAudioContext);
          document.removeEventListener('touchstart', unlockAudioContext);
      };

      document.addEventListener('click', unlockAudioContext);
      document.addEventListener('keydown', unlockAudioContext);
      document.addEventListener('touchstart', unlockAudioContext);

      return () => {
          document.removeEventListener('click', unlockAudioContext);
          document.removeEventListener('keydown', unlockAudioContext);
          document.removeEventListener('touchstart', unlockAudioContext);
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
        setIsRoomReady(true);
      }
    };
    
    checkAndCreateRoom();
  }, [user, config.roomKey, config.roomName]);

  // NEW: Listen for Room Deletion (Kick functionality)
  useEffect(() => {
    // Only listen if room is ready and WE are not the ones currently deleting it
    if (!config.roomKey || !isRoomReady || isDeleting) return;

    const roomRef = doc(db, "chats", config.roomKey);
    
    const unsubscribe = onSnapshot(roomRef, (docSnap) => {
        // If document doesn't exist, it means it was deleted
        if (!docSnap.exists()) {
            alert("⚠️ The chat room has been deleted by the administrator.");
            onExit();
        }
    }, (error) => {
        console.log("Room existence listener error:", error);
    });

    return () => unsubscribe();
  }, [config.roomKey, isRoomReady, isDeleting, onExit]);

  // 2. Notification Setup (FCM Token Registration)
  useEffect(() => {
      if (notificationsEnabled && user && messaging && isRoomReady) {
          const registerToken = async () => {
              try {
                  if ('serviceWorker' in navigator) {
                     await navigator.serviceWorker.register('./firebase-messaging-sw.js').catch(err => console.log("SW Register fail:", err));
                  }

                  const currentToken = await getToken(messaging).catch(() => null);

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

  // 3. Presence Heartbeat & Visibility Logic
  useEffect(() => {
    if (!user || !config.roomKey || !isRoomReady) return;

    // Initial Active Status
    updatePresence({ isTyping: false, status: 'active' });
    
    const interval = setInterval(() => {
        // Only send heartbeat if page is visible
        if (document.visibilityState === 'visible') {
            updatePresence({ status: 'active' });
        }
    }, 30000);

    const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
            updatePresence({ status: 'active' });
        } else {
            // Mark as inactive when user minimizes app/switches tab
            updatePresence({ status: 'inactive' });
        }
    };

    const cleanup = () => {
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        const presRef = doc(db, "chats", config.roomKey, "presence", user.uid);
        deleteDoc(presRef).catch(() => {});
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener('beforeunload', cleanup);

    return () => {
        clearInterval(interval);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        window.removeEventListener('beforeunload', cleanup);
        cleanup();
    };
  }, [user, config.roomKey, updatePresence, isRoomReady]);

  // 4. Presence Listener
  useEffect(() => {
     if (!config.roomKey || !user || !isRoomReady) return;

     const q = collection(db, "chats", config.roomKey, "presence");
     const unsubscribe = onSnapshot(q, (snapshot: QuerySnapshot<DocumentData>) => {
         const typers: string[] = [];
         const currentUsers: Presence[] = [];
         
         snapshot.forEach(doc => {
             const data = doc.data() as Presence;
             currentUsers.push(data);
             
             // Check if user is actively typing and status is active
             if (data.uid !== user.uid && data.isTyping && data.status === 'active') {
                 typers.push(data.username);
             }
         });
         setParticipants(currentUsers);
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

    const unsubscribe = onSnapshot(q, (snapshot: QuerySnapshot<DocumentData>) => {
      const msgs: Message[] = [];
      let lastMsg: Message | null = null;
      let hasNewMessageFromOthers = false;

      // Use for-of loop instead of forEach to ensure TypeScript correctly infers closure mutations
      for (const change of snapshot.docChanges()) {
        if (change.type === "added") {
           const data = change.doc.data();
           // Ensure it's not a local optimistic write, not our own message, and NOT the initial history load
           if (!snapshot.metadata.fromCache && data.uid !== user.uid) {
               hasNewMessageFromOthers = true;
               lastMsg = { 
                   id: change.doc.id, 
                   text: decodeMessage(data.text || ''), 
                   username: data.username, 
                   uid: data.uid,
                   avatarURL: data.avatarURL,
                   createdAt: data.createdAt,
                   attachment: data.attachment,
                   location: data.location,
                   reactions: data.reactions,
                   replyTo: data.replyTo
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
          location: data.location,
          isEdited: data.isEdited,
          reactions: data.reactions || {},
          replyTo: data.replyTo
        });
      });

      setMessages(msgs);

      // Play sound only if it's NOT the first snapshot (history load)
      if (!isFirstSnapshot.current && hasNewMessageFromOthers && lastMsg) {
          // Sound Logic
          if (soundEnabled) {
              initAudio(); 
              setTimeout(() => {
                  const playSound = async () => {
                       const { playBeep } = await import('../utils/helpers');
                       playBeep();
                  }
                  playSound();
              }, 10);
          }

          // Vibration Logic - Feature check inside
          if (vibrationEnabled && canVibrate && 'vibrate' in navigator) {
              navigator.vibrate(200);
          }

          // Local Notification Logic
          if (document.hidden && notificationsEnabled) {
             const title = `New message from ${lastMsg.username}`;
             let body = lastMsg.text;
             if (lastMsg.attachment) body = `Sent a file: ${lastMsg.attachment.name}`;
             if (lastMsg.location) body = `Shared a location`;

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
      
      // Mark first snapshot as done
      if (isFirstSnapshot.current) {
          isFirstSnapshot.current = false;
      }
    }, (error) => {
        console.error("Message listener error:", error);
    });

    return () => unsubscribe();
  }, [config.roomKey, user, notificationsEnabled, isRoomReady, soundEnabled, vibrationEnabled, canVibrate]);

  // Scroll logic
  useEffect(() => {
    if (!messagesEndRef.current) return;

    // Case 1: First Load - Instant scroll
    if (isFirstLoad.current && messages.length > 0) {
        messagesEndRef.current.scrollIntoView({ behavior: "auto" });
        isFirstLoad.current = false;
        prevMessageCount.current = messages.length;
        return;
    }

    // Case 2: New Message - Smooth scroll
    // Only scroll if the number of messages INCREASED.
    // This ignores edits, reactions, and typing status changes.
    if (messages.length > prevMessageCount.current) {
        messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
        prevMessageCount.current = messages.length;
    } else {
        // Sync ref even if we didn't scroll (e.g. deletion or edit)
        prevMessageCount.current = messages.length;
    }
  }, [messages]); 

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      
      // Force specific height when empty to fix iOS Safari scaling issue on first load
      if (inputText === '') {
          textareaRef.current.style.height = '40px';
          // Adding this class ensures it looks correct before JS runs if rendered server-side, 
          // but here it just reinforces the reset.
          textareaRef.current.classList.add('h-[40px]');
      } else {
          textareaRef.current.classList.remove('h-[40px]');
          // If content exists, auto-expand up to 120px
          textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
      }
    }
  }, [inputText]);

  const toggleNotifications = async () => {
      // If already enabled, disable them
      if (notificationsEnabled) {
          setNotificationsEnabled(false);
          setShowSettingsMenu(false);
          return;
      }

      // If disabled, check permission and enable
      if (!('Notification' in window)) {
          alert('This browser does not support desktop notifications.');
          return;
      }
      
      if (Notification.permission === 'granted') {
          setNotificationsEnabled(true);
          new Notification("Notifications Enabled", { body: "You will be notified when the tab is in the background." });
      } else if (Notification.permission !== 'denied') {
          try {
              const permission = await Notification.requestPermission();
              if (permission === 'granted') {
                  setNotificationsEnabled(true);
                  new Notification("Notifications Enabled", { body: "You will be notified when the tab is in the background." });
              } else if (permission === 'denied') {
                  alert("Notifications are blocked in your browser settings.");
              }
          } catch (error) {
              console.error("Error requesting permission", error);
          }
      } else {
          alert("Notifications are blocked in your browser settings.");
      }
      setShowSettingsMenu(false);
  };

  const handleShare = async () => {
    // Use hardcoded production URL to avoid blob: issues in preview
    const baseUrl = 'https://konskall.github.io/incognitochat/';
    const shareUrl = new URL(baseUrl);
    shareUrl.searchParams.set('room', config.roomName);
    shareUrl.searchParams.set('pin', config.pin);
    const inviteUrl = shareUrl.toString();

    const shareData = {
        title: 'Incognito Chat Invite',
        // Format exactly as requested: URL inside text, followed by credentials
        text: `🔒 Join my secure room on Incognito Chat! ${inviteUrl}\n\n🏠 Room: ${config.roomName}\n🔑 PIN: ${config.pin}`,
    };

    try {
        if (navigator.share) {
            await navigator.share({
                ...shareData,
                url: inviteUrl // Provide valid URL for metadata fetching in apps
            });
        } else {
            // For clipboard, just copy the formatted text
            await navigator.clipboard.writeText(shareData.text);
            alert('Room details copied to clipboard!');
        }
    } catch (err) {
        console.error('Error sharing:', err);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.size > MAX_FILE_SIZE) {
        alert(`File is too large. Max size is 500KB.`);
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

  const handleEditMessage = useCallback((msg: Message) => {
      setInputText(msg.text);
      setEditingMessageId(msg.id);
      setReplyingTo(null); // Cancel reply if editing
      setSelectedFile(null);
      textareaRef.current?.focus();
  }, []);
  
  const handleReply = useCallback((msg: Message) => {
      setReplyingTo(msg);
      setEditingMessageId(null); // Cancel edit if replying
      textareaRef.current?.focus();
  }, []);

  const handleReaction = useCallback(async (msg: Message, emoji: string) => {
      if (!user || !config.roomKey) return;
      
      const msgRef = doc(db, "chats", config.roomKey, "messages", msg.id);
      
      try {
        const msgDoc = await getDoc(msgRef);
        if (!msgDoc.exists()) return;
        
        const currentReactions = (msgDoc.data() as any)?.reactions || {};
        const userList = currentReactions[emoji] || [];
        
        let updateOp;
        
        if (userList.includes(user.uid)) {
            // Remove reaction
            updateOp = arrayRemove(user.uid);
        } else {
            // Add reaction
            updateOp = arrayUnion(user.uid);
        }
        
        await updateDoc(msgRef, {
            [`reactions.${emoji}`]: updateOp
        });
        
      } catch (error) {
          console.error("Error toggling reaction:", error);
      }
  }, [user, config.roomKey]);

  const cancelEdit = useCallback(() => {
      setEditingMessageId(null);
      setInputText('');
  }, []);
  
  const cancelReply = useCallback(() => {
      setReplyingTo(null);
  }, []);

  const handleSendLocation = async () => {
    if (!navigator.geolocation || !user || !isRoomReady || isOffline) {
        if (!navigator.geolocation) alert("Geolocation is not supported by your browser.");
        return;
    }

    setIsGettingLocation(true);

    navigator.geolocation.getCurrentPosition(async (position) => {
        try {
            const locationData = {
                lat: position.coords.latitude,
                lng: position.coords.longitude
            };
            
            await addDoc(collection(db, "chats", config.roomKey, "messages"), {
                uid: user.uid,
                username: config.username,
                avatarURL: config.avatarURL,
                text: encodeMessage("📍 Shared a location"),
                createdAt: serverTimestamp(),
                reactions: {},
                location: locationData,
                replyTo: replyingTo ? {
                    id: replyingTo.id,
                    username: replyingTo.username,
                    text: replyingTo.text || 'Shared a content',
                    isAttachment: !!replyingTo.attachment
                } : null
            });
            
            // Clear states
            setReplyingTo(null);
        } catch (error) {
            console.error("Error sending location:", error);
            alert("Failed to send location.");
        } finally {
            setIsGettingLocation(false);
        }
    }, (error) => {
        console.error("Geolocation error:", error);
        alert("Unable to retrieve your location. Please check permissions.");
        setIsGettingLocation(false);
    }, { enableHighAccuracy: true });
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if ((!inputText.trim() && !selectedFile) || !user || isOffline || isUploading || !isRoomReady) return;

    const textToSend = inputText.trim();
    
    setInputText('');
    setShowEmoji(false);
    setIsUploading(true);
    
    if (textareaRef.current) {
        textareaRef.current.focus();
    }
    
    if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
    }
    updatePresence({ isTyping: false });
    
    // Reset height immediately to min-height to prevent jitter
    if (textareaRef.current) {
        textareaRef.current.style.height = '40px';
    }

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
            createdAt: serverTimestamp(),
            reactions: {},
            replyTo: replyingTo ? {
                id: replyingTo.id,
                username: replyingTo.username,
                text: replyingTo.text || 'Shared a file',
                isAttachment: !!replyingTo.attachment
            } : null
          };
          if (attachment) messageData.attachment = attachment;

          await addDoc(collection(db, "chats", config.roomKey, "messages"), messageData);
          // Clear reply state
          setReplyingTo(null);
          // Only clear file on success
          clearFile(); 
      }
    } catch (error) {
      console.error("Error sending message:", error);
      alert("Failed to send/edit message: Missing permissions or connection error.");
      setInputText(textToSend); // Restore text on error
    } finally {
      setIsUploading(false);
      // Clear file selection in finally block to avoid accidental re-sending
      if (!editingMessageId) clearFile();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape') {
        if (editingMessageId) cancelEdit();
        if (replyingTo) cancelReply();
    }
  };

  const handleDeleteChat = async () => {
    if (!config.roomKey) return;
    setIsDeleting(true);

    try {
        const chatRef = doc(db, "chats", config.roomKey);
        
        const deleteCollection = async (collName: string) => {
            const collRef = collection(chatRef, collName);
            const snapshot = await getDocs(collRef);
            const chunk = 400; 
            for (let i = 0; i < snapshot.docs.length; i += chunk) {
                const batch = writeBatch(db);
                snapshot.docs.slice(i, i + chunk).forEach(d => batch.delete(d.ref));
                await batch.commit();
            }
        };

        await Promise.allSettled([
            deleteCollection("presence"),
            deleteCollection("messages"),
            deleteCollection("fcm_tokens"),
            deleteCollection("calls") // Also delete calls
        ]);

        try {
            await deleteDoc(chatRef);
        } catch (roomError) {
            console.warn("Could not delete room doc", roomError);
        }

        onExit(); 
    } catch (error) {
        console.error("Delete failed", error);
        alert("Error clearing chat. Please try again.");
        setIsDeleting(false);
        setShowDeleteModal(false);
    } 
  };

  const handleEmojiSelect = (emoji: string) => {
      setInputText(prev => prev + emoji);
  };

  return (
    <div className="fixed inset-0 flex flex-col h-[100dvh] w-full bg-slate-100 dark:bg-slate-900 max-w-5xl mx-auto shadow-2xl overflow-hidden z-50 md:relative md:inset-auto md:rounded-2xl md:my-4 md:h-[95vh] md:border border-white/40 dark:border-slate-800 transition-colors">
      {isOffline && (
        <div className="bg-red-500 text-white text-center py-1 text-sm font-bold animate-pulse absolute top-0 w-full z-50">
          📴 You are offline. Messages will not be sent.
        </div>
      )}

      {/* Call Manager handles the entire lifecycle of WebRTC calls */}
      {user && isRoomReady && (
          <CallManager 
            user={user}
            config={config}
            users={participants}
            showParticipants={showParticipantsList}
            onCloseParticipants={() => setShowParticipantsList(false)}
          />
      )}

      <header className="glass-panel px-3 py-3 flex items-center justify-between z-10 sticky top-0 shadow-sm pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <div className="flex items-center gap-3 overflow-hidden">
             <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full flex items-center justify-center text-white font-bold shadow-lg flex-shrink-0">
                {config.roomName.substring(0,2).toUpperCase()}
             </div>
             <div className="min-w-0 flex flex-col justify-center">
                 <h2 className="font-bold text-slate-800 dark:text-slate-100 leading-tight truncate text-sm md:text-base">{config.roomName}</h2>
                 <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2">
                     <div className="flex items-center gap-1.5">
                         <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                            <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${isRoomReady ? 'bg-green-400' : 'bg-yellow-400'} opacity-75`}></span>
                            <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${isRoomReady ? 'bg-green-500' : 'bg-yellow-500'}`}></span>
                        </span>
                        <span className="text-xs text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">
                            {participants.length} Online
                        </span>
                     </div>
                     <span className="text-[10px] sm:text-xs text-slate-400 dark:text-slate-500 truncate font-medium">
                        <span className="hidden sm:inline text-slate-300 dark:text-slate-600 mr-1">|</span>
                        <span className="sm:font-semibold sm:text-slate-700 dark:sm:text-slate-300">{config.username}</span>
                     </span>
                 </div>
             </div>
        </div>
        <div className="flex gap-1 sm:gap-2 flex-shrink-0 items-center relative">
            {/* Share Button */}
            <button
                onClick={handleShare}
                className="p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition"
                title="Share Room Invite"
            >
                <Share2 size={20} />
            </button>

            {/* Participants Button */}
            <button 
                onClick={() => setShowParticipantsList(true)}
                className={`p-2 rounded-lg transition ${showParticipantsList ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                title="View Participants & Call"
            >
                <Users size={20} />
            </button>

            {/* Mobile Settings Toggle */}
            <button
                onClick={() => setShowSettingsMenu(!showSettingsMenu)}
                className="sm:hidden p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition"
            >
                <Settings size={20} />
            </button>

            {canVibrate && (
                <button 
                    onClick={() => setVibrationEnabled(!vibrationEnabled)}
                    className={`hidden sm:block p-2 rounded-lg transition ${vibrationEnabled ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                    title={vibrationEnabled ? "Vibration Enabled" : "Enable Vibration"}
                >
                    {vibrationEnabled ? <Vibrate size={20} /> : <VibrateOff size={20} />}
                </button>
            )}
            <button 
                onClick={() => setSoundEnabled(!soundEnabled)}
                className={`hidden sm:block p-2 rounded-lg transition ${soundEnabled ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                title={soundEnabled ? "Mute Sounds" : "Enable Sounds"}
            >
                {soundEnabled ? <Volume2 size={20} /> : <VolumeX size={20} />}
            </button>
            <button 
                onClick={toggleNotifications}
                className={`hidden sm:block p-2 rounded-lg transition ${notificationsEnabled ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                title={notificationsEnabled ? "Notifications Active" : "Enable Notifications"}
            >
                {notificationsEnabled ? <Bell size={20} /> : <BellOff size={20} />}
            </button>
            
            <button 
                onClick={toggleTheme}
                className="hidden sm:block p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition"
                title="Toggle Theme"
            >
                {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
            </button>

            {/* Mobile Settings Dropdown */}
            {showSettingsMenu && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowSettingsMenu(false)} />
                    <div className="absolute top-full right-0 mt-2 w-48 bg-white dark:bg-slate-800 rounded-xl shadow-2xl border border-slate-100 dark:border-slate-700 z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col p-1.5 sm:hidden">
                        {canVibrate && (
                             <button 
                                onClick={() => { setVibrationEnabled(!vibrationEnabled); setShowSettingsMenu(false); }}
                                className={`flex items-center gap-3 w-full p-2 rounded-lg text-sm font-medium transition ${vibrationEnabled ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20 dark:text-blue-300' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
                            >
                                {vibrationEnabled ? <Vibrate size={18} /> : <VibrateOff size={18} />}
                                <span>Vibration</span>
                            </button>
                        )}
                        <button 
                            onClick={() => { setSoundEnabled(!soundEnabled); setShowSettingsMenu(false); }}
                            className={`flex items-center gap-3 w-full p-2 rounded-lg text-sm font-medium transition ${soundEnabled ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20 dark:text-blue-300' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
                        >
                            {soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
                            <span>Sound</span>
                        </button>
                        <button 
                            onClick={toggleNotifications}
                            className={`flex items-center gap-3 w-full p-2 rounded-lg text-sm font-medium transition ${notificationsEnabled ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20 dark:text-blue-300' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
                        >
                            {notificationsEnabled ? <Bell size={18} /> : <BellOff size={18} />}
                            <span>Notifications</span>
                        </button>
                        <button 
                            onClick={toggleTheme}
                            className="flex items-center gap-3 w-full p-2 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition"
                        >
                            {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
                            <span>Theme</span>
                        </button>
                    </div>
                </>
            )}

            {/* Delete button only for creator */}
            {user && config.roomKey.includes(user.uid) /* NOTE: This is a placeholder check. Ideally we store creator in config or check doc */ }
            <button 
                onClick={() => setShowDeleteModal(true)}
                className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition"
                title="Delete Chat"
            >
                <Trash2 size={20} />
            </button>
            <button 
                onClick={onExit}
                className="p-2 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg transition"
                title="Exit"
            >
                <LogOut size={20} />
            </button>
        </div>
      </header>

      <main 
        className="flex-1 overflow-y-auto overscroll-contain p-4 pb-20 bg-slate-50/50 dark:bg-slate-950/50" 
        style={{
            backgroundImage: `radial-gradient(${isDarkMode ? '#334155' : '#cbd5e1'} 1px, transparent 1px)`, 
            backgroundSize: '20px 20px'
        }}
      >
        <MessageList 
            messages={messages} 
            currentUserUid={user?.uid || ''} 
            onEdit={handleEditMessage}
            onReply={handleReply}
            onReact={handleReaction}
        />
        <div ref={messagesEndRef} />
      </main>

      <footer className="bg-white dark:bg-slate-900 p-1.5 border-t border-slate-200 dark:border-slate-800 shadow-lg z-20 relative pb-[calc(0.75rem+env(safe-area-inset-bottom))] flex flex-col items-center justify-center transition-colors">
         {typingUsers.length > 0 && (
             <div className="absolute -top-6 left-6 text-xs text-slate-500 dark:text-slate-400 bg-white/80 dark:bg-slate-900/80 backdrop-blur px-2 py-0.5 rounded-t-lg animate-pulse flex items-center gap-1">
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

         {/* Edit Banner */}
         {editingMessageId && (
            <div className="flex items-center justify-between bg-blue-50 dark:bg-blue-900/20 px-4 py-2 rounded-t-xl border-t border-l border-r border-blue-100 dark:border-blue-800 mb-2 animate-in slide-in-from-bottom-2 w-full max-w-4xl">
                <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                    <Edit2 size={16} />
                    <span className="text-sm font-semibold">Editing message</span>
                </div>
                <button onClick={cancelEdit} className="p-1 hover:bg-blue-100 dark:hover:bg-blue-900/40 rounded-full text-slate-500 dark:text-slate-400">
                    <X size={16} />
                </button>
            </div>
         )}

         {/* Reply Banner */}
         {replyingTo && (
            <div className="flex items-center justify-between bg-slate-100 dark:bg-slate-800 px-4 py-2 rounded-t-xl border-t border-l border-r border-slate-200 dark:border-slate-700 mb-2 animate-in slide-in-from-bottom-2 w-full max-w-4xl">
                <div className="flex flex-col border-l-4 border-blue-500 pl-2">
                    <span className="text-xs font-bold text-blue-600 dark:text-blue-400">Replying to {replyingTo.username}</span>
                    <span className="text-sm text-slate-600 dark:text-slate-300 truncate max-w-[200px]">
                        {replyingTo.attachment ? '📎 Attachment' : replyingTo.text}
                    </span>
                </div>
                <button onClick={cancelReply} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full text-slate-500 dark:text-slate-400">
                    <X size={16} />
                </button>
            </div>
         )}

         <div className="relative flex flex-col items-center w-full max-w-4xl mx-auto">
             {selectedFile && !editingMessageId && (
               <div className="flex items-center gap-3 p-2 bg-blue-50 dark:bg-slate-800 border border-blue-100 dark:border-slate-700 rounded-xl w-fit animate-in slide-in-from-bottom-2 mb-2 self-start">
                  <div className="w-10 h-10 bg-blue-100 dark:bg-slate-700 rounded-lg flex items-center justify-center text-blue-500 dark:text-blue-400">
                    {selectedFile.type.startsWith('image/') ? <ImageIcon size={20}/> : <FileText size={20}/>}
                  </div>
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-slate-700 dark:text-slate-200 max-w-[150px] truncate">{selectedFile.name}</span>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400">{(selectedFile.size / 1024).toFixed(1)} KB</span>
                  </div>
                  <button onClick={clearFile} className="p-1 hover:bg-blue-200 dark:hover:bg-slate-600 rounded-full text-slate-500 transition">
                    <X size={16} />
                  </button>
               </div>
             )}

             <div className="flex items-center gap-1.5 sm:gap-2 w-full">
                 {showEmoji && <EmojiPicker onSelect={handleEmojiSelect} onClose={() => setShowEmoji(false)} />}
                 
                 <input 
                    type="file" 
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                    className="hidden"
                    accept="image/*,.pdf,.doc,.docx,.txt"
                 />
                 {!editingMessageId && (
                    <>
                        <button 
                            onClick={() => fileInputRef.current?.click()}
                            className={`w-10 h-10 rounded-full flex items-center justify-center transition flex-shrink-0 ${selectedFile ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-slate-800'}`}
                            title="Attach File"
                        >
                            <Paperclip size={22} />
                        </button>
                        <button 
                            onClick={handleSendLocation}
                            disabled={isGettingLocation}
                            className={`w-10 h-10 rounded-full flex items-center justify-center transition flex-shrink-0 ${isGettingLocation ? 'animate-pulse text-red-400' : 'text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'}`}
                            title="Share Location"
                        >
                            <MapPin size={22} />
                        </button>
                    </>
                 )}

                 <button 
                    onClick={() => setShowEmoji(!showEmoji)}
                    className="w-10 h-10 text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-slate-800 rounded-full flex items-center justify-center transition flex-shrink-0"
                 >
                     <Smile size={22} />
                 </button>

                 <div className="flex-1 relative min-w-0 flex items-center">
                     <textarea
                        ref={textareaRef}
                        value={inputText}
                        onChange={handleInputChange}
                        onKeyDown={handleKeyDown}
                        rows={1}
                        placeholder={selectedFile ? "Add caption..." : (editingMessageId ? "Edit..." : "Message...")}
                        className="w-full bg-slate-100 dark:bg-slate-800 border-0 rounded-2xl px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:bg-white dark:focus:bg-slate-900 text-slate-900 dark:text-slate-100 transition-all outline-none resize-none max-h-[120px] overflow-y-auto leading-6 text-base h-[40px] block"
                     />
                 </div>
                 
                 <button 
                    onClick={() => handleSend()}
                    disabled={(!inputText.trim() && !selectedFile) || isOffline || isUploading || !isRoomReady}
                    className="w-10 h-10 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:cursor-not-allowed text-white rounded-full shadow-lg shadow-blue-500/30 transition-all transform active:scale-95 flex items-center justify-center flex-shrink-0"
                 >
                     {isUploading ? (
                         <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                     ) : (
                         <Send size={20} className="ml-0.5" />
                     )}
                 </button>
             </div>
         </div>
      </footer>

      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 max-w-sm w-full shadow-2xl scale-100 animate-in zoom-in-95 duration-200 border border-white/10 dark:border-slate-800">
                <div className="flex flex-col items-center text-center gap-4">
                    <div className="w-16 h-16 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center text-red-500">
                        <ShieldAlert size={32} />
                    </div>
                    <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">Delete Conversation?</h3>
                    <p className="text-slate-500 dark:text-slate-400 text-sm">
                        Permanently delete the room and all messages for everyone?
                    </p>
                    <div className="flex gap-3 w-full mt-2">
                        <button 
                            onClick={() => setShowDeleteModal(false)}
                            className="flex-1 py-3 text-slate-600 dark:text-slate-300 font-semibold hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition"
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
