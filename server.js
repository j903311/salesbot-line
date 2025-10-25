// server.js — 上誼 SalesBot：查價 / 庫存 / 查編號（無下單版）
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import dotenv from "dotenv";
import { google } from "googleapis";
dotenv.config();

const app = express();
app.use(express.json());

// LINE Bot 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new Client(config);

// Google Sheets API 設定
const sheets = google.sheets("v4");
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheetId = process.env.GOOGLE_SHEETS_ID;
const tabProducts = process.env.SHEET_TAB_PRODUCTS || "products";

// 說明訊息
const helpMessage = `
嗨～這是上誼 SalesBot，您可以快速查詢商品資料：

🔍 查價 商品名稱 → 查詢商品定價與庫存
📦 庫存 商品名稱 → 查詢目前庫存數量
🆔 查編號 商品名稱 → 查詢商品代碼

小提醒：
• 可同時輸入多行或多書名（系統會逐行查詢）
• 支援模糊搜尋，不需完整輸入書名
• 目前暫不開放下單功能
`;

// ===== Google Sheets 讀取 =====
async function fetchProducts() {
  const authClient = await auth.getClient();
  const res = await sheets.spreadsheets.values.get({
    auth: authClient,
    spreadsheetId: sheetId,
    range: `${tabProducts}!A:D`,
  });
  const rows = res.data.values;
  if (!rows || rows.length < 2) return [];
  const [header, ...data] = rows;
  const idx = {
    code: header.indexOf("code"),
    name: header.indexOf("name"),
    price: header.indexOf("price"),
    stock: header.indexOf("stock"),
  };
  return data.map(r => ({
    code: (r[idx.code] ?? "").trim(),
    name: (r[idx.name] ?? "").trim(),
    price: (r[idx.price] ?? "").trim(),
    stock: (r[idx.stock] ?? "").trim(),
  }));
}

// ===== 模糊搜尋 =====
function searchProductFuzzy(list, keyword) {
  if (!keyword) return null;
  const normalized = keyword.replace(/\s+/g, "").toLowerCase();
  let exact = list.find(p => (p.name || "").replace(/\s+/g, "").toLowerCase() === normalized);
  if (exact) return exact;
  const partial = list.filter(p => (p.name || "").toLowerCase().includes(normalized));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) return { multi: partial };
  return null;
}

// ===== LINE 回覆 =====
function replyText(token, text) {
  return client.replyMessage(token, { type: "text", text });
}

// ===== 查編號 =====
async function replyCodeOnly(token, keyword) {
  const list = await fetchProducts();
  const cleaned = keyword.replace(/[\r\u2028\u2029\u3000\uFEFF]+/g, "\n");
  const keywords = cleaned.split(/[\n\s,，、;；]+/).filter(Boolean);
  const results = [];
  for (const k of keywords) {
    const item = searchProductFuzzy(list, k);
    if (!item) continue;
    if (item.multi) {
      const first = item.multi[0];
      results.push(`${first.code} ${first.name}`);
    } else {
      results.push(`${item.code} ${item.name}`);
    }
  }
  if (results.length === 0) return replyText(token, "找不到符合的品項。");
  return replyText(token, results.join("\n"));
}

// ===== 查價 =====
async function replyPrice(token, keyword) {
  const list = await fetchProducts();
  const item = searchProductFuzzy(list, keyword);
  if (!item) return replyText(token, `找不到「${keyword}」。`);
  if (item.multi) {
    const lines = item.multi.map(p => `${p.code} ${p.name}`).join("\n");
    return replyText(token, `找到多個相似品項：\n${lines}`);
  }
  return replyText(token, `${item.code} ${item.name}\n定價：${item.price} 元\n庫存：${item.stock}`);
}

// ===== 查庫存 =====
async function replyStock(token, keyword) {
  const list = await fetchProducts();
  const item = searchProductFuzzy(list, keyword);
  if (!item) return replyText(token, `找不到「${keyword}」。`);
  if (item.multi) {
    const lines = item.multi.map(p => `${p.code} ${p.name}`).join("\n");
    return replyText(token, `找到多個相似品項：\n${lines}`);
  }
  return replyText(token, `${item.code} ${item.name}\n庫存：${item.stock}`);
}

// ===== 主事件處理 =====
async function handleEvent(event) {
  if (event.type === "follow") {
    return client.replyMessage(event.replyToken, { type: "text", text: helpMessage });
  }

  if (event.type !== "message" || event.message.type !== "text") return;
  const textRaw = (event.message.text ?? "").trim();

  if (textRaw === "說明" || /^help$/i.test(textRaw)) {
    return replyText(event.replyToken, helpMessage);
  }

  if (textRaw.startsWith("查編號")) {
    const keyword = textRaw.replace(/^查編號/, "").trim();
    return replyCodeOnly(event.replyToken, keyword);
  }

  if (/^(查價|報價)/.test(textRaw)) {
    const keyword = textRaw.replace(/^(查價|報價)/, "").trim();
    return replyPrice(event.replyToken, keyword);
  }

  if (/^庫存/.test(textRaw)) {
    const keyword = textRaw.replace(/^庫存/, "").trim();
    return replyStock(event.replyToken, keyword);
  }

  return replyText(event.replyToken, helpMessage);
}

// webhook 接收事件
app.post("/webhook", middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).then(() => res.end());
});

// 健康檢查
app.get("/", (req, res) => res.send("SalesBot running"));

// 啟動伺服器
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
