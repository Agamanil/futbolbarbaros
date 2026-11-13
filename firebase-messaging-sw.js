/* FUTBOLBARBAROS Firebase Cloud Messaging service worker */
importScripts('https://www.gstatic.com/firebasejs/13.2.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/13.2.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyCNpVWp9mughfYhzxV-93xaJ8O7rr_SOGY',
  authDomain: 'futbolbarbarosdenemesi.firebaseapp.com',
  projectId: 'futbolbarbarosdenemesi',
  storageBucket: 'futbolbarbarosdenemesi.firebasestorage.app',
  messagingSenderId: '717015885345',
  appId: '1:717015885345:web:8bfa6ac8c43152d440e560',
  measurementId: 'G-60V1Y1ZXGP'
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const title = payload.notification?.title || payload.data?.title || 'FUTBOLBARBAROS';
  const options = {
    body: payload.notification?.body || payload.data?.body || '',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: { url: payload.fcmOptions?.link || payload.data?.url || '/' }
  };
  return self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client && client.url !== targetUrl) await client.navigate(targetUrl);
        return;
      }
    }
    if (clients.openWindow) await clients.openWindow(targetUrl);
  })());
});
