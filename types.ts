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

export interface Message {
  id: string;
  text: string;
  uid: string;
  username: string;
  avatarURL: string;
  createdAt: any; // Firebase Timestamp
  attachment?: Attachment;
  isEdited?: boolean;
  reactions?: { [emoji: string]: string[] }; // Key: emoji char, Value: array of uids
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
