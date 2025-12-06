import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Phone, Video, Mic, MicOff, VideoOff, PhoneOff, RotateCcw, X } from 'lucide-react';
import { db } from '../services/firebase';
import { collection, doc, onSnapshot, addDoc, updateDoc, serverTimestamp, query, where, getDoc } from 'firebase/firestore';
import { User, ChatConfig } from '../types';
import { initAudio } from '../utils/helpers';

// Small helpers for types
type CallStatus = 'idle' | 'calling' | 'connected';

action: unknown; // placeholder to keep format in the editor if needed

const ICE_SERVERS: RTCConfiguration = {
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
  // State
  const [incomingCall, setIncomingCall] = useState<any>(null);
  const [activeCall, setActiveCall] = useState<any>(null);
  const [callStatus, setCallStatus] = useState<CallStatus>('idle');

  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');

  // Refs
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const ringtoneRef = useRef<HTMLAudioElement | null>(null);

  // Firestore unsubscribes
  const unsubscribes = useRef<(() => void)[]>([]);

  // ----------------- cleanup -----------------
  const cleanup = useCallback(() => {
    // stop local tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }

    // stop remote tracks
    if (remoteStreamRef.current) {
      try {
        remoteStreamRef.current.getTracks().forEach(t => t.stop());
      } catch (e) {
        // ignore
      }
      remoteStreamRef.current = null;
    }

    // close pc
    if (peerConnection.current) {
      try { peerConnection.current.ontrack = null; } catch (e) {}
      try { peerConnection.current.onicecandidate = null; } catch (e) {}
      peerConnection.current.close();
      peerConnection.current = null;
    }

    // unsub firestore listeners
    unsubscribes.current.forEach(u => u && u());
    unsubscribes.current = [];

    setActiveCall(null);
    setIncomingCall(null);
    setCallStatus('idle');
    setIsMuted(false);
    setIsVideoOff(false);

    if (ringtoneRef.current) {
      try { ringtoneRef.current.pause(); } catch (e) {}
      ringtoneRef.current = null;
    }

    // clear video elements
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  }, []);

  // ----------------- create PC -----------------
  const createPC = useCallback((callId: string, isCaller: boolean) => {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnection.current = pc;

    // Remote stream: ensure a MediaStream exists and attach incoming tracks
    if (!remoteStreamRef.current) remoteStreamRef.current = new MediaStream();

    pc.ontrack = (event) => {
      // Some browsers provide event.streams[0]
      if (event.streams && event.streams[0]) {
        remoteStreamRef.current = event.streams[0];
      } else {
        // fallback: add track to remoteStreamRef
        if (!remoteStreamRef.current) remoteStreamRef.current = new MediaStream();
        remoteStreamRef.current.addTrack(event.track);
      }

      // Attach to video element
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
        remoteVideoRef.current.play().catch(() => {});
      }
    };

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const collectionName = isCaller ? 'offerCandidates' : 'answerCandidates';
      // write candidate to firestore
      try {
        addDoc(collection(db, 'chats', config.roomKey, 'calls', callId, collectionName), e.candidate.toJSON());
      } catch (err) {
        console.error('Failed to add ICE candidate to firestore', err);
      }
    };

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') {
        setCallStatus('connected');
      }
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        // do not immediately cleanup on 'disconnected' - remote might reconnect; but keep simple
        // cleanup();
      }
    };

    // Add local tracks (if already obtained)
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        try { pc.addTrack(track, localStreamRef.current!); } catch (e) { console.warn('addTrack failed', e); }
      });
    }

    return pc;
  }, [config.roomKey]);

  // ----------------- Incoming call listener -----------------
  useEffect(() => {
    const q = query(
      collection(db, 'chats', config.roomKey, 'calls'),
      where('calleeId', '==', user.uid),
      where('status', '==', 'offering')
    );

    const unsub = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data();
          // only accept if idle
          if (callStatus === 'idle' && !activeCall) {
            const callObj = { id: change.doc.id, ...data };
            setIncomingCall(callObj);

            // ringtone
            initAudio();
            const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
            audio.loop = true;
            audio.play().catch(() => {});
            ringtoneRef.current = audio;
          }
        }
        if (change.type === 'removed') {
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

    return () => { unsub(); cleanup(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.roomKey, user.uid, callStatus]);

  // ----------------- Initiate Call (Caller) -----------------
  const initiateCall = async (targetUid: string, targetName: string, targetAvatar: string, type: 'audio' | 'video') => {
    onCloseParticipants();
    setCallStatus('calling');

    // 1. Acquire media (store to localStreamRef)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === 'video' ? { facingMode } : false,
      });
      localStreamRef.current = stream;
      // attach local video immediately
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.muted = true;
        try { await localVideoRef.current.play(); } catch (e) {}
      }
    } catch (err) {
      console.error('getUserMedia failed', err);
      alert('Could not access camera / microphone');
      setCallStatus('idle');
      return;
    }

    // 2. Create call document
    const callDocRef = await addDoc(collection(db, 'chats', config.roomKey, 'calls'), {
      callerId: user.uid,
      callerName: config.username,
      callerAvatar: config.avatarURL,
      calleeId: targetUid,
      type,
      status: 'offering',
      createdAt: serverTimestamp(),
    });

    setActiveCall({ id: callDocRef.id, isCaller: true, otherName: targetName, otherAvatar: targetAvatar, type });

    // 3. Create PC and add tracks
    const pc = createPC(callDocRef.id, true);

    // If createPC didn't add tracks (e.g., local stream got set after), re-add
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => {
        try { pc.addTrack(t, localStreamRef.current!); } catch (e) {}
      });
    }

    // 4. Create offer
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // store offer in call doc
      await updateDoc(callDocRef, { offer: { type: offer.type, sdp: offer.sdp } });
    } catch (e) {
      console.error('Failed to create/store offer', e);
    }

    // 5. Listen for answer and status changes
    const unsubCallDoc = onSnapshot(callDocRef, (snapshot) => {
      const data = snapshot.data();
      if (!data) return;

      if (!pc.currentRemoteDescription && data.answer) {
        const answerDesc = new RTCSessionDescription(data.answer);
        pc.setRemoteDescription(answerDesc).catch(console.error);
        setCallStatus('connected');
      }

      if (data.status === 'ended' || data.status === 'declined') {
        cleanup();
      }
    });
    unsubscribes.current.push(unsubCallDoc);

    // 6. Listen for callee (answer) candidates
    const answerCandCol = collection(db, 'chats', config.roomKey, 'calls', callDocRef.id, 'answerCandidates');
    const unsubAnswerCandidates = onSnapshot(answerCandCol, (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data();
          try { pc.addIceCandidate(new RTCIceCandidate(data)).catch(console.error); } catch (e) { console.error(e); }
        }
      });
    });
    unsubscribes.current.push(unsubAnswerCandidates);

    // 7. Also listen for call doc removals/edits from remote
  };

  // ----------------- Answer Call (Callee) -----------------
  const answerCall = async () => {
    if (!incomingCall) return;
    const callId = incomingCall.id;
    const callType = incomingCall.type;

    // stop ringtone
    if (ringtoneRef.current) {
      ringtoneRef.current.pause();
      ringtoneRef.current = null;
    }

    setActiveCall({ id: callId, isCaller: false, otherName: incomingCall.callerName, otherAvatar: incomingCall.callerAvatar, type: callType });
    setIncomingCall(null);
    setCallStatus('connected');

    // 1. Get media
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: callType === 'video' ? { facingMode } : false });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.muted = true;
        try { await localVideoRef.current.play(); } catch (e) {}
      }
    } catch (err) {
      console.error('getUserMedia failed', err);
      cleanup();
      return;
    }

    // 2. Create PC and add tracks
    const pc = createPC(callId, false);
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => {
        try { pc.addTrack(t, localStreamRef.current!); } catch (e) {}
      });
    }

    // 3. Set remote description (offer)
    try {
      const callDocRef = doc(db, 'chats', config.roomKey, 'calls', callId);
      const callSnap = await getDoc(callDocRef);
      if (!callSnap.exists()) {
        console.warn('Call doc disappeared');
        cleanup();
        return;
      }
      const data = callSnap.data();
      if (!data?.offer) {
        console.warn('No offer present');
      } else {
        const offerDesc = new RTCSessionDescription(data.offer);
        await pc.setRemoteDescription(offerDesc);
      }
    } catch (e) {
      console.error('Failed to set remote description (offer)', e);
    }

    // 4. Create answer
    try {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await updateDoc(doc(db, 'chats', config.roomKey, 'calls', callId), { answer: { type: answer.type, sdp: answer.sdp }, status: 'answered' });
    } catch (e) {
      console.error('Failed to create/send answer', e);
    }

    // 5. Listen for offerCandidates (caller)
    const offerCandCol = collection(db, 'chats', config.roomKey, 'calls', callId, 'offerCandidates');
    const unsubOfferCandidates = onSnapshot(offerCandCol, (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data();
          try { pc.addIceCandidate(new RTCIceCandidate(data)).catch(console.error); } catch (e) { console.error(e); }
        }
      });
    });
    unsubscribes.current.push(unsubOfferCandidates);

    // 6. Watch call doc for end signal
    const unsubDoc = onSnapshot(doc(db, 'chats', config.roomKey, 'calls', callId), (snap) => {
      const d = snap.data();
      if (!d) return;
      if (d.status === 'ended') cleanup();
    });
    unsubscribes.current.push(unsubDoc);
  };

  // ----------------- Hangup / Reject -----------------
  const hangupCall = async () => {
    if (activeCall) {
      const callRef = doc(db, 'chats', config.roomKey, 'calls', activeCall.id);
      try { await updateDoc(callRef, { status: 'ended' }); } catch (e) {}
    }
    cleanup();
  };

  const rejectCall = async () => {
    if (incomingCall) {
      try { await updateDoc(doc(db, 'chats', config.roomKey, 'calls', incomingCall.id), { status: 'declined' }); } catch (e) {}
      setIncomingCall(null);
    }
    if (ringtoneRef.current) {
      ringtoneRef.current.pause();
      ringtoneRef.current = null;
    }
  };

  // ----------------- Local video attachment effect -----------------
  useEffect(() => {
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
      localVideoRef.current.muted = true;
    }
  }, [activeCall, callStatus]);

  // ----------------- Toggles -----------------
  const toggleMute = () => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getAudioTracks().forEach(t => t.enabled = !t.enabled);
    setIsMuted(!isMuted);
  };

  const toggleVideo = () => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getVideoTracks().forEach(t => t.enabled = !t.enabled);
    setIsVideoOff(!isVideoOff);
  };

  const switchCamera = async () => {
    if (!localStreamRef.current) return;
    const newMode = facingMode === 'user' ? 'environment' : 'user';

    try {
      // get only the new video track
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: newMode }, audio: false });
      const newVideoTrack = newStream.getVideoTracks()[0];
      if (!newVideoTrack) return;

      // replace track in peer connection
      const sender = peerConnection.current?.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        await sender.replaceTrack(newVideoTrack);
      } else if (peerConnection.current && localStreamRef.current) {
        // fallback: add track
        try { peerConnection.current.addTrack(newVideoTrack, localStreamRef.current); } catch (e) { }
      }

      // stop old video tracks and update local stream ref
      localStreamRef.current.getVideoTracks().forEach(t => t.stop());
      // keep audio tracks if any
      const audioTracks = localStreamRef.current.getAudioTracks();
      const merged = new MediaStream([...audioTracks, newVideoTrack]);
      localStreamRef.current = merged;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = merged;
        try { await localVideoRef.current.play(); } catch (e) {}
      }

      setFacingMode(newMode);
    } catch (e) {
      console.error('switchCamera error', e);
    }
  };

  // ----------------- Render logic -----------------
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
        <div className="flex-1 relative flex items-center justify-center overflow-hidden bg-black">
          <video ref={remoteVideoRef} autoPlay playsInline className={`w-full h-full object-contain ${activeCall.type === 'audio' ? 'hidden' : ''}`} />

          {activeCall.type === 'audio' && (
            <div className="flex flex-col items-center z-10 animate-in fade-in zoom-in">
              <img src={activeCall.otherAvatar} className="w-32 h-32 rounded-full border-4 border-white/20 shadow-2xl mb-6 bg-slate-800" />
              <h3 className="text-3xl text-white font-bold mb-2">{activeCall.otherName}</h3>
              <p className="text-white/60 text-lg">{callStatus === 'calling' ? 'Calling...' : 'Connected'}</p>
            </div>
          )}

          {activeCall.type === 'video' && (
            <div className="absolute top-4 right-4 w-28 sm:w-36 aspect-[3/4] bg-slate-800 rounded-xl overflow-hidden shadow-2xl border border-white/10 z-20">
              <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover transform scale-x-[-1]" />
            </div>
          )}
        </div>

        <div className="bg-slate-900/80 backdrop-blur p-6 pb-10 flex items-center justify-center gap-6 z-30">
          <button onClick={toggleMute} className={`p-4 rounded-full ${isMuted ? 'bg-white text-slate-900' : 'bg-white/10 text-white hover:bg-white/20'} transition`}>
            {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
          </button>

          {activeCall.type === 'video' && (
            <>
              <button onClick={toggleVideo} className={`p-4 rounded-full ${isVideoOff ? 'bg-white text-slate-900' : 'bg-white/10 text-white hover:bg-white/20'} transition`}>
                {isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}
              </button>
              <button onClick={switchCamera} className="p-4 rounded-full bg-white/10 text-white hover:bg-white/20 transition md:hidden">
                <RotateCcw size={24} />
              </button>
            </>
          )}

          <button onClick={hangupCall} className="p-4 rounded-full bg-red-500 text-white hover:bg-red-600 transition shadow-lg shadow-red-500/50">
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
                  <button onClick={() => initiateCall(u.uid, u.username, u.avatar, 'audio')} className="p-2 text-slate-400 hover:text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg transition" title="Voice Call">
                    <Phone size={18} />
                  </button>
                  <button onClick={() => initiateCall(u.uid, u.username, u.avatar, 'video')} className="p-2 text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition" title="Video Call">
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
