// server_v3.js — 最終穩定版
// ✅ 支援查編號多行、多筆輸入（含 LINE 特殊換行符）
// ✅ 找到顯示代碼與書名，找不到略過
// ✅ 保留查價、庫存功能

import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import dotenv from "dotenv";
import { google } from "googleapis";
dotenv.config();

const app = express();
app.use(express.json());

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new Client(config);

// Google Sheets 設定
const sheets = google.sheets("v4");
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheetId = process.env.GOOGLE_SHEETS_ID;
const tabProducts = process.env.SHEET_TAB_PRODUCTS || "products";

// 抓取商品資料
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

// 模糊搜尋
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

// 回傳文字
function replyText(token, text) {
  return client.replyMessage(token, { type: "text", text });
}

// 查價
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

// 查庫存
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

// 查編號 — 最穩定版
async function replyCodeOnly(token, keyword) {
  const list = await fetchProducts();
  // 統一所有換行符為 \n，再切割
  const cleaned = keyword.replace(/[\r\u2028\u2029\u3000]+/g, "\n");
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

// 處理事件
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const textRaw = (event.message.text ?? "").trim();

  // ✅ 支援查編號多行輸入
  if (textRaw.startsWith("查編號")) {
    const keyword = textRaw
      .replace(/^查編號/, "")
      .replace(/^[\s\r\n]+/, "") // 去除開頭多餘空白與換行
      .replace(/[
  　]+/g, "\n")
      .trim();
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
}

// Webhook
app.post("/webhook", middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).then(() => res.end());
});

// 啟動伺服器
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Server running on ${port}`));
