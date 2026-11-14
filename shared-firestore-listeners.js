// Firestore dinleyicilerini modüller arasında paylaşır.
// Aynı sorguya birden fazla modül abone olsa bile tarayıcı tek onSnapshot açar.
import { onSnapshot } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';

const stores = new WeakMap();

function callSafely(callback, value, label) {
  if (typeof callback !== 'function') return;
  try {
    callback(value);
  } catch (error) {
    console.error('Paylaşılan Firestore dinleyicisi (' + label + '):', error);
  }
}

export function subscribeSharedSnapshot(db, key, target, onNext, onError = null) {
  if (!db || typeof key !== 'string' || !key || typeof onNext !== 'function') {
    throw new TypeError('Geçerli Firestore, anahtar ve onNext callback gerekli.');
  }

  let entries = stores.get(db);
  if (!entries) {
    entries = new Map();
    stores.set(db, entries);
  }

  let entry = entries.get(key);
  if (!entry) {
    entry = {
      subscribers: new Set(),
      unsubscribe: null,
      snapshot: null,
      hasSnapshot: false,
      lastError: null
    };
    entries.set(key, entry);

    entry.unsubscribe = onSnapshot(
      target,
      snapshot => {
        entry.snapshot = snapshot;
        entry.hasSnapshot = true;
        entry.lastError = null;

        for (const subscriber of [...entry.subscribers]) {
          callSafely(subscriber.onNext, snapshot, key);
        }
      },
      error => {
        entry.lastError = error;
        for (const subscriber of [...entry.subscribers]) {
          callSafely(subscriber.onError, error, key);
        }
      }
    );
  }

  const subscriber = { onNext, onError };
  entry.subscribers.add(subscriber);

  // Abone sonradan eklendiyse yeni bir Firestore okuması yapmadan son görüntüyü paylaş.
  if (entry.hasSnapshot) callSafely(onNext, entry.snapshot, key);
  if (entry.lastError) callSafely(onError, entry.lastError, key);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    entry.subscribers.delete(subscriber);

    if (entry.subscribers.size === 0) {
      entry.unsubscribe?.();
      entries.delete(key);
    }
  };
}
