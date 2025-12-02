import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getMessaging } from "firebase/messaging";

// Configuration from your provided code
const firebaseConfig = {
  apiKey: "AIzaSyCEwq6LnJk5aE7pcVzBZHgwF-9oojJG46Q",
  authDomain: "viberclone-d44c3.firebaseapp.com",
  projectId: "viberclone-d44c3",
  storageBucket: "viberclone-d44c3.firebasestorage.app",
  messagingSenderId: "98425544519",
  appId: "1:98425544519:web:8db7e8dc5068a69d497662",
  measurementId: "G-GX3P2QHXD1"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Messaging is only supported in secure contexts (HTTPS) and valid browser environments
let messaging: any = null;
if (typeof window !== "undefined" && "serviceWorker" in navigator) {
  try {
    messaging = getMessaging(app);
  } catch (e) {
    console.log("Firebase Messaging not supported in this environment");
  }
}

export { messaging };