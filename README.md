# salesbot-line

📘 LINE 業務助理 Bot（中文版本）  
支援三項功能：查價、查庫存、下訂單。  
透過 Google Sheets 管理商品與訂單資料。

---

## 功能說明

- **查價**：輸入「查價 農夫月曆」→ 回覆定價與有無庫存。  
- **查庫存**：輸入「庫存 小金魚逃走了」→ 顯示「有貨」或「缺貨」。  
- **下單**：輸入「下單 農夫月曆 x 10」→ 自動記錄到 Google Sheets。

---

## 部署步驟

1️⃣ 建立 Google 試算表  
- 建兩個分頁：`products` 與 `orders`
- 欄位如下：

### products
| code | name | price | stock |
|------|------|------|------|
| A123 | 小金魚逃走了收納包 | 199 | 有 |
| B456 | 農夫月曆 | 420 | 有 |
| C789 | 愛思考的青蛙4 | 380 | 缺 |

### orders
| created_at | order_id | user_id | display_name | code | name | qty | unit_price | status |

---

2️⃣ 建立 Service Account 並啟用 Google Sheets API  
- 建立 JSON 憑證並設定共享給該帳號（編輯權限）

---

3️⃣ 部署到 Railway  
- 上傳此專案到 GitHub  
- 在 Railway 專案的 **Variables** 加入：  
  - CHANNEL_SECRET  
  - CHANNEL_ACCESS_TOKEN  
  - GOOGLE_SHEETS_ID  
  - GOOGLE_CREDENTIALS_JSON  
  - SHEET_TAB_PRODUCTS=products  
  - SHEET_TAB_ORDERS=orders  

---

4️⃣ 啟用 LINE Webhook  
- LINE Developers → Messaging API → Webhook URL  
  設為 Railway 給你的網址 + `/webhook`  
  例如：`https://salesbot-line-production.up.railway.app/webhook`

---

5️⃣ 測試範例  
- `查價 農夫月曆`  
- `庫存 小金魚逃走了`  
- `下單 愛思考的青蛙4 x 10`

---

© 2025 salesbot-line — Made for 舜子
