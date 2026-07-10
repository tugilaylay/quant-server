# TUGAY × QUANT — Sunucu (Faz 0 + Faz 1)

Bu, dashboard'un (`trading-bot-v43_12.html`) yanına eklenecek küçük bir Node.js
sunucusu. Tek işi var: **Binance API secret'ını tarayıcıdan uzak tutmak** ve
**circuit breaker'ı istemciden bağımsız zorunlu kılmak.**

Dashboard'daki hiçbir yer değişmedi — bu sunucu ayrı çalışır, sen istersen
dashboard'a "canlı emir gönder" butonu eklediğinde bu API'ye konuşur.

## Neden ayrı bir sunucu?

Tarayıcıda çalışan kod, kaynağını (view-source, dev tools) her zaman
gösterir. API secret'ını HTML/JS dosyasına yazarsan, sayfayı açan **herkes**
hesabından emir açabilir. Bu yüzden secret sadece burada, sunucunun ortam
değişkenlerinde (`.env`) durur — dashboard sadece kendi ürettiği bir
`DASHBOARD_TOKEN` ile bu sunucuya "emir aç" der, secret'ı hiç görmez.

## Kurulum

```bash
npm install
cp .env.example .env
# .env dosyasını aç, gerçek Binance API key/secret'ını ve rastgele bir
# DASHBOARD_TOKEN gir. BINANCE_TESTNET=true olarak bırak.
npm start
```

Sunucu `http://localhost:8787` üzerinde ayağa kalkar (portu `.env`'den
değiştirebilirsin).

## Binance API key oluştururken

- Binance → API Management → yeni key oluştur
- **Sadece "Futures" iznini aç**
- **"Withdraw" (para çekme) iznini KESİNLİKLE açma** — bot bozulsa/çalınsa
  bile parayı çekemesin diye
- IP kısıtlaması varsa sunucunu barındıracağın VPS'in IP'sini ekle

## Testnet ile haftalarca test et

`BINANCE_TESTNET=true` iken sahte parayla, gerçek Binance Futures testnet
ortamında (testnet.binancefuture.com) çalışır. `false` yapmadan önce en az
birkaç hafta burada dene — özellikle:
- Ağ kesintisi olduğunda ne oluyor
- Kısmi dolum (partial fill) senaryosu
- Circuit breaker gerçekten emri durduruyor mu (aşağıdaki test ile doğrula)

## Uç noktalar

| Uç nokta | Açıklama |
|---|---|
| `GET /api/status` | Circuit breaker durumu, testnet/mainnet bilgisi |
| `GET /api/account` | Binance hesap/pozisyon bilgisi (imzalı) |
| `POST /api/order` | `{symbol, side, quantity, leverage}` — market emri açar |
| `POST /api/close` | `{symbol, side, quantity}` — pozisyonu kapatır (reduceOnly) |
| `POST /api/trade-result` | `{pnl, equityAfter}` — dashboard her kapanan işlemden sonra bunu çağırmalı, circuit breaker sayacı için |
| `POST /api/circuit-breaker/reset` | Elle sıfırlama |

Tüm istekler `x-dashboard-token` header'ında `.env`'deki `DASHBOARD_TOKEN`'ı
beklerdi — yoksa `401` döner.

## Circuit breaker nasıl çalışır

`.env`'deki `MAX_DAILY_LOSS_PCT` ve `MAX_CONSECUTIVE_LOSSES` aşılınca sunucu
kendi kendini "tripped" durumuna alır ve `/api/order` çağrıları `423` koduyla
reddedilir — **dashboard'un o an ne düşündüğünden bağımsız olarak.** Sadece
`/api/circuit-breaker/reset` çağrısıyla (yani senin bilinçli müdahalenle)
açılır. Durum `circuit-breaker-state.json` dosyasına yazılır, sunucu yeniden
başlasa bile "tripped" durumu unutulmaz.

## Deploy (VPS'e taşırken)

- Küçük bir VPS yeterli (1 vCPU / 1GB RAM)
- `pm2 start server.js --name quant-server` ile arka planda ve sunucu
  yeniden başlasa bile ayakta tut
- `.env` dosyasını **asla** git'e ekleme (`.gitignore`'a ekle)
- Sunucuya sadece kendi IP'nden erişilebilecek şekilde firewall/VPN düşün

## Henüz yapılmadı — bir sonraki adım

- Dashboard'a bu sunucuya konuşan "🔴 Canlıya Geç" butonu eklemek
- `/api/order` çağrısından dönen gerçek fill fiyatını dashboard'daki
  simülasyon K/Z hesabına bağlamak (şu an ikisi ayrı dünyalar)
