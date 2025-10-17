// server_v3.7.js — 顯示代碼、支援「查編號」、模糊搜尋強化
// 功能：查價 / 庫存 / 下單 / 查編號（只回代碼＋書名）
// - 回覆格式（查價/庫存）：
//   301｜指甲花＋CD（台語童謠）
//   定價：360 元
//   庫存：有貨
//
// - 回覆格式（查編號）：
//   301｜指甲花＋CD（台語童謠）
//
// 注意：請在環境變數中設定 CHANNEL_SECRET、CHANNEL_ACCESS_TOKEN、GOOGLE_SHEETS_ID、GOOGLE_CREDENTIALS_JSON
import 'dotenv/config';
import express from 'express';
import { Client, validateSignature } from '@line/bot-sdk';
import { google } from 'googleapis';
import dayjs from 'dayjs';

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const app = express();
app.use('/webhook', express.json({ verify: (req, res, buf) => (req.rawBody = buf) }));

const client = new Client(config);

// ===== 簡易記憶（最近命中的商品） =====
const userLastKeywords = new Map();
function setLastKeywords(userId, items) {
  if (!userId) return;
  const normalized = (items || [])
    .map(p => ({ code: (p.code || '').trim(), name: (p.name || '').trim() }))
    .filter(p => p.code || p.name);
  userLastKeywords.set(userId, normalized.slice(0, 10));
}
function getLastKeywords(userId) {
  return userLastKeywords.get(userId) || [];
}

// ===== Google Sheets =====
function getSheets() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth: jwt });
}

const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
const TAB_PRODUCTS = process.env.SHEET_TAB_PRODUCTS || 'products';
const TAB_ORDERS = process.env.SHEET_TAB_ORDERS || 'orders';

// ===== Webhook =====
app.post('/webhook', async (req, res) => {
  const signature = req.get('x-line-signature');
  if (!validateSignature(req.rawBody, config.channelSecret, signature)) {
    return res.status(401).send('Invalid signature');
  }
  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const textRaw = (event.message.text || '').trim();
  const userId = event.source.userId;
  const profile = await getProfileSafe(userId);

  // 下單：下單 品名 x 數量
  const orderMatch = textRaw.match(/^下單\s*(.+?)\s*[xX＊*]\s*(\d+)$/);
  if (orderMatch) {
    const [, keyword, qty] = orderMatch;
    return replyOrder(event.replyToken, profile, keyword, parseInt(qty, 10));
  }

  // 查編號：只顯示 代碼｜書名
  if (/^查編號/.test(textRaw)) {
    const keyword = textRaw.replace(/^查編號/, '').trim();
    return replyCodeOnly(event.replyToken, userId, keyword);
  }

  // 查價 / 庫存
  if (/^(查價|報價)/.test(textRaw)) {
    const keyword = textRaw.replace(/^(查價|報價)/, '').trim();
    return replyPrice(event.replyToken, userId, keyword);
  }
  if (/^庫存/.test(textRaw)) {
    const keyword = textRaw.replace(/^庫存/, '').trim();
    return replyStock(event.replyToken, userId, keyword);
  }

  return replyText(event.replyToken,
    '您可以輸入：\n' +
    '• 查價 商品名\n' +
    '• 庫存 商品名\n' +
    '• 下單 商品名 x 數量\n' +
    '• 查編號 商品名（只顯示 代碼｜書名）'
  );
}

async function getProfileSafe(userId) {
  try {
    return await client.getProfile(userId);
  } catch {
    return { userId, displayName: '' };
  }
}

async function replyText(token, text) {
  const chunks = chunkMessage(text, 1400);
  const messages = chunks.map(t => ({ type: 'text', text: t }));
  return client.replyMessage(token, messages);
}

// ===== 文字正規化（去語助詞、空白） =====
function normalizeText(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[的了著嗎呢啊喔呀哦耶]/g, '') // 去掉常見語助詞
    .replace(/\s+/g, '')
    .trim();
}

// ===== 產品讀取（A:F -> code,name,price,stock,restock_eta,remarks） =====
async function fetchProducts() {
  const sheets = getSheets();
  const range = `${TAB_PRODUCTS}!A:F`;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  const rows = resp.data.values || [];
  const [header, ...data] = rows;
  if (!header) return [];
  const idx = Object.fromEntries(header.map((h, i) => [String(h).trim().toLowerCase(), i]));
  return data.map(r => ({
    code: (r[idx['code']] || '').trim(),
    name: (r[idx['name']] || '').trim(),
    price: Number((r[idx['price']] || '0').toString().trim() || 0),
    stock: (r[idx['stock']] || '').toString().trim(),
    restock_eta: (r[idx['restock_eta']] || '').toString().trim(),
    remarks: (r[idx['remarks']] || '').toString().trim(),
  }));
}

function normalizeStockText(item) {
  const s = (item.stock || '').toString().trim();
  if (s === '') return item.restock_eta ? `缺貨，預計補貨日：${item.restock_eta}` : '缺貨';
  if (/^(有|無)$/.test(s)) return s === '有' ? '有貨' : '缺貨';
  const n = Number(s);
  if (!Number.isNaN(n)) return n > 0 ? `在庫中，可出 ${n}` : '缺貨';
  return s; // 例如「調貨中」、「門市限定」
}

// ===== 模糊搜尋（容錯拼字） =====
function searchProductFuzzy(list, keyword) {
  const k = normalizeText(keyword);
  if (!k) return null;

  // 完全代碼命中
  const exact = list.find(p => p.code && p.code.toLowerCase() === k);
  if (exact) return exact;

  // 包含比對（代碼、名稱）
  let matches = list.filter(p =>
    (p.code && p.code.toLowerCase().includes(k)) ||
    (normalizeText(p.name).includes(k))
  );

  // 若沒有包含比對結果，使用相似度演算法
  if (matches.length === 0) {
    const scored = list
      .map(p => ({ item: p, score: similarity(normalizeText(p.name), k) }))
      .filter(x => x.score >= 0.45) // 放寬門檻
      .sort((a, b) => b.score - a.score);
    matches = scored.map(x => x.item);
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  return { multi: matches.slice(0, 5) };
}

// Levenshtein + 相似度
function levenshtein(a, b) {
  const an = a.length, bn = b.length;
  if (an === 0) return bn;
  if (bn === 0) return an;
  const matrix = Array.from({ length: an + 1 }, () => new Array(bn + 1).fill(0));
  for (let i = 0; i <= an; i++) matrix[i][0] = i;
  for (let j = 0; j <= bn; j++) matrix[0][j] = j;
  for (let i = 1; i <= an; i++) {
    for (let j = 1; j <= bn; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[an][bn];
}
function similarity(a, b) {
  let longer = a, shorter = b;
  if (a.length < b.length) { longer = b; shorter = a; }
  const longerLength = longer.length;
  if (longerLength === 0) return 1.0;
  const editDist = levenshtein(longer, shorter);
  return (longerLength - editDist) / parseFloat(longerLength);
}

// ===== 回覆：查價（顯示代碼） =====
async function replyPrice(token, userId, keyword) {
  const list = await fetchProducts();
  const item = searchProductFuzzy(list, keyword);
  if (!item) return replyText(token, `找不到「${keyword}」。`);
  if (item.multi) {
    const lines = item.multi.map(p => `${p.code ? p.code + '｜' : ''}${p.name}`).join('\n');
    return replyText(token, `找到多個相似品項：\n${lines}`);
  }
  setLastKeywords(userId, [{ code: item.code, name: item.name }]);
  const stockText = normalizeStockText(item);
  const codeText = item.code ? `${item.code}｜` : '';
  return replyText(token, `${codeText}${item.name}\n定價：${item.price} 元\n庫存：${stockText}`);
}

// ===== 回覆：庫存（顯示代碼） =====
async function replyStock(token, userId, keyword) {
  const list = await fetchProducts();
  const item = searchProductFuzzy(list, keyword);
  if (!item) return replyText(token, `找不到「${keyword}」。`);
  if (item.multi) {
    const lines = item.multi.map(p => `${p.code ? p.code + '｜' : ''}${p.name}`).join('\n');
    return replyText(token, `找到多個相似品項：\n${lines}`);
  }
  setLastKeywords(userId, [{ code: item.code, name: item.name }]);
  const stockText = normalizeStockText(item);
  const codeText = item.code ? `${item.code}｜` : '';
  return replyText(token, `${codeText}${item.name}\n庫存：${stockText}`);
}

// ===== 回覆：查編號（只顯示 代碼｜書名） =====
async function replyCodeOnly(token, userId, keyword) {
  const list = await fetchProducts();
  const item = searchProductFuzzy(list, keyword);
  if (!item) return replyText(token, `找不到「${keyword}」。`);
  if (item.multi) {
    const lines = item.multi.map(p => `${p.code ? p.code + '｜' : ''}${p.name}`).join('\n');
    return replyText(token, `找到多個相似品項：\n${lines}`);
  }
  setLastKeywords(userId, [{ code: item.code, name: item.name }]);
  const codeText = item.code ? `${item.code}｜` : '';
  return replyText(token, `${codeText}${item.name}`);
}

// ===== 下單 =====
async function replyOrder(token, profile, keyword, qty) {
  if (!qty || qty <= 0) return replyText(token, '數量需要是正整數。');
  const list = await fetchProducts();
  const item = searchProductFuzzy(list, keyword);
  if (!item) return replyText(token, `找不到「${keyword}」。`);
  if (item.multi) {
    const lines = item.multi.map(p => `${p.code ? p.code + '｜' : ''}${p.name}`).join('\n');
    return replyText(token, `找到多個相似品項：\n${lines}\n請輸入更明確的品名或代碼。`);
  }

  const orderId = `ORD-${dayjs().format('YYYYMMDD')}-${Math.floor(Math.random()*9000+1000)}`;
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${TAB_ORDERS}!A:I`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        dayjs().format('YYYY-MM-DD HH:mm:ss'),
        orderId,
        profile.userId || '',
        profile.displayName || '',
        item.code,
        item.name,
        qty,
        item.price,
        'NEW'
      ]]
    }
  });
  const stockText = normalizeStockText(item);
  const codeText = item.code ? `${item.code}｜` : '';
  return replyText(token, `已收到您的訂單：\n${codeText}${item.name} x ${qty}\n訂單編號：${orderId}\n${stockText}`);
}

// ===== 工具 =====
function chunkMessage(s, size = 1400) {
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

app.get('/', (req, res) => res.send('salesbot-line v3.7 running'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server running on', port));
