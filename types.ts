export interface User {
  uid: string;
  isAnonymous: boolean;
}

export interface Attachment {
  url: string; // Base64 string
  name: string;
  type: string;
  size: number;
}

export interface ReplyInfo {
  id: string;
  username: string;
  text: string;
  isAttachment: boolean;
}

export interface Message {
  id: string;
  text: string;
  uid: string;
  username: string;
  avatarURL: string;
  createdAt: any; // Firebase Timestamp
  attachment?: Attachment;
  location?: {
    lat: number;
    lng: number;
  };
  isEdited?: boolean;
  reactions?: { [emoji: string]: string[] }; // Key: emoji char, Value: array of uids
  replyTo?: ReplyInfo | null;
  type?: 'text' | 'system'; // Added system type
}

export interface ChatConfig {
  username: string;
  avatarURL: string;
  roomName: string;
  pin: string;
  roomKey: string; // generated from roomName + pin
}

export interface Presence {
  uid: string;
  username: string;
  avatar: string;
  status: 'active' | 'inactive';
  lastSeen: any;
  isTyping?: boolean;
}

export interface CallData {
  id: string;
  callerId: string;
  callerName: string;
  callerAvatar: string;
  calleeId: string;
  type: 'audio' | 'video';
  status: 'offering' | 'answered' | 'ended' | 'declined';
  offer?: any;
  answer?: any;
  renegotiating?: any;
  createdAt: any;
}
