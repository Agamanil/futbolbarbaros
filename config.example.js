// Bu dosyayı config.js olarak kopyalayıp Firebase Console'dan aldığın değerleri gir.
export const firebaseConfig = {
  apiKey: 'BURAYA_API_KEY',
  authDomain: 'PROJE_ID.firebaseapp.com',
  projectId: 'PROJE_ID',
  storageBucket: 'PROJE_ID.appspot.com',
  messagingSenderId: 'SENDER_ID',
  appId: 'APP_ID'
};
// İlk kez giriş yaptıktan sonra tarayıcı konsolundan auth.currentUser.uid öğrenilip buraya yazılacak.
// Gerçek güvenlik Firestore kurallarıyla sağlanır; bu değer tek başına güvenlik değildir.
export const ADMIN_UID = 'YONETICI_UID_BURAYA';
export const DEFAULT_GROUP_CODE = 'BARBAROS26';
