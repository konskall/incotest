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
  const [incomingCall, setIncomingCall] = useState<any>(null);
  const [activeCall, setActiveCall] = useState<any>(null);
  const [callStatus, setCallStatus] = useState<'idle' | 'calling' | 'connected'>('idle');
  
  // Media Control States
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  
  // Video Refs - We manipulate DOM directly for performance and stability in WebRTC
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  
  // WebRTC Refs (Persistent across renders)
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const ringtoneRef = useRef<HTMLAudioElement | null>(null);
  
  // Unsubscribe functions container
  const unsubscribes = useRef<(() => void)[]>([]);

  // --- Helper: Clean up everything ---
  const cleanup = useCallback(() => {
      // Stop tracks
      if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach(t => t.stop());
      }
      // Close PC
      if (peerConnection.current) {
          peerConnection.current.close();
          peerConnection.current = null;
      }
      // Unsubscribe listeners
      unsubscribes.current.forEach(unsub => unsub());
      unsubscribes.current = [];
      
      // Reset Refs
      localStreamRef.current = null;
      remoteStreamRef.current = null;
      
      // Reset State
      setActiveCall(null);
      setCallStatus('idle');
      setIncomingCall(null);
      setIsMuted(false);
      setIsVideoOff(false);
      
      if (ringtoneRef.current) {
          ringtoneRef.current.pause();
          ringtoneRef.current = null;
      }
  }, []);

  // --- Helper: Initialize Peer Connection ---
  const createPC = useCallback((callId: string, isCaller: boolean) => {
      const pc = new RTCPeerConnection(ICE_SERVERS);
      peerConnection.current = pc;

      // 1. ICE Candidates logic
      pc.onicecandidate = (event) => {
          if (event.candidate) {
              const collectionName = isCaller ? 'offerCandidates' : 'answerCandidates';
              addDoc(collection(db, "chats", config.roomKey, "calls", callId, collectionName), event.candidate.toJSON());
          }
      };

      // 2. Remote Stream Handling
      pc.ontrack = (event) => {
          console.log("Track received:", event.streams[0]);
          const stream = event.streams[0];
          remoteStreamRef.current = stream;
          
          // Direct DOM manipulation to ensure it plays
          if (remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = stream;
              remoteVideoRef.current.play().catch(e => console.error("Remote play error", e));
          }
      };

      // 3. Add Local Tracks
      if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach(track => {
              pc.addTrack(track, localStreamRef.current!);
          });
      }

      return pc;
  }, [config.roomKey]);

  // --- Listener: Incoming Calls ---
  useEffect(() => {
    const q = query(
        collection(db, "chats", config.roomKey, "calls"),
        where("calleeId", "==", user.uid),
        where("status", "==", "offering") // Only listen for offering status
    );

    const unsub = onSnapshot(q, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === "added") {
                const data = change.doc.data();
                // Only accept if we are idle
                if (callStatus === 'idle' && !activeCall) {
                   setIncomingCall({ id: change.doc.id, ...data });
                   
                   // Ringtone
                   initAudio();
                   const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
                   audio.loop = true;
                   audio.play().catch(() => {});
                   ringtoneRef.current = audio;
                }
            }
            if (change.type === "removed") {
                if (incomingCall && incomingCall.id === change.doc.id) {
                   if (ringtoneRef.current) {
                       ringtoneRef.current.pause();
                       ringtoneRef.current = null;
                   }
                   setIncomingCall(null);
                }
            }
        });
    });

    return () => {
        unsub();
        cleanup();
    };
  }, [config.roomKey, user.uid, callStatus]); // Removed 'incomingCall' and 'activeCall' to prevent re-bind loops

  // --- Function: Start Call ---
  const initiateCall = async (targetUid: string, targetName: string, targetAvatar: string, type: 'audio' | 'video') => {
      onCloseParticipants();
      setCallStatus('calling');

      // 1. Get Media
      try {
          const stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: type === 'video' ? { facingMode: 'user' } : false
          });
          localStreamRef.current = stream;
      } catch (e) {
          console.error("Media Error", e);
          alert("Could not access media devices.");
          setCallStatus('idle');
          return;
      }

      // 2. Create Doc
      const callDocRef = await addDoc(collection(db, "chats", config.roomKey, "calls"), {
          callerId: user.uid,
          callerName: config.username,
          callerAvatar: config.avatarURL,
          calleeId: targetUid,
          type,
          status: 'offering',
          createdAt: serverTimestamp()
      });
      
      setActiveCall({ 
          id: callDocRef.id, 
          isCaller: true, 
          otherName: targetName, 
          otherAvatar: targetAvatar, 
          type 
      });

      // 3. Create PC & Offer
      const pc = createPC(callDocRef.id, true);
      const offerDescription = await pc.createOffer();
      await pc.setLocalDescription(offerDescription);

      const offer = { type: offerDescription.type, sdp: offerDescription.sdp };
      await updateDoc(callDocRef, { offer });

      // 4. Listen for Answer
      const unsub = onSnapshot(callDocRef, (snapshot) => {
          const data = snapshot.data();
          if (!data) return; // Call deleted

          if (!pc.currentRemoteDescription && data?.answer) {
              const answerDescription = new RTCSessionDescription(data.answer);
              pc.setRemoteDescription(answerDescription);
              setCallStatus('connected');
          }
          
          // Handle End/Decline
          if (data.status === 'ended' || data.status === 'declined') {
              cleanup();
          }
      });
      unsubscribes.current.push(unsub);

      // 5. Listen for Remote Candidates (Callee sent them)
      const candidateQ = collection(db, "chats", config.roomKey, "calls", callDocRef.id, "answerCandidates");
      const unsubCand = onSnapshot(candidateQ, (snapshot) => {
          snapshot.docChanges().forEach((change) => {
              if (change.type === "added") {
                  const data = change.doc.data();
                  const candidate = new RTCIceCandidate(data);
                  pc.addIceCandidate(candidate).catch(console.error);
              }
          });
      });
      unsubscribes.current.push(unsubCand);
  };

  // --- Function: Answer Call ---
  const answerCall = async () => {
      if (!incomingCall) return;
      const callId = incomingCall.id;
      const callType = incomingCall.type;
      
      // Stop ringing
      if (ringtoneRef.current) {
          ringtoneRef.current.pause();
          ringtoneRef.current = null;
      }

      setActiveCall({ 
          id: callId, 
          isCaller: false, 
          otherName: incomingCall.callerName, 
          otherAvatar: incomingCall.callerAvatar, 
          type: callType 
      });
      setIncomingCall(null);
      setCallStatus('connected');

      // 1. Get Media
      try {
          const stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: callType === 'video' ? { facingMode: 'user' } : false
          });
          localStreamRef.current = stream;
      } catch (e) {
          console.error("Media Error", e);
          cleanup();
          return;
      }

      // 2. Create PC
      const pc = createPC(callId, false);

      // 3. Set Remote Description (Offer)
      const offerDescription = new RTCSessionDescription(incomingCall.offer);
      await pc.setRemoteDescription(offerDescription);

      // 4. Create Answer
      const answerDescription = await pc.createAnswer();
      await pc.setLocalDescription(answerDescription);

      const answer = { type: answerDescription.type, sdp: answerDescription.sdp };
      await updateDoc(doc(db, "chats", config.roomKey, "calls", callId), { answer, status: 'answered' });

      // 5. Listen for Remote Candidates (Caller sent them)
      const candidateQ = collection(db, "chats", config.roomKey, "calls", callId, "offerCandidates");
      const unsubCand = onSnapshot(candidateQ, (snapshot) => {
          snapshot.docChanges().forEach((change) => {
              if (change.type === "added") {
                  const data = change.doc.data();
                  const candidate = new RTCIceCandidate(data);
                  pc.addIceCandidate(candidate).catch(console.error);
              }
          });
      });
      unsubscribes.current.push(unsubCand);

      // 6. Watch for End Signal
      const unsubDoc = onSnapshot(doc(db, "chats", config.roomKey, "calls", callId), (snap) => {
           if (snap.data()?.status === 'ended') {
               cleanup();
           }
      });
      unsubscribes.current.push(unsubDoc);
  };

  const hangupCall = async () => {
      if (activeCall) {
         const callRef = doc(db, "chats", config.roomKey, "calls", activeCall.id);
         // Mark ended in DB to notify other peer
         await updateDoc(callRef, { status: 'ended' }).catch(() => {});
      }
      cleanup();
  };

  const rejectCall = async () => {
      if (incomingCall) {
          await updateDoc(doc(db, "chats", config.roomKey, "calls", incomingCall.id), { status: 'declined' });
          setIncomingCall(null);
      }
      if (ringtoneRef.current) {
          ringtoneRef.current.pause();
          ringtoneRef.current = null;
      }
  };

  // --- Effects: Local Media Attachment & Toggles ---
  
  // Effect to attach Local Video to DOM
  useEffect(() => {
      if (localVideoRef.current && localStreamRef.current) {
          localVideoRef.current.srcObject = localStreamRef.current;
          localVideoRef.current.muted = true; // Mute local video to prevent echo
      }
  }, [activeCall, callStatus]); // Re-run when call state becomes active

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
      if (!localStreamRef.current) return;
      const newMode = facingMode === 'user' ? 'environment' : 'user';
      
      try {
          // Stop old video tracks
          localStreamRef.current.getVideoTracks().forEach(t => t.stop());
          
          // Get new stream
          const newStream = await navigator.mediaDevices.getUserMedia({
              audio: true, // Request audio again to keep stream unified if needed, or simpler:
              video: { facingMode: newMode }
          });
          
          // Replace track in PC
          const newVideoTrack = newStream.getVideoTracks()[0];
          const sender = peerConnection.current?.getSenders().find(s => s.track?.kind === 'video');
          if (sender) {
              sender.replaceTrack(newVideoTrack);
          }

          // Update refs
          const oldAudioTrack = localStreamRef.current.getAudioTracks()[0];
          if (oldAudioTrack) {
              // Combine old audio (if kept) with new video
               // Note: getUserMedia returns fresh audio usually, simpler to just use newStream completely 
               // but maintaining audio context is tricky. 
               // For simplicity: Replace entire stream ref
          }
          
          localStreamRef.current = newStream;
          setFacingMode(newMode);
          
          if (localVideoRef.current) {
              localVideoRef.current.srcObject = newStream;
          }
      } catch(e) {
          console.error("Switch camera failed", e);
      }
  };

  // --- RENDER ---

  if (incomingCall) {
      return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
              <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 w-full max-w-sm shadow-2xl text-center border border-white/10">
                  <img src={incomingCall.callerAvatar} alt="Caller" className="w-24 h-24 rounded-full mx-auto mb-4 border-4 border-blue-500 bg-slate-200" />
                  <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-1">{incomingCall.callerName}</h3>
                  <p className="text-slate-500 dark:text-slate-400 mb-8 animate-pulse">
                      Incoming {incomingCall.type === 'video' ? 'Video' : 'Voice'} Call...
                  </p>
                  <div className="flex justify-center gap-8">
                      <button onClick={rejectCall} className="flex flex-col items-center gap-2 group">
                          <div className="w-16 h-16 bg-red-500 rounded-full flex items-center justify-center text-white shadow-lg group-hover:bg-red-600 transition transform group-hover:scale-110">
                              <PhoneOff size={32} />
                          </div>
                          <span className="text-sm text-slate-500 dark:text-slate-400">Decline</span>
                      </button>
                      <button onClick={answerCall} className="flex flex-col items-center gap-2 group">
                          <div className="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center text-white shadow-lg group-hover:bg-green-600 transition transform group-hover:scale-110 animate-bounce">
                              {incomingCall.type === 'video' ? <Video size={32} /> : <Phone size={32} />}
                          </div>
                          <span className="text-sm text-slate-500 dark:text-slate-400">Answer</span>
                      </button>
                  </div>
              </div>
          </div>
      );
  }

  if (activeCall) {
      return (
          <div className="fixed inset-0 z-[60] bg-slate-950 flex flex-col">
              {/* Main Video Area */}
              <div className="flex-1 relative flex items-center justify-center overflow-hidden bg-black">
                  {/* Remote Video */}
                  <video 
                      ref={remoteVideoRef} 
                      autoPlay 
                      playsInline 
                      className={`w-full h-full object-contain ${activeCall.type === 'audio' ? 'hidden' : ''}`} 
                  />
                  
                  {/* Placeholder for Audio Call or Connecting State */}
                  {(activeCall.type === 'audio') && (
                      <div className="flex flex-col items-center z-10 animate-in fade-in zoom-in">
                           <img src={activeCall.otherAvatar} className="w-32 h-32 rounded-full border-4 border-white/20 shadow-2xl mb-6 bg-slate-800" />
                           <h3 className="text-3xl text-white font-bold mb-2">{activeCall.otherName}</h3>
                           <p className="text-white/60 text-lg">
                               {callStatus === 'calling' ? 'Calling...' : 'Connected'}
                           </p>
                      </div>
                  )}

                  {/* Local Video (PiP) */}
                  {activeCall.type === 'video' && (
                      <div className="absolute top-4 right-4 w-28 sm:w-36 aspect-[3/4] bg-slate-800 rounded-xl overflow-hidden shadow-2xl border border-white/10 z-20">
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

              {/* Controls */}
              <div className="bg-slate-900/80 backdrop-blur p-6 pb-10 flex items-center justify-center gap-6 z-30">
                  <button 
                      onClick={toggleMute} 
                      className={`p-4 rounded-full ${isMuted ? 'bg-white text-slate-900' : 'bg-white/10 text-white hover:bg-white/20'} transition`}
                  >
                      {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                  </button>
                  
                  {activeCall.type === 'video' && (
                    <>
                        <button 
                            onClick={toggleVideo} 
                            className={`p-4 rounded-full ${isVideoOff ? 'bg-white text-slate-900' : 'bg-white/10 text-white hover:bg-white/20'} transition`}
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
                      onClick={hangupCall} 
                      className="p-4 rounded-full bg-red-500 text-white hover:bg-red-600 transition shadow-lg shadow-red-500/50"
                  >
                      <PhoneOff size={32} fill="currentColor" />
                  </button>
              </div>
          </div>
      );
  }

  if (showParticipants) {
      return (
        <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm flex items-start justify-end p-4 sm:p-6" onClick={onCloseParticipants}>
            <div className="bg-white dark:bg-slate-800 w-full max-w-xs rounded-2xl shadow-2xl border border-slate-100 dark:border-slate-700 overflow-hidden animate-in slide-in-from-right-4 mt-14" onClick={e => e.stopPropagation()}>
                <div className="p-4 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center bg-slate-50/50 dark:bg-slate-900/50">
                    <h3 className="font-bold text-slate-800 dark:text-slate-100">Active Participants ({users.length})</h3>
                    <button onClick={onCloseParticipants}><div className="p-1 rounded-full hover:bg-slate-200 dark:hover:bg-slate-700 transition"><X size={20} className="text-slate-500 dark:text-slate-400" /></div></button>
                </div>
                <div className="max-h-[60vh] overflow-y-auto p-2">
                    {users.length === 0 && <p className="p-4 text-center text-slate-400 text-sm">No one else is here.</p>}
                    {users.filter(u => u.uid !== user.uid).map((u) => (
                        <div key={u.uid} className="flex items-center justify-between p-2 hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-xl transition group">
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
                </div>
            </div>
        </div>
      );
  }

  return null;
};

export default CallManager;
