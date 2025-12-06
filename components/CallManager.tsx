import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Phone, Video, Mic, MicOff, VideoOff, PhoneOff, RotateCcw, X, User as UserIcon, AlertCircle, Volume2, VolumeX } from 'lucide-react';
import { db } from '../services/firebase';
import { collection, doc, onSnapshot, addDoc, updateDoc, serverTimestamp, query, where, setDoc } from 'firebase/firestore';
import { User, ChatConfig } from '../types';
import { initAudio, startRingtone, stopRingtone } from '../utils/helpers';

// Public Google STUN servers are reliable for most P2P scenarios
const ICE_SERVERS = {
  iceServers: [
    { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302', 'stun:stun.relay.metered.ca:80'] },
    {
        urls: "turn:standard.relay.metered.ca:80",
        username: "4aa8db5b8a8c31527e2495be",
        credential: "8O6d1Nc3j8iAsTiq",
      },
      {
        urls: "turn:standard.relay.metered.ca:80?transport=tcp",
        username: "4aa8db5b8a8c31527e2495be",
        credential: "8O6d1Nc3j8iAsTiq",
      },
      {
        urls: "turn:standard.relay.metered.ca:443",
        username: "4aa8db5b8a8c31527e2495be",
        credential: "8O6d1Nc3j8iAsTiq",
      },
      {
        urls: "turns:standard.relay.metered.ca:443?transport=tcp",
        username: "4aa8db5b8a8c31527e2495be",
        credential: "8O6d1Nc3j8iAsTiq",
      }
  ],
  iceCandidatePoolSize: 10,
};

interface CallManagerProps {
  user: User;
  config: ChatConfig;
  users: any[]; 
  onCloseParticipants: () => void;
  showParticipants: boolean;
}

interface CallState {
  status: 'idle' | 'calling' | 'incoming' | 'connected';
  callId: string | null;
  isCaller: boolean;
  remoteName: string;
  remoteAvatar: string;
  type: 'audio' | 'video';
}

const CallManager: React.FC<CallManagerProps> = ({ user, config, users, onCloseParticipants, showParticipants }) => {
  // --- UI State ---
  const [viewState, setViewState] = useState<CallState>({
    status: 'idle',
    callId: null,
    isCaller: false,
    remoteName: '',
    remoteAvatar: '',
    type: 'video'
  });
  
  const [isMuted, setIsMuted] = useState(false); // Microphone mute
  const [isSpeakerMuted, setIsSpeakerMuted] = useState(false); // Speaker mute
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [incomingData, setIncomingData] = useState<any>(null);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // --- Logic Refs (No Re-renders) ---
  const pc = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const remoteStream = useRef<MediaStream | null>(null);
  const unsubscribeRefs = useRef<(() => void)[]>([]);
  
  // --- DOM Refs ---
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  // ============================================================
  // CLEANUP
  // ============================================================
  const cleanup = useCallback(() => {
    // 1. Stop Media Tracks
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => {
          track.stop();
          track.enabled = false;
      });
      localStream.current = null;
    }
    
    // 2. Close Peer Connection
    if (pc.current) {
      pc.current.onicecandidate = null;
      pc.current.ontrack = null;
      pc.current.close();
      pc.current = null;
    }

    // 3. Clear Remote Stream
    if (remoteStream.current) {
        remoteStream.current.getTracks().forEach(t => t.stop());
        remoteStream.current = null;
    }

    // 4. Unsubscribe Listeners
    unsubscribeRefs.current.forEach(unsub => unsub());
    unsubscribeRefs.current = [];

    // 5. Stop Ringtone (Using helper)
    stopRingtone();

    // 6. Reset UI
    setViewState({
      status: 'idle',
      callId: null,
      isCaller: false,
      remoteName: '',
      remoteAvatar: '',
      type: 'video'
    });
    setIncomingData(null);
    setErrorMsg(null);
    setIsMuted(false);
    setIsSpeakerMuted(false);
    setIsVideoOff(false);
    
    // 7. Reset video elements
    if (localVideoRef.current) {
        localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
    }
  }, []);

  // ============================================================
  // MEDIA HANDLING
  // ============================================================
  const getMediaStream = async (type: 'audio' | 'video', preferredMode: 'user' | 'environment') => {
      // Check for insecure context (HTTP) which blocks WebRTC on non-localhost
      const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      const isSecure = location.protocol === 'https:';
      if (!isLocalhost && !isSecure) {
          throw new Error("WebRTC requires HTTPS. Please deploy with SSL or use localhost.");
      }

      // Enhanced Mobile Detection (Fix for iPad/Tablets being detected as desktop)
      // Check for standard mobile UA OR MacIntel with touch points (iPadOS 13+)
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) 
        || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

      // Constraints Strategy:
      let constraints: MediaStreamConstraints;

      if (type === 'video') {
          if (isMobile) {
              // On mobile/tablet, respect facing mode for camera switching
              constraints = {
                  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                  video: { facingMode: preferredMode }
              };
          } else {
              // Desktop: Simple constraints often work better, prioritize resolution
              constraints = {
                  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                  video: { width: { ideal: 1280 }, height: { ideal: 720 } } 
              };
          }
      } else {
          constraints = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false };
      }

      try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          return stream;
      } catch (err: any) {
          console.warn("[Media] Ideal constraints failed, trying fallback:", err);
          // Fallback: Try bare minimum
          try {
              return await navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' });
          } catch (finalErr) {
              console.error("[Media] Fallback failed:", finalErr);
              throw finalErr;
          }
      }
  };

  // ============================================================
  // PEER CONNECTION SETUP
  // ============================================================
  const createPC = useCallback((callId: string, isCaller: boolean) => {
    const newPC = new RTCPeerConnection(ICE_SERVERS);
    pc.current = newPC;

    // A. Add Local Tracks to PC
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => {
        newPC.addTrack(track, localStream.current!);
      });
    }

    // B. Handle Remote Stream
    if (!remoteStream.current) {
        remoteStream.current = new MediaStream();
    }

    newPC.ontrack = (event) => {
      console.log("[WebRTC] Remote track received:", event.track.kind, event.track.id);
      event.track.enabled = true;
      if (remoteStream.current) {
          remoteStream.current.addTrack(event.track);
      }

      if (remoteVideoRef.current) {
        if (remoteVideoRef.current.srcObject !== remoteStream.current) {
            remoteVideoRef.current.srcObject = remoteStream.current;
        }
        remoteVideoRef.current.muted = false; // Default unmuted, will be updated by state
        remoteVideoRef.current.volume = 1.0;
        remoteVideoRef.current.play().catch(e => console.error("AutoPlay blocked", e));
      }
    };

    // C. Handle ICE Candidates
    newPC.onicecandidate = (event) => {
      if (event.candidate) {
          const collectionName = isCaller ? 'offerCandidates' : 'answerCandidates';
          addDoc(collection(db, "chats", config.roomKey, "calls", callId, collectionName), event.candidate.toJSON());
      }
    };

    // D. Monitor Connection State
    newPC.onconnectionstatechange = () => {
        console.log("[WebRTC] State:", newPC.connectionState);
    };

    return newPC;
  }, [config.roomKey]);

  // ============================================================
  // START CALL (Caller)
  // ============================================================
  const startCall = async (targetUid: string, targetName: string, targetAvatar: string, type: 'audio' | 'video') => {
    try {
      onCloseParticipants();
      
      const stream = await getMediaStream(type, facingMode);
      localStream.current = stream;

      const callDocRef = doc(collection(db, "chats", config.roomKey, "calls"));
      const callId = callDocRef.id;
      
      setViewState({
        status: 'calling',
        callId: callId,
        isCaller: true,
        remoteName: targetName,
        remoteAvatar: targetAvatar,
        type: type
      });

      const connection = createPC(callId, true);
      const offerDescription = await connection.createOffer();
      await connection.setLocalDescription(offerDescription);

      const callData = {
        id: callId,
        callerId: user.uid,
        callerName: config.username,
        callerAvatar: config.avatarURL,
        calleeId: targetUid,
        type: type,
        offer: { type: offerDescription.type, sdp: offerDescription.sdp },
        status: 'offering',
        createdAt: serverTimestamp()
      };
      await setDoc(callDocRef, callData);

      const unsubDoc = onSnapshot(callDocRef, (snapshot) => {
        const data = snapshot.data();
        if (!data) return; 

        if (!connection.currentRemoteDescription && data?.answer) {
          const answerDescription = new RTCSessionDescription(data.answer);
          connection.setRemoteDescription(answerDescription);
          setViewState(prev => ({ ...prev, status: 'connected' }));
        }
        
        if (data.status === 'ended' || data.status === 'declined') {
          cleanup();
        }
      });
      unsubscribeRefs.current.push(unsubDoc);

      const candidatesQuery = query(collection(db, "chats", config.roomKey, "calls", callId, "answerCandidates"));
      const unsubCandidates = onSnapshot(candidatesQuery, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const candidate = new RTCIceCandidate(change.doc.data());
            connection.addIceCandidate(candidate).catch(e => console.log("Candidate error", e));
          }
        });
      });
      unsubscribeRefs.current.push(unsubCandidates);

    } catch (error: any) {
      console.error("Start Call Error:", error);
      setErrorMsg(error.message || "Failed to start call");
      if (localStream.current) {
          localStream.current.getTracks().forEach(t => t.stop());
          localStream.current = null;
      }
      setTimeout(() => cleanup(), 3000);
    }
  };

  // ============================================================
  // ANSWER CALL (Callee)
  // ============================================================
  const answerCall = async () => {
    if (!incomingData) return;

    const callId = incomingData.id;
    const offer = incomingData.offer;

    try {
      initAudio();
      stopRingtone(); // Stop ringtone when answering

      const stream = await getMediaStream(incomingData.type, facingMode);
      localStream.current = stream;

      const connection = createPC(callId, false);

      await connection.setRemoteDescription(new RTCSessionDescription(offer));

      const answerDescription = await connection.createAnswer();
      await connection.setLocalDescription(answerDescription);

      const callRef = doc(db, "chats", config.roomKey, "calls", callId);
      await updateDoc(callRef, {
        answer: { type: answerDescription.type, sdp: answerDescription.sdp },
        status: 'answered'
      });

      setViewState({
        status: 'connected',
        callId: callId,
        isCaller: false,
        remoteName: incomingData.callerName,
        remoteAvatar: incomingData.callerAvatar,
        type: incomingData.type
      });
      setIncomingData(null); 

      const candidatesQuery = query(collection(db, "chats", config.roomKey, "calls", callId, "offerCandidates"));
      const unsubCandidates = onSnapshot(candidatesQuery, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const candidate = new RTCIceCandidate(change.doc.data());
            connection.addIceCandidate(candidate).catch(e => console.log("Candidate error", e));
          }
        });
      });
      unsubscribeRefs.current.push(unsubCandidates);

      const unsubDoc = onSnapshot(callRef, (snapshot) => {
          if (snapshot.data()?.status === 'ended') {
              cleanup();
          }
      });
      unsubscribeRefs.current.push(unsubDoc);

    } catch (error: any) {
      console.error("Answer Call Error:", error);
      setErrorMsg(error.message || "Failed to answer call");
      setTimeout(() => cleanup(), 3000);
    }
  };

  // ============================================================
  // LISTENERS & UI HELPERS
  // ============================================================
  
  useEffect(() => {
    if (viewState.status !== 'idle') return;

    const q = query(
      collection(db, "chats", config.roomKey, "calls"),
      where("calleeId", "==", user.uid),
      where("status", "==", "offering")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data();
          setIncomingData({ id: change.doc.id, ...data });
          
          // Play Ringtone using Web Audio API for iOS support
          startRingtone();
        }
        if (change.type === 'removed') {
          stopRingtone();
          setIncomingData(null);
        }
      });
    });

    return () => unsubscribe();
  }, [config.roomKey, user.uid, viewState.status]);

  // Force re-attach streams when view state changes to connected
  useEffect(() => {
    if (viewState.status === 'connected' || viewState.status === 'calling') {
       if (localVideoRef.current && localStream.current) {
           localVideoRef.current.srcObject = localStream.current;
           localVideoRef.current.muted = true;
       }
       if (remoteVideoRef.current && remoteStream.current) {
           remoteVideoRef.current.srcObject = remoteStream.current;
           remoteVideoRef.current.muted = isSpeakerMuted; // Use state
           remoteVideoRef.current.volume = 1.0;
           remoteVideoRef.current.play().catch(console.error);
       }
    }
  }, [viewState.status, viewState.type]);

  // Handle speaker mute toggle syncing with video element
  useEffect(() => {
    if (remoteVideoRef.current) {
        remoteVideoRef.current.muted = isSpeakerMuted;
    }
  }, [isSpeakerMuted]);

  const handleHangup = async () => {
    if (viewState.callId) {
        const callRef = doc(db, "chats", config.roomKey, "calls", viewState.callId);
        await updateDoc(callRef, { status: 'ended' }).catch(() => {});
    }
    cleanup();
  };

  const handleReject = async () => {
      if (incomingData) {
          const callRef = doc(db, "chats", config.roomKey, "calls", incomingData.id);
          await updateDoc(callRef, { status: 'declined' }).catch(() => {});
      }
      cleanup();
  };

  const toggleMute = () => {
      if (localStream.current) {
          localStream.current.getAudioTracks().forEach(t => t.enabled = !t.enabled);
          setIsMuted(!isMuted);
      }
  };

  const toggleVideo = () => {
      if (localStream.current) {
          localStream.current.getVideoTracks().forEach(t => t.enabled = !t.enabled);
          setIsVideoOff(!isVideoOff);
      }
  };

  const switchCamera = async () => {
      if (!localStream.current || viewState.type !== 'video') return;
      const newMode = facingMode === 'user' ? 'environment' : 'user';
      
      try {
          localStream.current.getVideoTracks().forEach(t => t.stop());
          
          const newStream = await getMediaStream('video', newMode);
          if (!newStream) return;
          
          if (pc.current) {
              const videoTrack = newStream.getVideoTracks()[0];
              const sender = pc.current.getSenders().find(s => s.track?.kind === 'video');
              if (sender) sender.replaceTrack(videoTrack);
          }
          
          const audioTracks = localStream.current.getAudioTracks();
          if(audioTracks.length > 0) {
              if (newStream.getAudioTracks().length === 0) {
                  newStream.addTrack(audioTracks[0]);
              }
          }

          localStream.current = newStream;
          setFacingMode(newMode);
          
          if (localVideoRef.current) {
              localVideoRef.current.srcObject = newStream;
          }
      } catch (e) {
          console.error("Switch camera failed", e);
      }
  };

  // ============================================================
  // RENDERING
  // ============================================================

  if (errorMsg) {
      return (
          <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[100] bg-red-500 text-white px-6 py-3 rounded-full shadow-xl flex items-center gap-2 animate-in fade-in slide-in-from-top-4">
              <AlertCircle size={20} />
              <span className="text-sm font-medium">{errorMsg}</span>
              <button onClick={cleanup}><X size={16} /></button>
          </div>
      );
  }

  if (incomingData) {
      return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-md p-4">
              <div className="bg-white dark:bg-slate-800 rounded-3xl p-8 w-full max-w-sm text-center border border-white/10 shadow-2xl flex flex-col items-center gap-6 animate-in zoom-in-95 duration-300">
                  <div className="relative">
                      <img 
                        src={incomingData.callerAvatar} 
                        alt="Caller" 
                        className="w-28 h-28 rounded-full object-cover border-4 border-blue-500 shadow-xl bg-slate-200"
                      />
                      <div className="absolute inset-0 rounded-full border-4 border-blue-400 animate-ping opacity-20"></div>
                  </div>
                  
                  <div>
                      <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-1">
                          {incomingData.callerName}
                      </h3>
                      <p className="text-slate-500 dark:text-slate-400 font-medium animate-pulse">
                          Incoming {incomingData.type === 'video' ? 'Video' : 'Audio'} Call...
                      </p>
                  </div>

                  <div className="flex items-center justify-center gap-8 w-full mt-2">
                      <button 
                          onClick={handleReject} 
                          className="flex flex-col items-center gap-2 group"
                      >
                          <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center text-red-500 border-2 border-red-500/20 group-hover:bg-red-500 group-hover:text-white transition-all duration-300">
                              <PhoneOff size={32} fill="currentColor" />
                          </div>
                          <span className="text-sm text-slate-500 font-medium">Decline</span>
                      </button>

                      <button 
                          onClick={answerCall} 
                          className="flex flex-col items-center gap-2 group"
                      >
                          <div className="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center text-white shadow-lg shadow-green-500/40 group-hover:scale-110 transition-transform duration-300 animate-bounce">
                              {incomingData.type === 'video' ? <Video size={32} fill="currentColor" /> : <Phone size={32} fill="currentColor" />}
                          </div>
                          <span className="text-sm text-slate-500 font-medium">Answer</span>
                      </button>
                  </div>
              </div>
          </div>
      );
  }

  if (viewState.status !== 'idle') {
      const showRemoteVideo = viewState.type === 'video' && viewState.status === 'connected';
      
      return (
          <div className="fixed inset-0 z-[100] bg-slate-950 flex flex-col">
              {/* Main Media Area */}
              <div className="flex-1 relative overflow-hidden bg-black flex items-center justify-center">
                  
                  {/* Remote Video - Always rendered, used for audio too */}
                  <video 
                      ref={remoteVideoRef} 
                      autoPlay 
                      playsInline 
                      className={`w-full h-full object-contain ${showRemoteVideo ? '' : 'hidden'}`} 
                  />
                  
                  {/* Placeholder / Audio View */}
                  {(!showRemoteVideo) && (
                      <div className="flex flex-col items-center z-10 animate-in fade-in zoom-in duration-500 p-6 text-center">
                           <div className="relative mb-6">
                                <img 
                                    src={viewState.remoteAvatar} 
                                    className="w-32 h-32 rounded-full border-4 border-white/10 shadow-2xl bg-slate-800 object-cover" 
                                />
                                {viewState.status === 'calling' && (
                                    <div className="absolute inset-0 rounded-full border-4 border-white/20 animate-ping opacity-30"></div>
                                )}
                           </div>
                           <h3 className="text-3xl font-bold text-white mb-2">{viewState.remoteName}</h3>
                           <p className="text-white/60 text-lg font-medium">
                               {viewState.status === 'calling' ? 'Calling...' : 'Connected'}
                           </p>
                      </div>
                  )}

                  {/* Local Video (PiP) */}
                  {viewState.type === 'video' && (
                      <div className="absolute top-4 right-4 w-28 sm:w-32 aspect-[3/4] bg-slate-900 rounded-xl overflow-hidden shadow-2xl border border-white/10 z-20 transition-all hover:scale-105 cursor-pointer">
                          <video 
                            ref={localVideoRef} 
                            autoPlay 
                            playsInline 
                            muted 
                            className="w-full h-full object-cover transform scale-x-[-1]" 
                          />
                      </div>
                  )}
              </div>

              {/* Controls Bar */}
              <div className="bg-slate-900/90 backdrop-blur-lg p-6 pb-10 flex items-center justify-center gap-3 sm:gap-6 z-30 border-t border-white/5">
                  <button 
                      onClick={toggleMute} 
                      className={`p-3 sm:p-4 rounded-full transition-all ${isMuted ? 'bg-white text-slate-900' : 'bg-slate-800 text-white hover:bg-slate-700'}`}
                      title={isMuted ? "Unmute Mic" : "Mute Mic"}
                  >
                      {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                  </button>

                  <button 
                      onClick={() => setIsSpeakerMuted(!isSpeakerMuted)} 
                      className={`p-3 sm:p-4 rounded-full transition-all ${isSpeakerMuted ? 'bg-white text-slate-900' : 'bg-slate-800 text-white hover:bg-slate-700'}`}
                      title={isSpeakerMuted ? "Unmute Sound" : "Mute Sound"}
                  >
                      {isSpeakerMuted ? <VolumeX size={24} /> : <Volume2 size={24} />}
                  </button>
                  
                  {viewState.type === 'video' && (
                    <>
                        <button 
                            onClick={toggleVideo} 
                            className={`p-3 sm:p-4 rounded-full transition-all ${isVideoOff ? 'bg-white text-slate-900' : 'bg-slate-800 text-white hover:bg-slate-700'}`}
                            title={isVideoOff ? "Turn Camera On" : "Turn Camera Off"}
                        >
                            {isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}
                        </button>
                        <button 
                            onClick={switchCamera} 
                            className="p-3 sm:p-4 rounded-full bg-slate-800 text-white hover:bg-slate-700 transition-all"
                            title="Switch Camera"
                        >
                            <RotateCcw size={24} />
                        </button>
                    </>
                  )}

                  <button 
                      onClick={handleHangup} 
                      className="p-3 sm:p-4 rounded-full bg-red-500 text-white hover:bg-red-600 transition-all shadow-lg shadow-red-500/40 hover:scale-110"
                      title="End Call"
                  >
                      <PhoneOff size={32} fill="currentColor" />
                  </button>
              </div>
          </div>
      );
  }

  // 3. Participants List Modal
  if (showParticipants) {
      return (
        <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm flex items-start justify-end p-4 sm:p-6" onClick={onCloseParticipants}>
            <div className="bg-white dark:bg-slate-800 w-full max-w-xs rounded-2xl shadow-2xl border border-slate-100 dark:border-slate-700 overflow-hidden animate-in slide-in-from-right-4 mt-14" onClick={e => e.stopPropagation()}>
                <div className="p-4 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center bg-slate-50/50 dark:bg-slate-900/50">
                    <h3 className="font-bold text-slate-800 dark:text-slate-100">Participants ({users.length})</h3>
                    <button onClick={onCloseParticipants} className="p-1 rounded-full hover:bg-slate-200 dark:hover:bg-slate-700 transition"><X size={20} className="text-slate-500 dark:text-slate-400" /></button>
                </div>
                <div className="max-h-[60vh] overflow-y-auto p-2 space-y-1">
                    {users.filter(u => u.uid !== user.uid).map((u) => (
                        <div key={u.uid} className="flex items-center justify-between p-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-xl transition group">
                            <div className="flex items-center gap-3 overflow-hidden">
                                <img src={u.avatar} className="w-10 h-10 rounded-full bg-slate-200 dark:bg-slate-600 object-cover" />
                                <span className="font-medium text-slate-700 dark:text-slate-200 truncate">{u.username}</span>
                            </div>
                            <div className="flex gap-1">
                                <button 
                                    onClick={() => startCall(u.uid, u.username, u.avatar, 'audio')}
                                    className="p-2 text-slate-400 hover:text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg transition"
                                    title="Voice Call"
                                >
                                    <Phone size={18} />
                                </button>
                                <button 
                                    onClick={() => startCall(u.uid, u.username, u.avatar, 'video')}
                                    className="p-2 text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition"
                                    title="Video Call"
                                >
                                    <Video size={18} />
                                </button>
                            </div>
                        </div>
                    ))}
                    {users.length <= 1 && (
                        <div className="p-8 text-center text-slate-400 dark:text-slate-500 flex flex-col items-center gap-2">
                            <UserIcon size={40} className="opacity-20" />
                            <p className="text-sm">No one else is here yet.</p>
                            <p className="text-xs text-slate-400">Share your room PIN!</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
      );
  }

  return null;
};

export default CallManager;
