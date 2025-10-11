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

// LINE webhook
app.post('/webhook', async (req, res) => {
  const signature = req.get('x-line-signature');
  if (!validateSignature(req.rawBody, config.channelSecret, signature)) {
    return res.status(401).send('Invalid signature');
  }
  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

// Google Sheets setup
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

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const text = event.message.text.trim();
  const profile = await client.getProfile(event.source.userId);

  if (/^(查價|報價)/.test(text)) {
    const keyword = text.replace(/^(查價|報價)/, '').trim();
    return replyPrice(event.replyToken, keyword);
  }
  if (/^(庫存)/.test(text)) {
    const keyword = text.replace(/^庫存/, '').trim();
    return replyStock(event.replyToken, keyword);
  }
  const orderMatch = text.match(/^下單\s*(.+?)\s*[xX＊*]\s*(\d+)/);
  if (orderMatch) {
    const [, keyword, qty] = orderMatch;
    return replyOrder(event.replyToken, profile, keyword, parseInt(qty, 10));
  }

  return replyText(event.replyToken, '您可以輸入：\n• 查價 商品名\n• 庫存 商品名\n• 下單 商品名 x 數量');
}

async function replyText(token, text) {
  return client.replyMessage(token, { type: 'text', text });
}

async function fetchProducts() {
  const sheets = getSheets();
  const range = `${TAB_PRODUCTS}!A:D`;
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  const rows = resp.data.values || [];
  const [header, ...data] = rows;
  const idx = Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), i]));
  return data.map(r => ({
    code: r[idx['code']] || '',
    name: r[idx['name']] || '',
    price: r[idx['price']] || '',
    stock: (r[idx['stock']] || '').trim()
  }));
}

function searchProduct(list, keyword) {
  const k = keyword.toLowerCase();
  return list.find(p => p.code.toLowerCase() === k || p.name.toLowerCase().includes(k));
}

async function replyPrice(token, keyword) {
  const list = await fetchProducts();
  const item = searchProduct(list, keyword);
  if (!item) return replyText(token, `找不到「${keyword}」，請確認品名或代碼。`);
  const stockText = item.stock === '有' ? '目前有貨' : '目前缺貨';
  return replyText(token, `${item.name} 定價 ${item.price} 元，${stockText}。`);
}

async function replyStock(token, keyword) {
  const list = await fetchProducts();
  const item = searchProduct(list, keyword);
  if (!item) return replyText(token, `找不到「${keyword}」，請確認品名或代碼。`);
  const stockText = item.stock === '有' ? '有貨' : '缺貨';
  return replyText(token, `${item.name}：${stockText}`);
}

async function replyOrder(token, profile, keyword, qty) {
  const list = await fetchProducts();
  const item = searchProduct(list, keyword);
  if (!item) return replyText(token, `找不到「${keyword}」，請確認品名或代碼。`);
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
        profile.userId,
        profile.displayName,
        item.code,
        item.name,
        qty,
        item.price,
        'NEW'
      ]]
    }
  });
  const stockText = item.stock === '有' ? '有貨' : '缺貨';
  return replyText(token, `已收到您的訂單：\n${item.name} x ${qty}\n訂單編號：${orderId}\n${stockText}`);
}

app.get('/', (req, res) => res.send('salesbot-line running'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server running on', port));
