importScripts('https://www.gstatic.com/firebasejs/9.22.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.1/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyCEwq6LnJk5aE7pcVzBZHgwF-9oojJG46Q",
  authDomain: "viberclone-d44c3.firebaseapp.com",
  projectId: "viberclone-d44c3",
  storageBucket: "viberclone-d44c3.firebasestorage.app",
  messagingSenderId: "98425544519",
  appId: "1:98425544519:web:8db7e8dc5068a69d497662",
  measurementId: "G-GX3P2QHXD1"
};

firebase.initializeApp(firebaseConfig);

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);
  
  const notificationTitle = payload.notification?.title || 'New Message';
  const notificationOptions = {
    body: payload.notification?.body || 'You have a new message',
    icon: '/incognitochatapp/favicon-96x96.png'
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});