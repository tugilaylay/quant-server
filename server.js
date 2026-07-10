// ═══════════════════════════════════════════════════════════════
// TUGAY × QUANT — Faz 0 + Faz 1 çekirdek sunucusu
// Amaç: API secret'ı ASLA tarayıcıya çıkarmadan, imzalı Binance
// emirlerini burada göndermek ve circuit breaker'ı sunucu
// tarafında (istemciden bağımsız) zorunlu kılmak.
//
// Dashboard (trading-bot-v43_12.html) bu sunucuya HTTP ile konuşur.
// Binance'e doğrudan konuşan tek yer burasıdır.
// ═══════════════════════════════════════════════════════════════

import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ───────── Ayarlar ─────────
const PORT = process.env.PORT || 8787;
const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const IS_TESTNET = (process.env.BINANCE_TESTNET || 'true').toLowerCase() === 'true';
const BASE_URL = IS_TESTNET
  ? 'https://testnet.binancefuture.com'
  : 'https://fapi.binance.com';

const MAX_DAILY_LOSS_PCT = parseFloat(process.env.MAX_DAILY_LOSS_PCT || '5');       // gün içi max kayıp %
const MAX_CONSECUTIVE_LOSSES = parseInt(process.env.MAX_CONSECUTIVE_LOSSES || '4'); // üst üste kaç kayıptan sonra dursun
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN; // dashboard ↔ sunucu arası paylaşılan basit anahtar

if (!API_KEY || !API_SECRET) {
  console.error('❌ BINANCE_API_KEY / BINANCE_API_SECRET .env dosyasında eksik. Sunucu başlamıyor.');
  process.exit(1);
}
if (!DASHBOARD_TOKEN) {
  console.error('❌ DASHBOARD_TOKEN .env dosyasında eksik. Bu, sunucuna kimin emir gönderebileceğini kısıtlayan basit paylaşımlı sırdır — mutlaka ayarla.');
  process.exit(1);
}

console.log(IS_TESTNET
  ? '🧪 TESTNET modunda çalışıyor — gerçek para YOK.'
  : '🔴 MAINNET modunda çalışıyor — GERÇEK PARA. Dikkatli ol.');

// ───────── Circuit breaker durumu (dosyaya kalıcı) ─────────
const STATE_FILE = path.join(__dirname, 'circuit-breaker-state.json');

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const state = JSON.parse(raw);
    const today = new Date().toISOString().slice(0, 10);
    if (state.day !== today) {
      // yeni gün — günlük sayaçları sıfırla, ama tripped durumunu ELLE
      // sıfırlanana kadar koru (sabah otomatik "unutmasın")
      return { ...state, day: today, dailyStartEquity: null, dailyPnl: 0, consecutiveLosses: state.consecutiveLosses || 0 };
    }
    return state;
  } catch {
    return {
      day: new Date().toISOString().slice(0, 10),
      dailyStartEquity: null,
      dailyPnl: 0,
      consecutiveLosses: 0,
      tripped: false,
      trippedReason: null,
      trippedAt: null,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let cbState = loadState();

function checkCircuitBreaker() {
  if (cbState.tripped) {
    return { blocked: true, reason: cbState.trippedReason };
  }
  if (cbState.dailyStartEquity && MAX_DAILY_LOSS_PCT > 0) {
    const lossPct = -(cbState.dailyPnl / cbState.dailyStartEquity) * 100;
    if (lossPct >= MAX_DAILY_LOSS_PCT) {
      cbState.tripped = true;
      cbState.trippedReason = `Günlük zarar limiti aşıldı (%${lossPct.toFixed(2)} ≥ %${MAX_DAILY_LOSS_PCT}).`;
      cbState.trippedAt = new Date().toISOString();
      saveState(cbState);
      return { blocked: true, reason: cbState.trippedReason };
    }
  }
  if (cbState.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
    cbState.tripped = true;
    cbState.trippedReason = `Üst üste ${cbState.consecutiveLosses} kayıp — otomatik durduruldu.`;
    cbState.trippedAt = new Date().toISOString();
    saveState(cbState);
    return { blocked: true, reason: cbState.trippedReason };
  }
  return { blocked: false };
}

// Dashboard, her kapanan işlemden sonra bu endpoint'e sonucu bildirir;
// böylece sunucu kendi circuit breaker sayaçlarını tutar (istemciye güvenmez).
function recordTradeResult(pnl, equityAfter) {
  if (cbState.dailyStartEquity === null) cbState.dailyStartEquity = equityAfter - pnl;
  cbState.dailyPnl += pnl;
  cbState.consecutiveLosses = pnl < 0 ? cbState.consecutiveLosses + 1 : 0;
  saveState(cbState);
}

// ───────── Binance imzalı istek yardımcıları ─────────
function sign(queryString) {
  return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

async function binanceSignedRequest(method, endpoint, params = {}) {
  const timestamp = Date.now();
  const query = new URLSearchParams({ ...params, timestamp, recvWindow: 5000 }).toString();
  const signature = sign(query);
  const url = `${BASE_URL}${endpoint}?${query}&signature=${signature}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'X-MBX-APIKEY': API_KEY },
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.msg || `Binance hata kodu: ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ───────── Express app ─────────
const app = express();
app.use(express.json());

// Basit paylaşımlı-anahtar doğrulaması — dashboard'dan gelen her istek bunu içermeli.
app.use((req, res, next) => {
  const token = req.headers['x-dashboard-token'];
  if (token !== DASHBOARD_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Yetkisiz — geçersiz dashboard token.' });
  }
  next();
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    testnet: IS_TESTNET,
    circuitBreaker: cbState,
    limits: { MAX_DAILY_LOSS_PCT, MAX_CONSECUTIVE_LOSSES },
  });
});

app.get('/api/account', async (req, res) => {
  try {
    const data = await binanceSignedRequest('GET', '/fapi/v2/account');
    res.json({ ok: true, data });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Piyasa emriyle pozisyon aç. body: { symbol, side: 'BUY'|'SELL', quantity, leverage }
app.post('/api/order', async (req, res) => {
  const cb = checkCircuitBreaker();
  if (cb.blocked) {
    return res.status(423).json({ ok: false, error: `🛑 Circuit breaker devrede: ${cb.reason}` });
  }

  const { symbol, side, quantity, leverage } = req.body || {};
  if (!symbol || !side || !quantity) {
    return res.status(400).json({ ok: false, error: 'symbol, side ve quantity zorunlu.' });
  }
  if (!['BUY', 'SELL'].includes(side)) {
    return res.status(400).json({ ok: false, error: "side sadece 'BUY' veya 'SELL' olabilir." });
  }

  try {
    if (leverage) {
      await binanceSignedRequest('POST', '/fapi/v1/leverage', { symbol, leverage });
    }
    const order = await binanceSignedRequest('POST', '/fapi/v1/order', {
      symbol, side, type: 'MARKET', quantity,
    });
    console.log(`✅ Emir gönderildi: ${side} ${quantity} ${symbol}`);
    res.json({ ok: true, order });
  } catch (e) {
    console.error(`❌ Emir hatası: ${e.message}`);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Pozisyonu kapat (ters yönde market emri). body: { symbol, side, quantity }
app.post('/api/close', async (req, res) => {
  const { symbol, side, quantity } = req.body || {};
  if (!symbol || !side || !quantity) {
    return res.status(400).json({ ok: false, error: 'symbol, side ve quantity zorunlu.' });
  }
  try {
    const order = await binanceSignedRequest('POST', '/fapi/v1/order', {
      symbol, side, type: 'MARKET', quantity, reduceOnly: true,
    });
    res.json({ ok: true, order });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Dashboard, kapanan her işlemden sonra burayı çağırır — circuit breaker sayaçları için.
app.post('/api/trade-result', (req, res) => {
  const { pnl, equityAfter } = req.body || {};
  if (typeof pnl !== 'number' || typeof equityAfter !== 'number') {
    return res.status(400).json({ ok: false, error: 'pnl ve equityAfter sayı olmalı.' });
  }
  recordTradeResult(pnl, equityAfter);
  res.json({ ok: true, circuitBreaker: cbState });
});

// Circuit breaker'ı elle sıfırlama — kasıtlı, günü kurtarmak için.
app.post('/api/circuit-breaker/reset', (req, res) => {
  cbState.tripped = false;
  cbState.trippedReason = null;
  cbState.consecutiveLosses = 0;
  saveState(cbState);
  console.log('🔓 Circuit breaker elle sıfırlandı.');
  res.json({ ok: true, circuitBreaker: cbState });
});

app.listen(PORT, () => {
  console.log(`🚀 QUANT sunucusu ${PORT} portunda çalışıyor (${IS_TESTNET ? 'TESTNET' : 'MAINNET'}).`);
});
