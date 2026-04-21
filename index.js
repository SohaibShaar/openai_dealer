import express from "express";
import Cerebras from "@cerebras/cerebras_cloud_sdk";
import cors from "cors";
import dotenv from "dotenv";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import input from "input";
import mysql from "mysql2/promise";
import { WebSocketServer } from "ws";
import http from "http";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const cerebras = new Cerebras({
  apiKey: process.env.CEREBRAS_API_KEY,
});

// MySQL Connection Pool
const dbConfig = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD ?? "",
  database: process.env.DB_NAME || "trading_db",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

let db;

async function initDatabase() {
  try {
    const pool = mysql.createPool(dbConfig);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(50) PRIMARY KEY,
        deal VARCHAR(10),
        type VARCHAR(50),
        symbol VARCHAR(20),
        lots DECIMAL(10, 2),
        sl DECIMAL(10, 2),
        tp DECIMAL(10, 2),
        balance DECIMAL(15, 2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db = pool;
    console.log(" متصل بقاعدة البيانات ");
    console.log(" الجدول جاهز");
  } catch (error) {
    db = null;
    console.error(" خطأ في الاتصال بقاعدة البيانات:", error.message);
  }
}

initDatabase();

//  HTTP Server / WebSocket Server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Set();

wss.on("connection", (ws) => {
  console.log(" عميل جديد متصل عبر WebSocket");
  clients.add(ws);

  ws.on("close", () => {
    clients.delete(ws);
    console.log(" عميل انقطع عن WebSocket");
  });
});

//  إرسال البيانات لجميع العملاء
function broadcastToClients(data) {
  const message = JSON.stringify(data);
  clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

// استخدام session محفوظة إن وجدت
const session = new StringSession(process.env.TELEGRAM_SESSION || "");

(async () => {
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("رقمك: "),
    password: async () => await input.text("الباسورد (إذا موجود): "),
    phoneCode: async () => await input.text("الكود: "),
    onError: (err) => console.error(" خطأ Telegram Auth:", err),
  });

  // حفظ الـ session لتجنب تسجيل الدخول في كل مرة
  const savedSession = client.session.save();
  if (!process.env.TELEGRAM_SESSION) {
    console.log("\n  paste in .env:");
    console.log(`TELEGRAM_SESSION=${savedSession}\n`);
  }

  console.log(" Telegram Client متصل ");

  // مراقبة كل رسالة جديدة
  client.addEventHandler(async (event) => {
    const message = event.message;

    if (message.peerId?.channelId) {
      const messageText = message.message;
      console.log("\n رسالة جديدة من Telegram:\n" + messageText);

      try {
        // استدعاء مباشر بدون HTTP round-trip
        const result = await parseOrder(messageText);

        console.log("\n النتيجة:\n" + JSON.stringify(result, null, 2));

        if (result.type === "NEW") console.log(" إضافة طلب جديد");
        else if (result.type === "CLOSED" || result.type === "DELETE")
          console.log(" حذف/إغلاق طلب");
        else if (result.type?.includes("DELETE")) console.log(" حذف جزئي");
        else if (result.type?.includes("Set") || result.type?.includes("Moved"))
          console.log(" تعديل/تحديث");

        console.log("\n" + "=".repeat(50) + "\n");

        // DB في الخلفية بدون انتظار
        if (result.id && db) {
          processOrderInDB(result).catch((err) =>
            console.error(" خطأ في DB:", err.message),
          );
        }
      } catch (error) {
        console.error("\n خطأ:", error.message);
      }
    }
  }, new NewMessage({}));
})();

function strictParse(message) {
  // id
  const idMatch = message.match(/#\s*(\d+)/);
  const id = idMatch ? idMatch[1] : null;

  // deal
  let deal = "Unknown";
  if (/sell/i.test(message)) deal = "Sell";
  else if (/buy/i.test(message)) deal = "Buy";

  // type
  let type = "Unknown";

  //delete
  if (/deleted sl/i.test(message)) type = "DELETE SL";
  else if (/deleted tp/i.test(message)) type = "DELETE TP";
  else if (/deleted lot/i.test(message)) type = "DELETE LOTS";
  else if (/deleted/i.test(message)) type = "DELETE";
  else if (/{\s*NEW\s*}/i.test(message)) type = "NEW";
  else if (/{\s*CLOSED\s*}/i.test(message)) type = "CLOSED";
  else if (/Set SL/i.test(message)) type = "Set SL";
  else if (/Set TP/i.test(message)) type = "Set TP";
  else if (/Moved SL & TP/i.test(message)) type = "Moved SL & TP";
  else if (/Moved SL/i.test(message)) type = "Moved SL";
  else if (/Moved TP/i.test(message)) type = "Moved TP";

  // symbol
  let symbol = null;

  //  "on XAUUSD"
  const onMatch = message.match(/on\s+([A-Z]{3,10})/i);
  if (onMatch) symbol = onMatch[1].toUpperCase();
  // ORDER -
  else {
    const orderMatch = message.match(/ORDER\s*-\s*([A-Z]{3,10})/i);
    if (orderMatch) symbol = orderMatch[1].toUpperCase();
    // before Buy/Sell (fallback)
    else {
      const symbolMatch = message.match(/([A-Z]{3,10})\s+(Buy|Sell)/i);
      if (symbolMatch) symbol = symbolMatch[1].toUpperCase();
    }
  }

  // filter incorrect words
  const invalidWords = ["NEW", "CLOSED", "DELETED", "LIMIT"];
  if (symbol && invalidWords.includes(symbol)) symbol = null;

  // lots
  const lotsMatch = message.match(/Lots:\s*([\d.]+)/i);
  const lots = lotsMatch ? parseFloat(lotsMatch[1]) : null;

  // SL
  const slMatch = message.match(/SL:\s*([\d.]+)/i);
  const sl = slMatch ? parseFloat(slMatch[1]) : null;

  // TP
  const tpMatch = message.match(/TP:\s*([\d.]+)/i);
  const tp = tpMatch ? parseFloat(tpMatch[1]) : null;

  // Balance
  const balanceMatch = message.match(/💰\s*Balance:\s*([\d\s,]+)/);
  const balance = balanceMatch
    ? parseFloat(balanceMatch[1].replace(/[\s,]/g, ""))
    : null;

  return { id, deal, type, symbol, lots, sl, tp, balance };
}

// extract JSON
function extractJSON(rawText) {
  try {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return {};
  } catch {
    return {};
  }
}

// دالة المعالجة المشتركة بين API و Telegram
async function parseOrder(message) {
  let modelData = {};

  try {
    const completion = await cerebras.chat.completions.create({
      model: "llama3.1-8b",
      messages: [
        {
          role: "system",
          content: `You are an expert trading message parser. Extract information from trading messages and return ONLY valid JSON, no additional text.

Required fields:
- id: Order number (from #123 format)
- deal: "Buy" or "Sell" (detect from context)
- type: One of: "NEW", "CLOSED", "DELETE", "DELETE SL", "DELETE TP", "DELETE LOTS", "Set SL", "Set TP", "Moved SL", "Moved TP", "Moved SL & TP"
- symbol: Trading pair (e.g., XAUUSD, EURUSD) - extract from "on SYMBOL" or "ORDER - SYMBOL" or before Buy/Sell
- lots: Numeric value from "Lots: X.XX"
- sl: Stop Loss price from "SL: X.XX"
- tp: Take Profit price from "TP: X.XX"
- balance: Account balance from "💰 Balance: X,XXX" (remove commas)

Rules:
1. Analyze the entire message context carefully
2. Handle complex, unclear, or non-standard message formats
3. Infer missing information from context when possible
4. For symbol: ignore invalid words like NEW, CLOSED, DELETED, LIMIT
5. Return null for fields that cannot be determined
6. Always return valid JSON format

Examples:
Message: "{ NEW } Order #123 Buy on XAUUSD Lots: 0.50 SL: 2650.00 TP: 2680.00"
Output: {"id":"123","deal":"Buy","type":"NEW","symbol":"XAUUSD","lots":0.50,"sl":2650.00,"tp":2680.00,"balance":null}

Message: "Moved SL & TP #456 EURUSD Sell"
Output: {"id":"456","deal":"Sell","type":"Moved SL & TP","symbol":"EURUSD","lots":null,"sl":null,"tp":null,"balance":null}`,
        },
        {
          role: "user",
          content: `Parse this trading message and return ONLY JSON:\n\n${message}`,
        },
      ],
      max_completion_tokens: 800,
      temperature: 0.1,
      top_p: 0.95,
      stream: false,
    });

    modelData = extractJSON(completion.choices[0].message.content);
  } catch (aiErr) {
    console.warn(
      ` Cerebras غير متاح (${aiErr.message?.slice(0, 60)}) — fallback لـ strictParse`,
    );
  }

  const strictData = strictParse(message);
  const finalData = {};

  for (const key of [
    "id",
    "deal",
    "type",
    "symbol",
    "lots",
    "sl",
    "tp",
    "balance",
  ]) {
    if (
      strictData[key] !== null &&
      strictData[key] !== undefined &&
      strictData[key] !== "Unknown"
    ) {
      finalData[key] = strictData[key];
    } else if (modelData[key] !== null && modelData[key] !== undefined) {
      finalData[key] = modelData[key];
    } else {
      finalData[key] = null;
    }
  }

  return finalData;
}

// دالة DB في الخلفية — لا تُنتظر من الـ API
async function processOrderInDB(finalData) {
  const { id, type: orderType } = finalData;

  if (orderType === "DELETE" || orderType === "CLOSED") {
    const [r] = await db.execute(`DELETE FROM orders WHERE id = ?`, [id]);
    if (r.affectedRows === 0)
      return console.warn(` DELETE: Order #${id} غير موجود`);
    console.log(` حذف Order #${id} (${orderType})`);
    broadcastToClients({ ...finalData, action: "delete" });
  } else if (orderType === "DELETE SL") {
    const [r] = await db.execute(`UPDATE orders SET sl = NULL WHERE id = ?`, [
      id,
    ]);
    if (r.affectedRows === 0)
      return console.warn(` DELETE SL: Order #${id} غير موجود`);
    console.log(` حذف SL من Order #${id}`);
    broadcastToClients({ id, sl: null, action: "update" });
  } else if (orderType === "DELETE TP") {
    const [r] = await db.execute(`UPDATE orders SET tp = NULL WHERE id = ?`, [
      id,
    ]);
    if (r.affectedRows === 0)
      return console.warn(`⚠️ DELETE TP: Order #${id} غير موجود`);
    console.log(` حذف TP من Order #${id}`);
    broadcastToClients({ id, tp: null, action: "update" });
  } else if (orderType === "DELETE LOTS") {
    const [r] = await db.execute(`UPDATE orders SET lots = NULL WHERE id = ?`, [
      id,
    ]);
    if (r.affectedRows === 0)
      return console.warn(`⚠️ DELETE LOTS: Order #${id} غير موجود`);
    console.log(` حذف Lots من Order #${id}`);
    broadcastToClients({ id, lots: null, action: "update" });
  } else {
    // لجميع الحالات الأخرى (NEW, Set SL, Set TP, Moved SL, Moved TP, Moved SL & TP, ...)
    // تحقق إذا الـ id موجود مسبقاً
    const [[existing]] = await db.execute(
      `SELECT id FROM orders WHERE id = ?`,
      [id],
    );

    if (!existing) {
      // سجل جديد — INSERT كامل
      await db.execute(
        `INSERT INTO orders (id, deal, type, symbol, lots, sl, tp, balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          finalData.deal,
          finalData.type,
          finalData.symbol,
          finalData.lots,
          finalData.sl,
          finalData.tp,
          finalData.balance,
        ],
      );
      console.log(` إضافة Order #${id} (${orderType})`);
      broadcastToClients({ ...finalData, action: "add" });
    } else {
      // سجل موجود — UPDATE للحقول غير الـ null فقط
      const changed = Object.fromEntries(
        Object.entries({
          deal: finalData.deal,
          type: finalData.type,
          symbol: finalData.symbol,
          lots: finalData.lots,
          sl: finalData.sl,
          tp: finalData.tp,
          balance: finalData.balance,
        }).filter(([, v]) => v !== null && v !== undefined),
      );

      if (Object.keys(changed).length === 0)
        return console.warn(` Order #${id} — لا يوجد تغيير فعلي`);

      const setClause = Object.keys(changed)
        .map((k) => `${k} = ?`)
        .join(", ");
      await db.execute(`UPDATE orders SET ${setClause} WHERE id = ?`, [
        ...Object.values(changed),
        id,
      ]);
      console.log(
        ` تحديث Order #${id} — الحقول: ${Object.keys(changed).join(", ")}`,
      );
      broadcastToClients({ id, ...changed, action: "update" });
    }
  }
}

// API
app.post("/parse-order", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.status(400).json({ error: "الرسالة غير موجودة" });

    const finalData = await parseOrder(message);

    // رد فوري قبل DB
    res.json(finalData);

    // DB في الخلفية بدون انتظار
    if (finalData.id && db) {
      processOrderInDB(finalData).catch((err) =>
        console.error(" خطأ في DB:", err.message),
      );
    }
  } catch (err) {
    console.error("حدث خطأ:", err);
    res.status(500).json({ error: err.message });
  }
});

// API للحصول على جميع الطلبات
app.get("/orders", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: "Database not connected" });
    }
    const [rows] = await db.execute(
      "SELECT * FROM orders ORDER BY created_at DESC",
    );
    res.json(rows);
  } catch (error) {
    console.error("خطأ في جلب البيانات:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(` Server running on port http://localhost:${PORT}`),
);
