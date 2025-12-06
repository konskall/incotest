import React, { useState, useEffect, useRef, useCallback } from 'react';
import { User, ChatConfig, Presence, CallData } from '../types';
import { doc, onSnapshot, setDoc, updateDoc, deleteDoc, collection, addDoc, query, where, getDocs, serverTimestamp, writeBatch, getDoc, limit, onSnapshotsInSync } from 'firebase/firestore';
import { db } from '../services/firebase';
import { Phone, Video, Mic, MicOff, VideoOff, PhoneOff, X, WifiOff, Signal, Minimize2, Maximize2, User as UserIcon, Loader2, Video as VideoIcon } from 'lucide-react';
import { startRingtone, stopRingtone, playBeep, initAudio } from '../utils/helpers';

interface CallManagerProps {
  user: User;
  config: ChatConfig;
  users: Presence[];
  showParticipants: boolean;
  onCloseParticipants: () => void;
}

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const CallManager: React.FC<CallManagerProps> = ({ user, config, users, showParticipants, onCloseParticipants }) => {
  const [incomingCall, setIncomingCall] = useState<CallData | null>(null);
  const [activeCall, setActiveCall] = useState<CallData | null>(null);
  const [viewState, setViewState] = useState<{ status: 'idle' | 'calling' | 'ringing' | 'connected' }>({ status: 'idle' });
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  
  // Network stats
  const [networkQuality, setNetworkQuality] = useState<'good' | 'bad' | 'unknown'>('unknown');
  const [networkStats, setNetworkStats] = useState<{ rtt: number; loss: number }>({ rtt: 0, loss: 0 });

  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const unsubscribeCallRef = useRef<(() => void) | null>(null);

  // Helper to get fresh references in closures
  const activeCallRef = useRef<CallData | null>(null);
  useEffect(() => { activeCallRef.current = activeCall; }, [activeCall]);

  // --- 1. Cleanup on Unmount ---
  useEffect(() => {
    return () => {
      cleanupCall();
    };
  }, []);

  const cleanupCall = useCallback(async () => {
    stopRingtone();
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setLocalStream(null);
    setRemoteStream(null);
    setIncomingCall(null);
    setActiveCall(null);
    setViewState({ status: 'idle' });
    setIsMuted(false);
    setIsVideoOff(false);
    setNetworkQuality('unknown');
    
    if (unsubscribeCallRef.current) {
      unsubscribeCallRef.current();
      unsubscribeCallRef.current = null;
    }
  }, [localStream]);

  // --- 2. Listen for Incoming Calls ---
  useEffect(() => {
    if (!user || !config.roomKey) return;

    const q = query(
      collection(db, "chats", config.roomKey, "calls"),
      where("calleeId", "==", user.uid),
      where("status", "==", "offering"),
      limit(1)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
          const data = change.doc.data() as CallData;
          // Ensure call is recent (within 1 minute) to avoid stale calls
          const createdAt = data.createdAt?.toMillis?.() || Date.now();
          if (Date.now() - createdAt < 60000) {
             setIncomingCall({ ...data, id: change.doc.id });
             startRingtone();
          }
        }
        if (change.type === "removed") {
           setIncomingCall(null);
           stopRingtone();
        }
      });
    });

    return () => unsubscribe();
  }, [user, config.roomKey]);

  // --- 3. Call Logic (Make/Answer) ---
  
  const setupPeerConnection = async (isCaller: boolean, callId: string) => {
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnection.current = pc;

    // ICE Candidates
    pc.onicecandidate = (event) => {
       if (event.candidate) {
          const coll = isCaller ? 'offerCandidates' : 'answerCandidates';
          addDoc(collection(db, "chats", config.roomKey, "calls", callId, coll), {
             ...event.candidate.toJSON(),
             createdAt: serverTimestamp()
          });
       }
    };

    // Track handling
    pc.ontrack = (event) => {
       event.streams[0].getTracks().forEach((track) => {
         // remoteStream setup
       });
       setRemoteStream(event.streams[0]);
    };

    // Connection State
    pc.onconnectionstatechange = () => {
       if (pc.connectionState === 'connected') {
           setViewState({ status: 'connected' });
           stopRingtone();
       } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
           handleHangup();
       }
    };

    return pc;
  };

  const getLocalStream = async (type: 'audio' | 'video') => {
    try {
        const constraints = {
            audio: true,
            video: type === 'video' ? { facingMode: 'user' } : false
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        setLocalStream(stream);
        return stream;
    } catch (e) {
        console.error("Error accessing media devices", e);
        alert("Could not access microphone/camera. Please check permissions.");
        return null;
    }
  };

  const makeCall = async (callee: Presence, type: 'audio' | 'video') => {
      onCloseParticipants();
      initAudio(); // Ensure audio context is ready
      
      // 1. Get Local Stream
      const stream = await getLocalStream(type);
      if (!stream) return;

      // 2. Create Call Doc
      const callDocRef = await addDoc(collection(db, "chats", config.roomKey, "calls"), {
          callerId: user.uid,
          callerName: config.username,
          callerAvatar: config.avatarURL,
          calleeId: callee.uid,
          type,
          status: 'offering',
          createdAt: serverTimestamp()
      });
      const callId = callDocRef.id;

      setActiveCall({
          id: callId,
          callerId: user.uid,
          callerName: config.username,
          callerAvatar: config.avatarURL,
          calleeId: callee.uid,
          type,
          status: 'offering',
          createdAt: null
      });
      setViewState({ status: 'calling' });

      // 3. Setup PC
      const pc = await setupPeerConnection(true, callId);
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      // 4. Create Offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const offerObj = {
          type: offer.type,
          sdp: offer.sdp
      };

      await updateDoc(callDocRef, { offer: offerObj });

      // 5. Listen for Answer
      unsubscribeCallRef.current = onSnapshot(doc(db, "chats", config.roomKey, "calls", callId), async (snapshot) => {
          const data = snapshot.data();
          if (!data) {
             // Call deleted/ended
             handleHangup();
             return;
          }
          
          if (data.answer && !pc.currentRemoteDescription) {
             const answer = new RTCSessionDescription(data.answer);
             await pc.setRemoteDescription(answer);
          }
      });

      // 6. Listen for Answer Candidates
      const qCandidates = collection(db, "chats", config.roomKey, "calls", callId, "answerCandidates");
      onSnapshot(qCandidates, (snapshot) => {
          snapshot.docChanges().forEach((change) => {
              if (change.type === 'added') {
                  const candidate = new RTCIceCandidate(change.doc.data());
                  pc.addIceCandidate(candidate);
              }
          });
      });
  };

  const handleAnswerCall = async () => {
      if (!incomingCall) return;
      stopRingtone();
      initAudio();

      const callId = incomingCall.id;
      const type = incomingCall.type;

      setActiveCall(incomingCall);
      setIncomingCall(null);
      setViewState({ status: 'connected' }); // Assume connected while setting up

      // 1. Get Local Stream
      const stream = await getLocalStream(type);
      if (!stream) {
          handleDecline();
          return;
      }

      // 2. Setup PC
      const pc = await setupPeerConnection(false, callId);
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      // 3. Set Remote Desc (Offer)
      const callDocRef = doc(db, "chats", config.roomKey, "calls", callId);
      const callSnapshot = await getDoc(callDocRef);
      const callData = callSnapshot.data();

      if (!callData || !callData.offer) {
          handleHangup();
          return;
      }

      await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));

      // 4. Create Answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      const answerObj = {
          type: answer.type,
          sdp: answer.sdp
      };

      await updateDoc(callDocRef, {
          answer: answerObj,
          status: 'answered'
      });

      // 5. Listen for Offer Candidates
      const qCandidates = collection(db, "chats", config.roomKey, "calls", callId, "offerCandidates");
      onSnapshot(qCandidates, (snapshot) => {
          snapshot.docChanges().forEach((change) => {
              if (change.type === 'added') {
                  const candidate = new RTCIceCandidate(change.doc.data());
                  pc.addIceCandidate(candidate);
              }
          });
      });
      
      // 6. Listen for Call End
      unsubscribeCallRef.current = onSnapshot(callDocRef, (snapshot) => {
          if (!snapshot.exists()) {
              handleHangup();
          }
      });
  };

  const handleDecline = async () => {
      if (!incomingCall) return;
      stopRingtone();
      
      try {
          await deleteDoc(doc(db, "chats", config.roomKey, "calls", incomingCall.id));
      } catch (e) {
          console.error("Error declining", e);
      }
      setIncomingCall(null);
  };

  const handleHangup = async () => {
      const callId = activeCall?.id;
      cleanupCall(); // Local cleanup first

      if (callId && config.roomKey) {
          try {
              // Delete call document to signal end to other peer
              await deleteDoc(doc(db, "chats", config.roomKey, "calls", callId));
          } catch (e) {
              // Document might already be gone
          }
      }
  };

  const toggleMute = () => {
      if (localStream) {
          localStream.getAudioTracks().forEach(track => track.enabled = !track.enabled);
          setIsMuted(!isMuted);
      }
  };

  const toggleVideo = () => {
      if (localStream) {
          localStream.getVideoTracks().forEach(track => track.enabled = !track.enabled);
          setIsVideoOff(!isVideoOff);
      }
  };

  // --- 4. Effects for Stream Attachment & Stats ---
  
  useEffect(() => {
    if (localVideoRef.current && localStream) {
        localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
        remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  // Network Stats Monitoring
  useEffect(() => {
    if (viewState.status !== 'connected' || !peerConnection.current) return;

    const interval = setInterval(async () => {
        if (!peerConnection.current) return;
        
        try {
            const stats = await peerConnection.current.getStats();
            let currentRtt = 0;
            let currentLoss = 0;
            let totalPackets = 0;
            let lostPackets = 0;

            stats.forEach(report => {
                if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                    currentRtt = report.currentRoundTripTime * 1000;
                }
                if (report.type === 'inbound-rtp') {
                    lostPackets += report.packetsLost || 0;
                    totalPackets += report.packetsReceived || 0;
                }
            });

            if (totalPackets > 0) {
                 // Simple loss calculation over session, ideally should be windowed
                 currentLoss = (lostPackets / (totalPackets + lostPackets)) * 100;
            }

            setNetworkStats({ rtt: currentRtt, loss: currentLoss });

            if (currentLoss > 5 || currentRtt > 400) {
                setNetworkQuality('bad');
            } else if (currentLoss > 2 || currentRtt > 200) {
                setNetworkQuality('good'); // 'fair' usually, but using good/bad for binary UI
            } else {
                setNetworkQuality('good');
            }

        } catch (e) {
            console.warn("Stats error", e);
        }
    }, 2000);

    return () => clearInterval(interval);
  }, [viewState.status]);


  // --- 5. Renders ---

  // 5.1 Incoming Call Modal
  if (incomingCall) {
      return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in zoom-in-95 duration-300">
             <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 w-full max-w-sm shadow-2xl border border-white/20 flex flex-col items-center gap-6">
                 <div className="relative">
                    <img 
                        src={incomingCall.callerAvatar} 
                        alt={incomingCall.callerName}
                        className="w-24 h-24 rounded-full border-4 border-blue-500 shadow-xl object-cover" 
                    />
                    <div className="absolute -bottom-2 -right-2 bg-blue-500 text-white p-2 rounded-full animate-bounce">
                        {incomingCall.type === 'video' ? <Video size={20} /> : <Phone size={20} />}
                    </div>
                 </div>
                 
                 <div className="text-center">
                     <h3 className="text-2xl font-bold text-slate-800 dark:text-slate-100">{incomingCall.callerName}</h3>
                     <p className="text-slate-500 dark:text-slate-400 animate-pulse">Incoming {incomingCall.type} call...</p>
                 </div>

                 <div className="flex gap-6 w-full justify-center">
                     <button 
                        onClick={handleDecline}
                        className="flex flex-col items-center gap-2 group"
                     >
                         <div className="w-14 h-14 bg-red-500 rounded-full flex items-center justify-center text-white shadow-lg shadow-red-500/30 group-hover:scale-110 transition-transform">
                             <PhoneOff size={24} />
                         </div>
                         <span className="text-xs font-medium text-slate-500">Decline</span>
                     </button>
                     
                     <button 
                        onClick={handleAnswerCall}
                        className="flex flex-col items-center gap-2 group"
                     >
                         <div className="w-14 h-14 bg-green-500 rounded-full flex items-center justify-center text-white shadow-lg shadow-green-500/30 group-hover:scale-110 transition-transform animate-pulse">
                             <Phone size={24} />
                         </div>
                         <span className="text-xs font-medium text-slate-500">Answer</span>
                     </button>
                 </div>
             </div>
          </div>
      );
  }

  // 5.2 Active Call View
  if (activeCall) {
      const showRemoteVideo = activeCall.type === 'video' && viewState.status === 'connected';
      
      return (
          <div className="fixed inset-0 z-[55] bg-slate-900 flex flex-col animate-in fade-in duration-300">
              {/* Main Video Area */}
              <div className="relative flex-1 bg-black flex items-center justify-center overflow-hidden">
                  
                  {/* Remote Video - Always rendered, used for audio too */}
                  <video 
                      ref={remoteVideoRef} 
                      autoPlay 
                      playsInline 
                      className={`w-full h-full object-contain ${showRemoteVideo ? '' : 'hidden'}`} 
                  />

                  {/* Placeholder when no video */}
                  {!showRemoteVideo && (
                      <div className="flex flex-col items-center gap-4 animate-pulse">
                          <img 
                            src={activeCall.callerId === user.uid ? activeCall.calleeId /* This is simplified, ideally we store calleeAvatar too */ : activeCall.callerAvatar} 
                            // Fallback logic for avatar url since activeCall struct is simple
                            alt="Remote User"
                            className="w-32 h-32 rounded-full border-4 border-slate-700 bg-slate-800 object-cover"
                            onError={(e) => { e.currentTarget.src = `https://ui-avatars.com/api/?name=User&background=random`; }}
                          />
                          <div className="text-center">
                              <h3 className="text-xl font-bold text-white tracking-wide">
                                {viewState.status === 'calling' ? 'Calling...' : (activeCall.callerId === user.uid ? 'In Call' : activeCall.callerName)}
                              </h3>
                              <p className="text-slate-400 text-sm">{viewState.status === 'calling' ? 'Waiting for answer...' : '00:00'}</p>
                          </div>
                      </div>
                  )}

                  {/* Network Quality Indicator */}
                  {viewState.status === 'connected' && networkQuality !== 'good' && (
                      <div className="absolute top-20 left-4 z-50 flex items-center gap-2 bg-black/60 backdrop-blur-sm px-3 py-1.5 rounded-lg border border-white/10 animate-pulse">
                          {networkQuality === 'bad' ? (
                              <WifiOff size={16} className="text-red-500" />
                          ) : (
                              <Signal size={16} className="text-yellow-500" />
                          )}
                          <div className="flex flex-col">
                              <span className={`text-xs font-bold ${networkQuality === 'bad' ? 'text-red-400' : 'text-yellow-400'}`}>
                                  Poor Connection
                              </span>
                              <span className="text-[10px] text-white/70">
                                  {networkStats.loss > 0 ? `Loss: ${networkStats.loss.toFixed(0)}%` : `Ping: ${networkStats.rtt.toFixed(0)}ms`}
                              </span>
                          </div>
                      </div>
                  )}

                  {/* Local Video Picture-in-Picture */}
                  {activeCall.type === 'video' && !isVideoOff && (
                      <div className="absolute bottom-24 right-4 w-32 sm:w-40 aspect-[3/4] bg-slate-800 rounded-xl overflow-hidden shadow-2xl border border-white/20 z-10">
                          <video 
                              ref={localVideoRef}
                              autoPlay
                              playsInline
                              muted
                              className="w-full h-full object-cover mirror"
                          />
                      </div>
                  )}
              </div>

              {/* Call Controls */}
              <div className="bg-slate-900/90 backdrop-blur p-6 pb-8 flex items-center justify-center gap-6 safe-area-bottom">
                  <button 
                    onClick={toggleMute}
                    className={`p-4 rounded-full transition-all ${isMuted ? 'bg-white text-slate-900' : 'bg-slate-800 text-white hover:bg-slate-700'}`}
                  >
                      {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                  </button>
                  
                  <button 
                    onClick={handleHangup}
                    className="p-5 bg-red-500 text-white rounded-full shadow-lg shadow-red-500/40 hover:scale-105 transition-transform"
                  >
                      <PhoneOff size={32} />
                  </button>

                  {activeCall.type === 'video' && (
                      <button 
                        onClick={toggleVideo}
                        className={`p-4 rounded-full transition-all ${isVideoOff ? 'bg-white text-slate-900' : 'bg-slate-800 text-white hover:bg-slate-700'}`}
                      >
                          {isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}
                      </button>
                  )}
              </div>
          </div>
      );
  }

  // 5.3 Participants Modal (Default View when no call)
  if (showParticipants) {
      return (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center pointer-events-none">
              <div 
                  className="bg-white dark:bg-slate-900 w-full sm:w-[400px] sm:rounded-2xl shadow-2xl pointer-events-auto flex flex-col max-h-[85vh] animate-in slide-in-from-bottom-10 duration-300 border border-slate-200 dark:border-slate-800"
              >
                  {/* Header */}
                  <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                      <h3 className="font-bold text-lg text-slate-800 dark:text-slate-100">Participants ({users.length})</h3>
                      <button onClick={onCloseParticipants} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full text-slate-500">
                          <X size={20} />
                      </button>
                  </div>

                  {/* List */}
                  <div className="flex-1 overflow-y-auto p-2">
                      {users.length === 0 && (
                          <div className="p-8 text-center text-slate-400">No one else is here.</div>
                      )}
                      
                      {users.map((u) => {
                          const isMe = u.uid === user.uid;
                          return (
                              <div key={u.uid} className="flex items-center justify-between p-3 hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded-xl group transition-colors">
                                  <div className="flex items-center gap-3">
                                      <div className="relative">
                                        <img 
                                            src={u.avatar} 
                                            alt={u.username}
                                            className="w-10 h-10 rounded-full bg-slate-200 object-cover" 
                                        />
                                        <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-white dark:border-slate-900 ${u.status === 'active' ? 'bg-green-500' : 'bg-slate-400'}`}></div>
                                      </div>
                                      <div className="flex flex-col">
                                          <span className="font-semibold text-sm text-slate-800 dark:text-slate-200 flex items-center gap-1">
                                              {u.username}
                                              {isMe && <span className="text-[10px] bg-blue-100 text-blue-600 px-1.5 rounded dark:bg-blue-900 dark:text-blue-300">You</span>}
                                          </span>
                                          <span className="text-xs text-slate-400">
                                              {u.status === 'active' ? 'Online' : 'Away'}
                                          </span>
                                      </div>
                                  </div>

                                  {!isMe && (
                                      <div className="flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                                          <button 
                                            onClick={() => makeCall(u, 'audio')}
                                            className="p-2.5 bg-blue-50 text-blue-600 dark:bg-slate-700 dark:text-blue-400 rounded-full hover:bg-blue-100 dark:hover:bg-slate-600 transition"
                                            title="Audio Call"
                                          >
                                              <Phone size={18} />
                                          </button>
                                          <button 
                                            onClick={() => makeCall(u, 'video')}
                                            className="p-2.5 bg-blue-50 text-blue-600 dark:bg-slate-700 dark:text-blue-400 rounded-full hover:bg-blue-100 dark:hover:bg-slate-600 transition"
                                            title="Video Call"
                                          >
                                              <VideoIcon size={18} />
                                          </button>
                                      </div>
                                  )}
                              </div>
                          );
                      })}
                  </div>
              </div>
          </div>
      );
  }

  return null;
};

export default CallManager;
