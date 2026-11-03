# FUTBOLBARBAROS

Arkadaş grubuna özel futbol tahmin ligi. Arayüz + Firebase Firestore başlangıç projesi.

## Şu an neler var?
- Yeşil saha temalı, mobil uyumlu arayüz
- Grup kodu ve oyuncu adıyla katılım
- Anonim Firebase Authentication ile cihaz başına kalıcı UID
- Maç ekleme ve maç başlamadan skor tahmini
- Başlama saatinde tahmin kilidi
- 3 puan tam skor / 1 puan doğru maç sonucu
- Puan tablosu ve yönetici maç sonucu girişi

## Önemli güvenlik notu
Tarayıcıdaki anonim UID, aynı fiziksel cihazı kusursuz biçimde tanımlamaz. Tarayıcı verisi silinirse veya başka tarayıcı/cihaz kullanılırsa yeni UID üretilebilir. 5-10 kişilik arkadaş grubu için caydırıcı bir ilk sürümdür; kesin kişi doğrulaması değildir. Gerçek yönetici güvenliği Firestore Security Rules ile sağlanır. Yönetici UID'sini hem `config.js` hem `firestore.rules` içine yazmadan yayına almayın.

## Kurulum (ücretsiz katmanla)
1. Firebase Console'da yeni proje oluştur.
2. Build > Authentication > Sign-in method bölümünden **Anonymous** girişini etkinleştir.
3. Build > Firestore Database bölümünden veritabanı oluştur.
4. Proje ayarlarından Web App ekle ve Firebase config değerlerini al.
5. Bu paketteki `config.js` dosyasında Firebase web yapılandırması doldurulmuştur. `ADMIN_UID` alanını ilk girişten sonra kendi UID'nle değiştireceksin.
6. `index.html`, `style.css`, `app.js`, `config.js` dosyalarını bir statik hosting alanına yükle (ör. GitHub Pages).
7. Siteyi ilk kez açıp grup kodu ve ad girmeden önce Firebase Authentication > Users bölümünden kendi anonim UID'ni al. `config.js` içindeki `ADMIN_UID` alanına yaz. Ardından siteyi yeniden yükle.
8. `firestore.rules` içindeki `YONETICI_UID_BURAYA` değerini aynı UID ile değiştir ve Firestore Rules bölümünde yayımla.
9. Firestore'da `groups/BARBAROS26` belgesini oluştur. Örnek alanlar: `{ "name": "FUTBOLBARBAROS", "createdBy": "YONETICI_UID" }`. Sonra oyuncular bu kodla katılabilir.
10. Siteye girip grup kodu olarak `BARBAROS26` yaz. Arkadaşların da aynı kodla katılabilir.

## Yönetici UID'sini bulma
Firebase Console > Authentication > Users. İlk anonim girişten sonra kendi kullanıcının UID sütununu kopyala.

## Geliştirme notu
Bu bir başlangıç sürümüdür. Yönetici ilk kurulumda grup belgesini Firebase Console'dan oluşturur. Üretim yayını öncesinde grup kodu deneme sınırı, kullanıcı adı değişmezliği, yarış koşullarına karşı tahmin kilidi ve yönetici işlemleri için ek sunucu doğrulaması eklenmesi önerilir.
