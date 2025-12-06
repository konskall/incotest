import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Phone, Video, Mic, MicOff, VideoOff, PhoneOff, RotateCcw, X } from 'lucide-react';
import { db } from '../services/firebase';
import { collection, doc, onSnapshot, addDoc, updateDoc, serverTimestamp, query, where } from 'firebase/firestore';
import { User, ChatConfig } from '../types';
import { initAudio } from '../utils/helpers';

const ICE_SERVERS = {
  iceServers: [
    { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
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

const CallManager: React.FC<CallManagerProps> = ({ user, config, users, onCloseParticipants, showParticipants }) => {
  // UI States
  const [incomingCall, setIncomingCall] = useState<any>(null);
  const [uiCallState, setUiCallState] = useState<'idle' | 'calling' | 'connected'>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  
  // Stream State for rendering
  const [remoteStreamVal, setRemoteStreamVal] = useState<MediaStream | null>(null);

  // Refs for Logic (Stable across renders)
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const activeCallIdRef = useRef<string | null>(null);
  const ringtoneRef = useRef<HTMLAudioElement | null>(null);
  const unsubscribesRef = useRef<(() => void)[]>([]);
  const candidatesQueue = useRef<RTCIceCandidate[]>([]);

  // Refs for DOM Elements
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  // --- Cleanup Function ---
  const cleanupCall = useCallback(() => {
      // 1. Stop Ringtones
      if (ringtoneRef.current) {
          ringtoneRef.current.pause();
          ringtoneRef.current = null;
      }

      // 2. Unsubscribe Firestore listeners
      unsubscribesRef.current.forEach(unsub => unsub());
      unsubscribesRef.current = [];

      // 3. Close WebRTC
      if (peerConnection.current) {
          peerConnection.current.close();
          peerConnection.current = null;
      }

      // 4. Stop Tracks
      if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach(t => t.stop());
          localStreamRef.current = null;
      }

      // 5. Reset State / Refs
      setIncomingCall(null);
      setUiCallState('idle');
      setRemoteStreamVal(null);
      activeCallIdRef.current = null;
      candidatesQueue.current = [];
      setIsMuted(false);
      setIsVideoOff(false);
  }, []);

  // --- Audio Helpers ---
  const playRingtone = () => {
      initAudio();
      const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
      audio.loop = true;
      audio.play().catch(() => {});
      ringtoneRef.current = audio;
  };

  // --- WebRTC Setup ---
  const setupPeerConnection = (callId: string, isCaller: boolean) => {
      const pc = new RTCPeerConnection(ICE_SERVERS);
      peerConnection.current = pc;

      // ICE Candidates Handler
      pc.onicecandidate = (event) => {
          if (event.candidate) {
              const coll = isCaller ? 'offerCandidates' : 'answerCandidates';
              addDoc(collection(db, "chats", config.roomKey, "calls", callId, coll), event.candidate.toJSON());
          }
      };

      // Track Handler (Remote Stream)
      pc.ontrack = (event) => {
          console.log("Remote track received");
          const stream = event.streams[0];
          setRemoteStreamVal(stream); // Trigger render
          if (remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = stream;
              remoteVideoRef.current.play().catch(e => console.log("Autoplay blocked", e));
          }
      };

      // Add Local Tracks
      if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach(track => {
              pc.addTrack(track, localStreamRef.current!);
          });
      }

      return pc;
  };

  // --- Start Call (Caller) ---
  const initiateCall = async (targetUid: string, targetName: string, targetAvatar: string, type: 'audio' | 'video') => {
      onCloseParticipants();
      cleanupCall(); // Ensure clean state
      setUiCallState('calling');
      
      // 1. Get Media
      try {
          const stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: type === 'video' ? { facingMode: 'user' } : false
          });
          localStreamRef.current = stream;
          if (localVideoRef.current) {
              localVideoRef.current.srcObject = stream;
              localVideoRef.current.muted = true;
          }
      } catch (e) {
          alert("Could not access camera/microphone");
          cleanupCall();
          return;
      }

      // 2. Create Call Document
      const callDocRef = await addDoc(collection(db, "chats", config.roomKey, "calls"), {
          callerId: user.uid,
          callerName: config.username,
          callerAvatar: config.avatarURL,
          calleeId: targetUid,
          type,
          status: 'offering',
          createdAt: serverTimestamp()
      });
      
      const callId = callDocRef.id;
      activeCallIdRef.current = callId;

      // 3. Setup PC & Offer
      const pc = setupPeerConnection(callId, true);
      
      const offerDescription = await pc.createOffer();
      await pc.setLocalDescription(offerDescription);

      const offer = { type: offerDescription.type, sdp: offerDescription.sdp };
      await updateDoc(callDocRef, { offer });

      // 4. Listen for Answer
      const unsubDoc = onSnapshot(callDocRef, (snapshot) => {
          const data = snapshot.data();
          if (!data) return;

          if (data.status === 'answered' && data.answer && !pc.currentRemoteDescription) {
              const answerDescription = new RTCSessionDescription(data.answer);
              pc.setRemoteDescription(answerDescription).then(() => {
                  setUiCallState('connected');
                  // Flush queued candidates
                  candidatesQueue.current.forEach(cand => pc.addIceCandidate(cand));
                  candidatesQueue.current = [];
              });
          } else if (data.status === 'ended' || data.status === 'declined') {
              cleanupCall();
          }
      });
      unsubscribesRef.current.push(unsubDoc);

      // 5. Listen for Callee Candidates
      const unsubCand = onSnapshot(collection(db, "chats", config.roomKey, "calls", callId, "answerCandidates"), (snapshot) => {
          snapshot.docChanges().forEach((change) => {
              if (change.type === 'added') {
                  const candidate = new RTCIceCandidate(change.doc.data());
                  if (pc.remoteDescription) {
                      pc.addIceCandidate(candidate);
                  } else {
                      candidatesQueue.current.push(candidate);
                  }
              }
          });
      });
      unsubscribesRef.current.push(unsubCand);
  };

  // --- Answer Call (Callee) ---
  const answerCall = async () => {
      if (!incomingCall) return;
      const callId = incomingCall.id;
      const type = incomingCall.type;

      if (ringtoneRef.current) {
          ringtoneRef.current.pause();
      }

      setUiCallState('connected');
      activeCallIdRef.current = callId;
      // Important: Copy incoming call data before clearing state
      const callData = { ...incomingCall };
      setIncomingCall(null);

      // 1. Get Media
      try {
          const stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: type === 'video' ? { facingMode: 'user' } : false
          });
          localStreamRef.current = stream;
          if (localVideoRef.current) {
              localVideoRef.current.srcObject = stream;
              localVideoRef.current.muted = true;
          }
      } catch (e) {
          console.error(e);
          cleanupCall();
          return;
      }

      // 2. Setup PC
      const pc = setupPeerConnection(callId, false);

      // 3. Handle Offer & Create Answer
      const offerDescription = new RTCSessionDescription(callData.offer);
      await pc.setRemoteDescription(offerDescription);
      
      const answerDescription = await pc.createAnswer();
      await pc.setLocalDescription(answerDescription);

      const answer = { type: answerDescription.type, sdp: answerDescription.sdp };
      await updateDoc(doc(db, "chats", config.roomKey, "calls", callId), { answer, status: 'answered' });

      // 4. Listen for Caller Candidates
      const unsubCand = onSnapshot(collection(db, "chats", config.roomKey, "calls", callId, "offerCandidates"), (snapshot) => {
          snapshot.docChanges().forEach((change) => {
              if (change.type === 'added') {
                  const candidate = new RTCIceCandidate(change.doc.data());
                  pc.addIceCandidate(candidate);
              }
          });
      });
      unsubscribesRef.current.push(unsubCand);

      // 5. Listen for End
      const unsubDoc = onSnapshot(doc(db, "chats", config.roomKey, "calls", callId), (snap) => {
          if (snap.data()?.status === 'ended') {
              cleanupCall();
          }
      });
      unsubscribesRef.current.push(unsubDoc);
  };

  // --- Incoming Call Listener (Global) ---
  useEffect(() => {
      const q = query(
          collection(db, "chats", config.roomKey, "calls"),
          where("calleeId", "==", user.uid),
          where("status", "==", "offering")
      );

      const unsub = onSnapshot(q, (snapshot) => {
          snapshot.docChanges().forEach((change) => {
              if (change.type === "added") {
                  // Only accept if not already in a call
                  if (!activeCallIdRef.current) {
                      const data = change.doc.data();
                      setIncomingCall({ id: change.doc.id, ...data });
                      playRingtone();
                  }
              }
              if (change.type === "removed") {
                  // If the call request is removed while ringing
                  if (incomingCall && incomingCall.id === change.doc.id) {
                      setIncomingCall(null);
                      if (ringtoneRef.current) ringtoneRef.current.pause();
                  }
              }
          });
      });

      return () => {
          unsub();
          cleanupCall();
      };
  }, [config.roomKey, user.uid]);

  // --- User Actions ---
  const hangup = async () => {
      if (activeCallIdRef.current) {
          const ref = doc(db, "chats", config.roomKey, "calls", activeCallIdRef.current);
          await updateDoc(ref, { status: 'ended' }).catch(() => {});
      }
      cleanupCall();
  };

  const decline = async () => {
      if (incomingCall) {
          const ref = doc(db, "chats", config.roomKey, "calls", incomingCall.id);
          await updateDoc(ref, { status: 'declined' }).catch(() => {});
      }
      setIncomingCall(null);
      if (ringtoneRef.current) ringtoneRef.current.pause();
  };

  const toggleMute = () => {
      if (localStreamRef.current) {
          localStreamRef.current.getAudioTracks().forEach(t => t.enabled = !t.enabled);
          setIsMuted(!isMuted);
      }
  };

  const toggleVideo = () => {
      if (localStreamRef.current) {
          localStreamRef.current.getVideoTracks().forEach(t => t.enabled = !t.enabled);
          setIsVideoOff(!isVideoOff);
      }
  };

  const switchCamera = async () => {
      if (localStreamRef.current) {
          const newMode = facingMode === 'user' ? 'environment' : 'user';
          // Stop video track
          localStreamRef.current.getVideoTracks().forEach(t => t.stop());
          
          try {
              const newStream = await navigator.mediaDevices.getUserMedia({
                  audio: true, // keep audio context
                  video: { facingMode: newMode }
              });
              
              // Update PC Sender
              const videoTrack = newStream.getVideoTracks()[0];
              const sender = peerConnection.current?.getSenders().find(s => s.track?.kind === 'video');
              if (sender) sender.replaceTrack(videoTrack);
              
              localStreamRef.current = newStream;
              setFacingMode(newMode);
              if (localVideoRef.current) localVideoRef.current.srcObject = newStream;
              
          } catch (e) {
              console.error(e);
          }
      }
  };

  // --- RENDERERS ---

  // 1. Incoming Call Modal
  if (incomingCall) {
      return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
              <div className="bg-white dark:bg-slate-800 rounded-2xl p-8 w-full max-w-sm text-center border border-white/10 shadow-2xl">
                  <img src={incomingCall.callerAvatar} className="w-24 h-24 rounded-full mx-auto mb-4 border-4 border-blue-500 shadow-lg bg-slate-200" />
                  <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">{incomingCall.callerName}</h3>
                  <p className="text-slate-500 dark:text-slate-400 mb-8 animate-pulse">
                      Incoming {incomingCall.type === 'video' ? 'Video' : 'Audio'} Call...
                  </p>
                  <div className="flex justify-center gap-10">
                      <button onClick={decline} className="flex flex-col items-center gap-2 group">
                          <div className="w-16 h-16 bg-red-500 rounded-full flex items-center justify-center text-white shadow-lg group-hover:bg-red-600 transition transform group-hover:scale-110">
                              <PhoneOff size={32} />
                          </div>
                          <span className="text-sm text-slate-500 font-medium">Decline</span>
                      </button>
                      <button onClick={answerCall} className="flex flex-col items-center gap-2 group">
                          <div className="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center text-white shadow-lg group-hover:bg-green-600 transition transform group-hover:scale-110 animate-bounce">
                              {incomingCall.type === 'video' ? <Video size={32} /> : <Phone size={32} />}
                          </div>
                          <span className="text-sm text-slate-500 font-medium">Answer</span>
                      </button>
                  </div>
              </div>
          </div>
      );
  }

  // 2. Active Call Interface
  if (uiCallState !== 'idle') {
      const isVideoCall = (localStreamRef.current?.getVideoTracks().length || 0) > 0;

      return (
          <div className="fixed inset-0 z-[90] bg-slate-950 flex flex-col">
              {/* Video Area */}
              <div className="flex-1 relative overflow-hidden bg-black flex items-center justify-center">
                  {/* Remote Video */}
                  <video 
                      ref={remoteVideoRef} 
                      autoPlay 
                      playsInline 
                      className={`w-full h-full object-contain ${isVideoCall ? '' : 'hidden'}`}
                  />
                  
                  {/* Placeholder / Audio View */}
                  {(!remoteStreamVal || !isVideoCall) && (
                      <div className="flex flex-col items-center animate-in fade-in zoom-in duration-500">
                           <div className="w-32 h-32 rounded-full border-4 border-white/20 shadow-2xl mb-4 bg-slate-800 flex items-center justify-center">
                               <span className="text-4xl">👤</span>
                           </div>
                           <p className="text-white/70 text-lg font-medium animate-pulse">
                               {uiCallState === 'calling' ? 'Calling...' : 'Connected'}
                           </p>
                      </div>
                  )}

                  {/* Local Video (PiP) */}
                  {isVideoCall && (
                      <div className="absolute top-4 right-4 w-28 sm:w-32 aspect-[3/4] bg-slate-900 rounded-xl overflow-hidden shadow-2xl border border-white/10 z-20">
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
              <div className="bg-slate-900/80 backdrop-blur p-6 pb-10 flex items-center justify-center gap-6 z-30">
                  <button 
                      onClick={toggleMute} 
                      className={`p-4 rounded-full transition ${isMuted ? 'bg-white text-slate-900' : 'bg-white/10 text-white hover:bg-white/20'}`}
                  >
                      {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                  </button>
                  
                  {isVideoCall && (
                    <>
                        <button 
                            onClick={toggleVideo} 
                            className={`p-4 rounded-full transition ${isVideoOff ? 'bg-white text-slate-900' : 'bg-white/10 text-white hover:bg-white/20'}`}
                        >
                            {isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}
                        </button>
                        <button 
                            onClick={switchCamera} 
                            className="p-4 rounded-full bg-white/10 text-white hover:bg-white/20 transition md:hidden"
                        >
                            <RotateCcw size={24} />
                        </button>
                    </>
                  )}

                  <button 
                      onClick={hangup} 
                      className="p-4 rounded-full bg-red-500 text-white hover:bg-red-600 transition shadow-lg shadow-red-500/50"
                  >
                      <PhoneOff size={32} fill="currentColor" />
                  </button>
              </div>
          </div>
      );
  }

  // 3. Participants List
  if (showParticipants) {
      return (
        <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm flex items-start justify-end p-4 sm:p-6" onClick={onCloseParticipants}>
            <div className="bg-white dark:bg-slate-800 w-full max-w-xs rounded-2xl shadow-2xl border border-slate-100 dark:border-slate-700 overflow-hidden animate-in slide-in-from-right-4 mt-14" onClick={e => e.stopPropagation()}>
                <div className="p-4 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center bg-slate-50/50 dark:bg-slate-900/50">
                    <h3 className="font-bold text-slate-800 dark:text-slate-100">Active Participants ({users.length})</h3>
                    <button onClick={onCloseParticipants} className="p-1 rounded-full hover:bg-slate-200 dark:hover:bg-slate-700 transition"><X size={20} className="text-slate-500 dark:text-slate-400" /></button>
                </div>
                <div className="max-h-[60vh] overflow-y-auto p-2">
                    {users.filter(u => u.uid !== user.uid).map((u) => (
                        <div key={u.uid} className="flex items-center justify-between p-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-xl transition group">
                            <div className="flex items-center gap-3 overflow-hidden">
                                <img src={u.avatar} className="w-10 h-10 rounded-full bg-slate-200 dark:bg-slate-600" />
                                <span className="font-medium text-slate-700 dark:text-slate-200 truncate">{u.username}</span>
                            </div>
                            <div className="flex gap-1">
                                <button 
                                    onClick={() => initiateCall(u.uid, u.username, u.avatar, 'audio')}
                                    className="p-2 text-slate-400 hover:text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg transition"
                                    title="Voice Call"
                                >
                                    <Phone size={18} />
                                </button>
                                <button 
                                    onClick={() => initiateCall(u.uid, u.username, u.avatar, 'video')}
                                    className="p-2 text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition"
                                    title="Video Call"
                                >
                                    <Video size={18} />
                                </button>
                            </div>
                        </div>
                    ))}
                    {users.length <= 1 && <p className="p-6 text-center text-slate-400 text-sm italic">You are alone here.</p>}
                </div>
            </div>
        </div>
      );
  }

  return null;
};

export default CallManager;
