// server_v2.js — LINE 業務助理 Bot（多書名 + 模糊搜尋強化，保留中性語氣）
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

// Webhook
app.post('/webhook', async (req, res) => {
  const signature = req.get('x-line-signature');
  if (!validateSignature(req.rawBody, config.channelSecret, signature)) {
    return res.status(401).send('Invalid signature');
  }
  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

// Google Sheets
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

// ===== 核心事件處理 =====
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const textRaw = (event.message.text || '').trim();
  const profile = await getProfileSafe(event.source.userId);

  // 快速意圖判斷
  const isPriceIntent = /(^|\n|\s)(查價|報價|多少錢)/.test(textRaw);
  const isStockIntent = /(^|\n|\s)(庫存|有貨嗎|有沒有庫存)/.test(textRaw);
  const hasMultiLines = /\n|、|,|，|；|;/.test(textRaw);

  // 1) 下單：維持原有語法「下單 品名 x 數量」
  const orderMatch = textRaw.match(/^下單\s*(.+?)\s*[xX＊*]\s*(\d+)$/);
  if (orderMatch) {
    const [, keyword, qty] = orderMatch;
    return replyOrder(event.replyToken, profile, keyword, parseInt(qty, 10));
  }

  // 2) 價格／庫存（支援多行、多關鍵字）
  if (isPriceIntent || isStockIntent || hasMultiLines) {
    return handleMultiQuery(event.replyToken, textRaw, { both: isPriceIntent && isStockIntent });
  }

  // 3) 明確單一指令（相容舊版）：查價 XXX / 庫存 XXX
  if (/^(查價|報價)/.test(textRaw)) {
    const keyword = textRaw.replace(/^(查價|報價)/, '').trim();
    return replyPrice(event.replyToken, keyword);
  }
  if (/^庫存/.test(textRaw)) {
    const keyword = textRaw.replace(/^庫存/, '').trim();
    return replyStock(event.replyToken, keyword);
  }

  // 4) 說明
  return replyText(event.replyToken,
    '您可以輸入：\n' +
    '• 查價 商品名\n' +
    '• 庫存 商品名\n' +
    '• 下單 商品名 x 數量\n\n' +
    '也支援多行多書名輸入（逐行查詢）。'
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
  // LINE 單則訊息長度上限保守切分
  const chunks = chunkMessage(text, 1400);
  const messages = chunks.map(t => ({ type: 'text', text: t }));
  return client.replyMessage(token, messages);
}

// ===== 多書名處理 =====
function splitKeywords(text) {
  // 移除可能的意圖詞彙，留下純關鍵字區塊
  const cleaned = text
    .replace(/(^|\s)(查價|報價|多少錢)/g, ' ')
    .replace(/(^|\s)(庫存|有貨嗎|有沒有庫存)/g, ' ')
    .trim();
  const parts = cleaned
    .split(/\n|、|,|，|；|;/)
    .map(s => s.trim())
    .filter(Boolean);
  return parts;
}

async function handleMultiQuery(replyToken, textRaw, options = {}) {
  const list = await fetchProducts();
  const wantsPrice = /(^|\n|\s)(查價|報價|多少錢)/.test(textRaw);
  const wantsStock = /(^|\n|\s)(庫存|有貨嗎|有沒有庫存)/.test(textRaw);

  const keywords = splitKeywords(textRaw);
  if (keywords.length === 0) {
    return replyText(replyToken, '請輸入品名或代碼。');
  }

  const blocks = [];
  for (const kw of keywords) {
    const result = searchProductFuzzy(list, kw);
    if (!result) {
      blocks.push(`找不到「${kw}」，請確認品名或代碼。`);
      continue;
    }
    if (result.multi) {
      const lines = result.multi.map(p => `${p.code}｜${p.name}`).join('\n');
      blocks.push(`找到多個相似品項：\n${lines}\n請輸入更明確的品名或代碼。`);
      continue;
    }
    const item = result;
    const priceLine = `定價：${item.price} 元`;
    const stockLine = normalizeStockText(item);
    // B 版區塊式排版
    let block = `《${item.name}》\n`;
    if (wantsPrice || (!wantsPrice && !wantsStock)) block += `${priceLine}\n`;
    if (wantsStock || (!wantsPrice && !wantsStock)) block += `庫存：${stockLine}`;
    blocks.push(block.trim());
  }

  const joined = blocks.join('\n\n');
  return replyText(replyToken, joined);
}

// ===== 單筆查價/庫存（相容舊版呼叫） =====
async function replyPrice(token, keyword) {
  const list = await fetchProducts();
  const item = searchProductFuzzy(list, keyword);
  if (!item) return replyText(token, `找不到「${keyword}」，請確認品名或代碼。`);
  if (item.multi) {
    const names = item.multi.map(p => `${p.code}｜${p.name}`).join('\n');
    return replyText(token, `找到多個相似品項：\n${names}\n請輸入更明確的品名或代碼。`);
  }
  const stockText = normalizeStockText(item);
  return replyText(token, `《${item.name}》\n定價：${item.price} 元\n庫存：${stockText}`);
}

async function replyStock(token, keyword) {
  const list = await fetchProducts();
  const item = searchProductFuzzy(list, keyword);
  if (!item) return replyText(token, `找不到「${keyword}」，請確認品名或代碼。`);
  if (item.multi) {
    const names = item.multi.map(p => `${p.code}｜${p.name}`).join('\n');
    return replyText(token, `找到多個相似品項：\n${names}\n請輸入更明確的品名或代碼。`);
  }
  const stockText = normalizeStockText(item);
  return replyText(token, `《${item.name}》庫存：${stockText}`);
}

// ===== Google Sheets 讀寫 =====
async function fetchProducts() {
  const sheets = getSheets();
  // 允許到 F 欄：code, name, price, stock, restock_eta, remarks
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
  // 支援「有/無」「數字庫存」「缺貨 + 預計補貨日」三型
  const s = (item.stock || '').toString().trim();
  if (s === '') return item.restock_eta ? `缺貨，預計補貨日：${item.restock_eta}` : '缺貨（待確認補貨日）';
  if (/^(有|無)$/.test(s)) return s === '有' ? '有貨' : (item.restock_eta ? `缺貨，預計補貨日：${item.restock_eta}` : '缺貨');
  const n = Number(s);
  if (!Number.isNaN(n)) {
    if (n > 0) return `在庫中，可出 ${n}`;
    return item.restock_eta ? `缺貨，預計補貨日：${item.restock_eta}` : '缺貨';
  }
  return s; // 自由文字，例如「調貨中」、「門市限定」
}

// ===== 模糊搜尋 =====
function searchProductFuzzy(list, keyword) {
  const k = keyword.trim().toLowerCase();
  if (!k) return null;

  // 完全代碼命中
  const exact = list.find(p => p.code && p.code.toLowerCase() === k);
  if (exact) return exact;

  // 代碼/名稱包含
  let matches = list.filter(p =>
    (p.code && p.code.toLowerCase().includes(k)) ||
    (p.name && p.name.toLowerCase().includes(k))
  );

  // 字串相似度（Levenshtein）
  if (matches.length === 0) {
    const scored = list
      .map(p => ({
        item: p,
        score: similarity((p.name || '').toLowerCase(), k)
      }))
      .filter(x => x.score >= 0.6)
      .sort((a, b) => b.score - a.score);
    matches = scored.map(x => x.item);
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  return { multi: matches.slice(0, 5) };
}

// Levenshtein Distance + 相似度
function levenshtein(a, b) {
  const an = a ? a.length : 0;
  const bn = b ? b.length : 0;
  if (an === 0) return bn;
  if (bn === 0) return an;
  const matrix = Array.from({ length: an + 1 }, () => new Array(bn + 1).fill(0));
  for (let i = 0; i <= an; i++) matrix[i][0] = i;
  for (let j = 0; j <= bn; j++) matrix[0][j] = j;
  for (let i = 1; i <= an; i++) {
    for (let j = 1; j <= bn; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
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

// ===== 下單（沿用原有流程） =====
async function replyOrder(token, profile, keyword, qty) {
  if (!qty || qty <= 0) return replyText(token, '數量需要是正整數。');
  const list = await fetchProducts();
  const item = searchProductFuzzy(list, keyword);
  if (!item) return replyText(token, `找不到「${keyword}」，請確認品名或代碼。`);
  if (item.multi) {
    const names = item.multi.map(p => `${p.code}｜${p.name}`).join('\n');
    return replyText(token, `找到多個相似品項：\n${names}\n請輸入更明確的品名或代碼。`);
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
  return replyText(token, `已收到您的訂單：\n${item.name} x ${qty}\n訂單編號：${orderId}\n${stockText}`);
}

// ===== 工具 =====
function chunkMessage(s, size = 1400) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    out.push(s.slice(i, i + size));
    i += size;
  }
  return out;
}

app.get('/', (req, res) => res.send('salesbot-line v2 running'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server running on', port));
