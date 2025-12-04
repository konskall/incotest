import React, { useEffect, useRef, useState } from 'react';
import { collection, doc, setDoc, onSnapshot, addDoc, updateDoc, getDocs, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db } from '../services/firebase';
import { Mic, MicOff, Video, VideoOff, PhoneOff, Users, Loader2, Phone } from 'lucide-react';

interface CallModalProps {
  roomKey: string;
  currentUserUid: string;
  isHost: boolean; // True if this user STARTED the call
  targetUids?: string[]; // New: List of specifically invited users
  isVideoCall: boolean; // New: Determine if video should be enabled
  onClose: () => void;
}

// STUN servers are used to find public IP addresses (NAT traversal)
const SERVERS = {
  iceServers: [
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
  iceCandidatePoolSize: 10,
};

const CallModal: React.FC<CallModalProps> = ({ roomKey, currentUserUid, isHost, targetUids, isVideoCall, onClose }) => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isCameraOn, setIsCameraOn] = useState(isVideoCall);
  const [status, setStatus] = useState<'initializing' | 'waiting' | 'connected' | 'failed'>('initializing');

  const pc = useRef<RTCPeerConnection | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // Prevent scrolling on body when modal is open
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = 'auto';
    };
  }, []);

  // Connect remote stream to video element whenever it changes
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
        remoteVideoRef.current.srcObject = remoteStream;
        // Explicit play is often needed for audio-only streams on some browsers
        remoteVideoRef.current.play().catch(e => console.warn("Remote play error:", e));
    }
  }, [remoteStream]);

  // Connect local stream to local video element
  useEffect(() => {
      if (localVideoRef.current && localStream && isVideoCall) {
          localVideoRef.current.srcObject = localStream;
      }
  }, [localStream, isVideoCall]);

  // Initialize WebRTC
  useEffect(() => {
    // Keep track of resources to clean up in the return block
    // We can't rely on state variables in the cleanup function because of closure staleness
    let localStreamInstance: MediaStream | null = null;
    let unsubs: (() => void)[] = [];

    const callDocRef = doc(db, 'chats', roomKey, 'calls', 'active_call');
    const offerCandidatesRef = collection(callDocRef, 'offerCandidates');
    const answerCandidatesRef = collection(callDocRef, 'answerCandidates');

    const cleanSignalingData = async () => {
        try {
            // Firestore does not delete subcollections when deleting a doc.
            // We must manually delete all candidates from previous calls to avoid "zombie" candidates.
            const batch = writeBatch(db);
            
            const offerSnap = await getDocs(offerCandidatesRef);
            offerSnap.forEach((d) => batch.delete(d.ref));

            const answerSnap = await getDocs(answerCandidatesRef);
            answerSnap.forEach((d) => batch.delete(d.ref));

            // Also delete the main call doc to ensure fresh start
            batch.delete(callDocRef);

            await batch.commit();
            console.log("Signaling data cleaned up.");
        } catch (e) {
            console.warn("Cleanup error (might be benign if empty):", e);
        }
    };

    const startCall = async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
             console.error("WebRTC not supported in this environment");
             alert("WebRTC is not supported in this browser context (requires HTTPS).");
             onClose();
             return;
        }

        // 0. HOST ONLY: Deep Clean before starting
        if (isHost) {
            setStatus('initializing');
            await cleanSignalingData();
        }

        // 1. Get Local Media with robust fallback
        try {
            if (isVideoCall) {
                // Attempt 1: Video + Audio
                try {
                    localStreamInstance = await navigator.mediaDevices.getUserMedia({ 
                        video: { facingMode: 'user' }, 
                        audio: { echoCancellation: true, noiseSuppression: true } 
                    });
                } catch (err: unknown) {
                    console.warn("Could not get video device, attempting audio only:", err);
                    // Fallback to audio only
                     localStreamInstance = await navigator.mediaDevices.getUserMedia({ 
                        video: false, 
                        audio: { echoCancellation: true, noiseSuppression: true } 
                    });
                    setIsCameraOn(false);
                }
            } else {
                 // Explicit Audio Only
                 localStreamInstance = await navigator.mediaDevices.getUserMedia({ 
                    video: false, 
                    audio: { echoCancellation: true, noiseSuppression: true } 
                });
                setIsCameraOn(false);
            }
        } catch (err: unknown) {
             // Attempt 3: No Media (Receive Only)
            console.warn("Could not get audio device either. Entering Receive-Only mode.", err);
            localStreamInstance = null;
            setIsCameraOn(false);
            setIsMicOn(false);
        }
        
        setLocalStream(localStreamInstance);

        // 2. Create Peer Connection
        const rtc = new RTCPeerConnection(SERVERS);
        // We assign to ref for cleanup, but use local 'rtc' variable for logic to satisfy TS strict checks
        pc.current = rtc;

        // Push tracks to PC if we have them
        if (localStreamInstance) {
            localStreamInstance.getTracks().forEach((track) => {
              rtc.addTrack(track, localStreamInstance!);
            });
        } else {
            // If no local media, we must explicitly ask to receive tracks
            // This ensures the other side sends us media even if we send none
            rtc.addTransceiver('audio', { direction: 'recvonly' });
            if (isVideoCall) {
                rtc.addTransceiver('video', { direction: 'recvonly' });
            }
        }

        // Pull remote tracks
        rtc.ontrack = (event) => {
          console.log("Track received:", event.track.kind);
          if (event.streams && event.streams[0]) {
              setRemoteStream(event.streams[0]);
          }
        };
        
        rtc.onconnectionstatechange = () => {
             console.log("Connection State:", rtc.connectionState);
             if (rtc.connectionState === 'connected') {
                 setStatus('connected');
             } else if (rtc.connectionState === 'disconnected' || rtc.connectionState === 'failed') {
                 setStatus('failed');
             }
        };

        // --- ICE CANDIDATE QUEUE SYSTEM ---
        const candidateQueue: RTCIceCandidate[] = [];

        const processCandidate = async (candidate: RTCIceCandidate) => {
             // IMPORTANT: Check remoteDescription (standard property), not currentRemoteDescription
             if (rtc.remoteDescription) {
                 try {
                     await rtc.addIceCandidate(candidate);
                 } catch (e) {
                     console.warn("Error adding received ice candidate", e);
                     // If it failed because remote description isn't ready (race condition despite check), re-queue
                     candidateQueue.push(candidate);
                 }
             } else {
                 candidateQueue.push(candidate);
             }
        };

        const flushCandidateQueue = async () => {
             while (candidateQueue.length > 0) {
                 const c = candidateQueue.shift();
                 if (c) {
                     try {
                        await rtc.addIceCandidate(c);
                     } catch (e) {
                        console.warn("Error flushing ice candidate", e);
                     }
                 }
             }
        };

        // 3. Signaling Logic (Firestore)
        if (isHost) {
          setStatus('waiting');
          // --- HOST LOGIC (Caller) ---
          
          // Save ICE candidates to firestore
          rtc.onicecandidate = (event) => {
            if (event.candidate) {
               const c = event.candidate;
               const candidateObj = { 
                   candidate: c.candidate, 
                   sdpMid: c.sdpMid, 
                   sdpMLineIndex: c.sdpMLineIndex 
               };
               addDoc(offerCandidatesRef, candidateObj);
            }
          };

          // Create Offer
          const offerDescription = await rtc.createOffer();
          await rtc.setLocalDescription(offerDescription);

          const offer = {
            sdp: offerDescription.sdp,
            type: offerDescription.type,
            timestamp: serverTimestamp()
          };

          // Initialize call doc with targetUids if provided
          await setDoc(callDocRef, { 
              offer,
              createdBy: currentUserUid,
              targetUids: targetUids || [], // Store who is invited
              type: isVideoCall ? 'video' : 'audio'
          });

          // Listen for Answer
          const unsubAnswer = onSnapshot(callDocRef, (snapshot) => {
            // Check if call was ended remotely (doc deleted)
            if (!snapshot.exists()) {
                onClose();
                return;
            }

            const data = snapshot.data();
            // Use local 'rtc' variable, not 'pc.current' to avoid TS18047
            // CHECK: !rtc.remoteDescription (Use the standard property)
            if (!rtc.remoteDescription && data?.answer) {
              const answerDescription = new RTCSessionDescription(data.answer);
              rtc.setRemoteDescription(answerDescription)
                 .then(() => {
                     // Flush any queued candidates now that we have a remote desc
                     flushCandidateQueue();
                 })
                 .catch(e => console.error("Error setting remote desc (host):", e));
            }
          });
          unsubs.push(unsubAnswer);

          // Listen for Remote ICE Candidates
          const unsubCandidates = onSnapshot(answerCandidatesRef, (snapshot) => {
            snapshot.docChanges().forEach((change) => {
              if (change.type === 'added') {
                const data = change.doc.data();
                const candidate = new RTCIceCandidate(data as RTCIceCandidateInit);
                processCandidate(candidate);
              }
            });
          });
          unsubs.push(unsubCandidates);

        } else {
          // --- JOINER LOGIC (Callee) ---
          setStatus('initializing');

          rtc.onicecandidate = (event) => {
            if (event.candidate) {
               const c = event.candidate;
               const candidateObj = { 
                   candidate: c.candidate, 
                   sdpMid: c.sdpMid, 
                   sdpMLineIndex: c.sdpMLineIndex 
               };
               addDoc(answerCandidatesRef, candidateObj);
            }
          };

          const unsubOffer = onSnapshot(callDocRef, (snapshot) => {
             // Wrap async logic in IIFE to keep onSnapshot synchronous
             (async () => {
                 // Check if call was ended remotely (doc deleted)
                 if (!snapshot.exists()) {
                     onClose();
                     return;
                 }
    
                 const data = snapshot.data();
                 // Check if we have an offer and haven't set remote desc yet
                 // CRITICAL: Use local 'rtc' variable to avoid possibly null error TS18047
                 // CHECK: !rtc.remoteDescription
                 if (!rtc.remoteDescription && data?.offer) {
                     const offerDescription = new RTCSessionDescription(data.offer);
                     await rtc.setRemoteDescription(offerDescription);
                     
                     // Flush any queued candidates now that we have a remote desc
                     await flushCandidateQueue();
    
                     const answerDescription = await rtc.createAnswer();
                     await rtc.setLocalDescription(answerDescription);
    
                     const answer = {
                         type: answerDescription.type,
                         sdp: answerDescription.sdp,
                         timestamp: serverTimestamp()
                     };
    
                     await updateDoc(callDocRef, { answer });
                 }
             })();
          });
          unsubs.push(unsubOffer);

          // Listen for Remote ICE Candidates (Caller's candidates)
          const unsubCandidates = onSnapshot(offerCandidatesRef, (snapshot) => {
            snapshot.docChanges().forEach((change) => {
              if (change.type === 'added') {
                const data = change.doc.data();
                const candidate = new RTCIceCandidate(data as RTCIceCandidateInit);
                processCandidate(candidate);
              }
            });
          });
          unsubs.push(unsubCandidates);
        }

      } catch (error) {
        console.error("Error starting call:", error);
        alert("An error occurred while initializing the call.");
        onClose();
      }
    };

    startCall();

    // Cleanup function
    return () => {
      // Unsubscribe from Firestore listeners
      unsubs.forEach(u => u());

      // Stop all media tracks
      if (localStreamInstance) {
        localStreamInstance.getTracks().forEach(track => {
            track.stop();
        });
      }
      
      // Close Peer Connection
      if (pc.current) {
        pc.current.close();
        pc.current = null;
      }
    };
  }, []); // Run once on mount

  const toggleMic = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach(track => {
        track.enabled = !isMicOn;
      });
      setIsMicOn(!isMicOn);
    }
  };

  const toggleCamera = () => {
    if (localStream) {
      localStream.getVideoTracks().forEach(track => {
        track.enabled = !isCameraOn;
      });
      setIsCameraOn(!isCameraOn);
    }
  };

  const handleHangup = async () => {
      onClose(); // Trigger unmount cleanup immediately for UI responsiveness
      
      // Clean up Firestore in background
      try {
          const callDocRef = doc(db, 'chats', roomKey, 'calls', 'active_call');
          
          // Best effort cleanup - in P2P usually whoever leaves destroys the call doc
          const batch = writeBatch(db);
          batch.delete(callDocRef);
          
          const offerSnapshot = await getDocs(collection(callDocRef, 'offerCandidates'));
          offerSnapshot.forEach(doc => batch.delete(doc.ref));
          
          const answerSnapshot = await getDocs(collection(callDocRef, 'answerCandidates'));
          answerSnapshot.forEach(doc => batch.delete(doc.ref));
          
          await batch.commit();
      } catch (e) {
          console.log("Cleanup warning:", e);
      }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-slate-950/90 backdrop-blur-md flex items-center justify-center animate-in fade-in duration-300">
       <div className="relative w-full h-full md:w-[90%] md:h-[90%] md:rounded-3xl bg-black overflow-hidden flex flex-col shadow-2xl border border-slate-800">
           
           {/* Header */}
           <div className="absolute top-0 left-0 right-0 p-4 z-10 bg-gradient-to-b from-black/70 to-transparent flex justify-between items-start">
               <div className="flex items-center gap-2">
                   <div className={`w-2 h-2 rounded-full ${status === 'connected' ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`}></div>
                   <span className="text-white font-mono text-sm tracking-widest shadow-black drop-shadow-md">
                       {status === 'connected' ? 'SECURE_CHANNEL_ACTIVE' : (status === 'waiting' ? 'WAITING_FOR_PEER' : 'ESTABLISHING_LINK...')}
                   </span>
               </div>
               {status === 'waiting' && (
                   <div className="bg-blue-600/80 backdrop-blur px-3 py-1 rounded-full text-xs text-white flex items-center gap-2">
                       <Loader2 size={12} className="animate-spin" />
                       Waiting for peer...
                   </div>
               )}
           </div>

           {/* Main Video (Remote) */}
           <div className="flex-1 relative flex items-center justify-center bg-slate-900">
                {/* 
                   CRITICAL FIX: Always render the video element even if remoteStream is null or audio-only.
                   This ensures audio can play. We control visibility with opacity.
                */}
                <video 
                    ref={remoteVideoRef} 
                    autoPlay 
                    playsInline 
                    className={`w-full h-full object-cover absolute inset-0 transition-opacity duration-300 ${(!remoteStream || remoteStream.getVideoTracks().length === 0) ? 'opacity-0' : 'opacity-100'}`} 
                />

                {/* Placeholder Overlay for Audio Calls or Loading */}
                {(!remoteStream || remoteStream.getVideoTracks().length === 0) && (
                    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center text-slate-500 gap-4">
                        <div className={`w-24 h-24 rounded-full flex items-center justify-center animate-pulse ${status === 'connected' ? 'bg-green-900/20 text-green-500' : 'bg-slate-800 text-slate-600'}`}>
                            {status === 'connected' ? <Phone size={48} /> : <Users size={40} />}
                        </div>
                        <p className="text-sm font-light text-center px-4">
                            {status === 'waiting' ? 'Share the room name to invite others.' : (status === 'connected' ? 'Audio Connected' : 'Connecting...')}
                        </p>
                    </div>
                )}
           </div>

           {/* Local Video (PIP) */}
           <div className="absolute bottom-24 right-4 w-32 md:w-48 aspect-[3/4] md:aspect-video bg-slate-800 rounded-xl overflow-hidden shadow-2xl border border-slate-700/50 transform transition-transform hover:scale-105 z-20">
               {/* Show video element only if we have local media, otherwise show placeholder */}
               <video 
                   ref={localVideoRef} 
                   autoPlay 
                   playsInline 
                   muted 
                   className={`w-full h-full object-cover transform scale-x-[-1] ${!isCameraOn || !localStream || !isVideoCall ? 'hidden' : ''}`} 
               />
               
               {(!isCameraOn || !localStream || !isVideoCall) && (
                   <div className="absolute inset-0 flex items-center justify-center bg-slate-800 text-slate-500 flex-col gap-1">
                       {isVideoCall ? <VideoOff size={24} /> : <Phone size={24} />}
                       <span className="text-[10px] uppercase">
                            {isVideoCall ? 'Cam Off' : 'Audio Only'}
                       </span>
                   </div>
               )}
               
               <div className="absolute bottom-2 left-2 text-[10px] bg-black/50 px-1.5 rounded text-white backdrop-blur-sm">
                   YOU {localStream ? '' : '(No Media)'}
               </div>
           </div>

           {/* Controls */}
           <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/90 via-black/50 to-transparent flex justify-center gap-6 z-30">
               {localStream && (
                 <button 
                     onClick={toggleMic}
                     className={`p-4 rounded-full transition-all duration-200 backdrop-blur-md ${isMicOn ? 'bg-slate-700/50 text-white hover:bg-slate-600' : 'bg-red-500/80 text-white hover:bg-red-600'}`}
                     title="Toggle Microphone"
                 >
                     {isMicOn ? <Mic size={24} /> : <MicOff size={24} />}
                 </button>
               )}

               <button 
                   onClick={handleHangup}
                   className="p-4 rounded-full bg-red-600 hover:bg-red-700 text-white shadow-lg shadow-red-600/30 transform hover:scale-110 transition-all duration-200"
                   title="End Call"
               >
                   <PhoneOff size={28} />
               </button>

               {localStream && isVideoCall && (
                 <button 
                     onClick={toggleCamera}
                     className={`p-4 rounded-full transition-all duration-200 backdrop-blur-md ${isCameraOn ? 'bg-slate-700/50 text-white hover:bg-slate-600' : 'bg-red-500/80 text-white hover:bg-red-600'}`}
                     title="Toggle Camera"
                 >
                     {isCameraOn ? <Video size={24} /> : <VideoOff size={24} />}
                 </button>
               )}
           </div>
       </div>
    </div>
  );
};

export default CallModal;
