import React, { useEffect, useRef, useState } from 'react';
import { Phone, Video, Mic, MicOff, VideoOff, PhoneOff, RotateCcw, X } from 'lucide-react';
import { db } from '../services/firebase';
import { collection, doc, onSnapshot, addDoc, updateDoc, serverTimestamp, query, where } from 'firebase/firestore';
import { User, ChatConfig } from '../types';
import { initAudio } from '../utils/helpers';

// Standard public STUN servers
const ICE_SERVERS = {
  iceServers: [
    { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  ],
};

interface CallManagerProps {
  user: User;
  config: ChatConfig;
  users: any[]; // List of active users from presence
  onCloseParticipants: () => void;
  showParticipants: boolean;
}

const CallManager: React.FC<CallManagerProps> = ({ user, config, users, onCloseParticipants, showParticipants }) => {
  const [incomingCall, setIncomingCall] = useState<any>(null);
  const [activeCall, setActiveCall] = useState<any>(null);
  const [callStatus, setCallStatus] = useState<'idle' | 'calling' | 'connected'>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const remoteStream = useRef<MediaStream | null>(null);
  const ringtoneRef = useRef<HTMLAudioElement | null>(null);
  
  // Queue for ICE candidates that arrive before remote description is set
  const candidateQueue = useRef<RTCIceCandidate[]>([]);

  // --- Signaling & Listeners ---

  useEffect(() => {
    // Listen for incoming calls
    const q = query(
        collection(db, "chats", config.roomKey, "calls"),
        where("calleeId", "==", user.uid),
        where("status", "==", "offering")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === "added") {
                const data = change.doc.data();
                // Auto-decline if already in a call
                if (callStatus !== 'idle') {
                   // Optional: Mark as busy
                } else {
                   setIncomingCall({ id: change.doc.id, ...data });
                   playRingtone();
                }
            }
            if (change.type === "removed") {
               if (incomingCall && incomingCall.id === change.doc.id) {
                   stopRingtone();
                   setIncomingCall(null);
               }
            }
        });
    });

    return () => {
        unsubscribe();
        stopRingtone();
        // Only cleanup if we are unmounting completely
    };
  }, [config.roomKey, user.uid, callStatus, incomingCall]);

  // Listen to active call status changes (answer/end) & Remote Candidates
  useEffect(() => {
      if (!activeCall) return;

      const callDocRef = doc(db, "chats", config.roomKey, "calls", activeCall.id);
      const unsub = onSnapshot(callDocRef, async (snapshot) => {
          const data = snapshot.data();
          if (!data) {
              // Call deleted
              endCall(false);
              return;
          }
          
          // If we are the caller and the callee answered
          if (activeCall.isCaller && data.status === 'answered' && data.answer && !peerConnection.current?.currentRemoteDescription) {
               try {
                   const answerDescription = new RTCSessionDescription(data.answer);
                   await peerConnection.current?.setRemoteDescription(answerDescription);
                   setCallStatus('connected');
                   processCandidateQueue();
               } catch (e) {
                   console.error("Error setting remote description", e);
               }
          } else if (data.status === 'ended' || data.status === 'declined') {
              endCall(false);
          }
      });

      // Listen for remote ICE candidates
      // If I am caller, I listen to 'answerCandidates' (sent by callee)
      // If I am callee, I listen to 'offerCandidates' (sent by caller)
      const collectionName = activeCall.isCaller ? 'answerCandidates' : 'offerCandidates';
      const candidatesRef = collection(callDocRef, collectionName);
      
      const unsubCandidates = onSnapshot(candidatesRef, (snapshot) => {
           snapshot.docChanges().forEach((change) => {
               if (change.type === 'added') {
                   const candidateData = change.doc.data();
                   const candidate = new RTCIceCandidate(candidateData);
                   
                   if (peerConnection.current && peerConnection.current.remoteDescription) {
                       peerConnection.current.addIceCandidate(candidate).catch(e => console.error("Error adding ice candidate", e));
                   } else {
                       // Queue candidate if remote description not set yet
                       candidateQueue.current.push(candidate);
                   }
               }
           });
      });

      return () => {
          unsub();
          unsubCandidates();
      };
  }, [activeCall, config.roomKey]); // Deep dependency on activeCall object


  // --- Actions ---

  const processCandidateQueue = async () => {
      if (!peerConnection.current) return;
      while (candidateQueue.current.length > 0) {
          const candidate = candidateQueue.current.shift();
          if (candidate) {
              try {
                  await peerConnection.current.addIceCandidate(candidate);
              } catch (e) {
                  console.error("Error processing queued candidate", e);
              }
          }
      }
  };

  const playRingtone = () => {
      // Simple oscillator ringtone or load a file
      initAudio();
      const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3'); // Free asset
      audio.loop = true;
      audio.play().catch(e => console.log("Audio play error", e));
      ringtoneRef.current = audio;
  };

  const stopRingtone = () => {
      if (ringtoneRef.current) {
          ringtoneRef.current.pause();
          ringtoneRef.current = null;
      }
  };

  const startLocalStream = async (type: 'audio' | 'video') => {
    try {
        const constraints = {
            audio: { echoCancellation: true, noiseSuppression: true },
            video: type === 'video' ? { facingMode: facingMode } : false
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        localStream.current = stream;
        
        if (localVideoRef.current && type === 'video') {
            localVideoRef.current.srcObject = stream;
            localVideoRef.current.muted = true; // Always mute local video to prevent echo
        }
        return stream;
    } catch (err) {
        console.error("Error accessing media devices:", err);
        alert("Could not access camera/microphone. Please check permissions.");
        return null;
    }
  };

  // Fixed: Pass current callId and role explicitly to avoid stale closures
  const createPeerConnection = (callId: string, isCaller: boolean) => {
      const pc = new RTCPeerConnection(ICE_SERVERS);
      
      pc.onicecandidate = (event) => {
          if (event.candidate) {
              // If I am caller, I send to 'offerCandidates'
              // If I am callee, I send to 'answerCandidates'
              const collectionName = isCaller ? 'offerCandidates' : 'answerCandidates';
              const cRef = collection(db, "chats", config.roomKey, "calls", callId, collectionName);
              // Use simplified object for Firestore
              addDoc(cRef, event.candidate.toJSON());
          }
      };

      pc.ontrack = (event) => {
          console.log("Remote track received", event.streams);
          if (remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = event.streams[0];
          }
          remoteStream.current = event.streams[0];
      };

      if (localStream.current) {
          localStream.current.getTracks().forEach((track) => {
              pc.addTrack(track, localStream.current!);
          });
      }

      peerConnection.current = pc;
      return pc;
  };

  const initiateCall = async (targetUid: string, targetName: string, targetAvatar: string, type: 'audio' | 'video') => {
      onCloseParticipants(); // Close the list

      // 1. Get Media FIRST
      const stream = await startLocalStream(type);
      if(!stream) { return; }

      setCallStatus('calling');

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

      // 3. Create PC & Offer (Pass explicit ID and role)
      const pc = createPeerConnection(callDocRef.id, true);
      
      const offerDescription = await pc.createOffer();
      await pc.setLocalDescription(offerDescription);

      const offer = {
          type: offerDescription.type,
          sdp: offerDescription.sdp,
      };

      await updateDoc(callDocRef, { offer });

      // 4. Set State after everything is ready
      setActiveCall({ 
          id: callDocRef.id, 
          isCaller: true, 
          otherName: targetName, 
          otherAvatar: targetAvatar, 
          type 
      });
  };

  const answerCall = async () => {
      if (!incomingCall) return;
      const callId = incomingCall.id;
      const callType = incomingCall.type;
      
      stopRingtone();
      
      // 1. Get Media FIRST
      const stream = await startLocalStream(callType);
      if(!stream) { 
          declineCall();
          return; 
      }

      setCallStatus('connected');
      
      // 2. Create PC (Pass explicit ID and role=false for callee)
      const pc = createPeerConnection(callId, false);

      // 3. Set Remote Description (The Offer)
      const offerDescription = new RTCSessionDescription(incomingCall.offer);
      await pc.setRemoteDescription(offerDescription);
      
      // 4. Create Answer
      const answerDescription = await pc.createAnswer();
      await pc.setLocalDescription(answerDescription);

      const answer = {
          type: answerDescription.type,
          sdp: answerDescription.sdp,
      };

      // 5. Update Firestore with Answer
      const callRef = doc(db, "chats", config.roomKey, "calls", callId);
      await updateDoc(callRef, { answer, status: 'answered' });

      // 6. Process any candidates that arrived while we were setting up
      processCandidateQueue();

      // 7. Update State
      setActiveCall({ 
          id: callId, 
          isCaller: false, 
          otherName: incomingCall.callerName, 
          otherAvatar: incomingCall.callerAvatar, 
          type: callType 
      });
      setIncomingCall(null);
  };

  const declineCall = async () => {
      stopRingtone();
      if (incomingCall) {
        const callRef = doc(db, "chats", config.roomKey, "calls", incomingCall.id);
        await updateDoc(callRef, { status: 'declined' }).catch(e => console.log(e));
        setIncomingCall(null);
      }
  };

  const endCall = async (updateDb = true) => {
      // Cleanup WebRTC
      if (peerConnection.current) {
          peerConnection.current.onicecandidate = null;
          peerConnection.current.ontrack = null;
          peerConnection.current.close();
          peerConnection.current = null;
      }
      // Stop Tracks
      if (localStream.current) {
          localStream.current.getTracks().forEach(track => track.stop());
          localStream.current = null;
      }
      
      // Cleanup DB
      if (updateDb && activeCall) {
          const callRef = doc(db, "chats", config.roomKey, "calls", activeCall.id);
          try {
            await updateDoc(callRef, { status: 'ended' });
            // Cleanup old calls after a bit is handled by manual deletion if needed or separate cleanup job
          } catch(e) { console.log("Call cleanup error (might already be deleted)", e) }
      }

      setActiveCall(null);
      setCallStatus('idle');
      setIsMuted(false);
      setIsVideoOff(false);
      candidateQueue.current = [];
  };

  const toggleMute = () => {
      if (localStream.current) {
          localStream.current.getAudioTracks().forEach(track => track.enabled = !track.enabled);
          setIsMuted(!isMuted);
      }
  };

  const toggleVideo = () => {
    if (localStream.current && activeCall.type === 'video') {
        localStream.current.getVideoTracks().forEach(track => track.enabled = !track.enabled);
        setIsVideoOff(!isVideoOff);
    }
  };

  const switchCamera = async () => {
      if (activeCall.type !== 'video') return;
      const newMode = facingMode === 'user' ? 'environment' : 'user';
      setFacingMode(newMode);
      
      if (localStream.current) {
          localStream.current.getVideoTracks().forEach(track => track.stop());
      }
      
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
            audio: true, 
            video: { facingMode: newMode }
        });
        
        const newVideoTrack = newStream.getVideoTracks()[0];
        const sender = peerConnection.current?.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
            sender.replaceTrack(newVideoTrack);
        }
        
        if (localVideoRef.current) {
            localVideoRef.current.srcObject = newStream;
        }
        
        // We must update the ref, but keep the audio track if we were using it from the previous stream context
        // Usually getUserMedia returns a new audio track too, so this is fine.
        localStream.current = newStream;
      } catch (e) {
          console.error("Failed to switch camera", e);
      }
  };

  // --- RENDERERS ---

  if (incomingCall) {
      return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in zoom-in">
              <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 w-full max-w-sm shadow-2xl text-center border border-white/10">
                  <img src={incomingCall.callerAvatar} alt="Caller" className="w-24 h-24 rounded-full mx-auto mb-4 border-4 border-blue-500 shadow-lg bg-slate-200" />
                  <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-1">{incomingCall.callerName}</h3>
                  <p className="text-slate-500 dark:text-slate-400 mb-8 animate-pulse">
                      Incoming {incomingCall.type === 'video' ? 'Video' : 'Audio'} Call...
                  </p>
                  <div className="flex justify-center gap-8">
                      <button onClick={declineCall} className="flex flex-col items-center gap-2 group">
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
              <div className="flex-1 relative flex items-center justify-center overflow-hidden">
                  {/* Remote Video */}
                  <video 
                      ref={remoteVideoRef} 
                      autoPlay 
                      playsInline 
                      className={`w-full h-full object-contain bg-black ${activeCall.type === 'audio' ? 'hidden' : ''}`} 
                  />
                  
                  {/* Audio Only Placeholder */}
                  {(activeCall.type === 'audio' || (!remoteStream.current && callStatus === 'connected')) && (
                      <div className="flex flex-col items-center z-10">
                           <img src={activeCall.otherAvatar} className="w-32 h-32 rounded-full border-4 border-white/20 shadow-2xl mb-4 bg-slate-800" />
                           <h3 className="text-2xl text-white font-bold">{activeCall.otherName}</h3>
                           <p className="text-white/60">{callStatus === 'calling' ? 'Calling...' : 'Connected'}</p>
                      </div>
                  )}

                  {/* Local Video (PiP) */}
                  {activeCall.type === 'video' && (
                      <div className="absolute top-4 right-4 w-28 sm:w-36 aspect-[3/4] bg-slate-800 rounded-xl overflow-hidden shadow-2xl border border-white/10">
                          <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover transform scale-x-[-1]" />
                      </div>
                  )}
              </div>

              {/* Controls */}
              <div className="bg-slate-900/80 backdrop-blur p-6 pb-10 flex items-center justify-center gap-6">
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
                      onClick={() => endCall(true)} 
                      className="p-4 rounded-full bg-red-500 text-white hover:bg-red-600 transition shadow-lg shadow-red-500/50"
                  >
                      <PhoneOff size={32} fill="currentColor" />
                  </button>
              </div>
          </div>
      );
  }

  // Participant List Modal
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
