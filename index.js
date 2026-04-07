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

// MySQL Connection
const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "trading_db",
};

let db;

// إنشاء اتصال بقاعدة البيانات
async function initDatabase() {
  try {
    db = await mysql.createConnection(dbConfig);
    console.log("✅ متصل بقاعدة البيانات MySQL");

    // إنشاء الجدول إذا لم يكن موجوداً
    await db.execute(`
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
    console.log("✅ جدول Orders جاهز");
  } catch (error) {
    console.error("❌ خطأ في الاتصال بقاعدة البيانات:", error.message);
  }
}

initDatabase();

// إنشاء HTTP Server و WebSocket Server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Set();

wss.on("connection", (ws) => {
  console.log("✅ عميل جديد متصل عبر WebSocket");
  clients.add(ws);

  ws.on("close", () => {
    clients.delete(ws);
    console.log("❌ عميل انقطع عن WebSocket");
  });
});

// دالة لإرسال البيانات لجميع العملاء
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

const session = new StringSession("");

(async () => {
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("رقمك: "),
    password: async () => await input.text("الباسورد (إذا موجود): "),
    phoneCode: async () => await input.text("الكود: "),
  });

  console.log("✅ Telegram Client متصل وجاهز");

  // مراقبة كل رسالة جديدة
  client.addEventHandler(async (event) => {
    const message = event.message;

    // تأكد أنها رسالة قناة (يمكن تعديلها للقنوات فقط)
    if (message.peerId?.channelId) {
      const messageText = message.message;
      console.log("\n📩 رسالة جديدة من Telegram:");
      console.log(messageText);
      console.log("\n🔄 جاري إرسالها للـ API...");

      try {
        // إرسال الرسالة إلى الـ API المحلي
        const response = await fetch("http://localhost:3000/parse-order", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ message: messageText }),
        });

        const result = await response.json();

        console.log("\n✅ النتيجة من API:");
        console.log(JSON.stringify(result, null, 2));

        // توضيح نوع العملية
        if (result.type === "NEW") {
          console.log("📌 العملية: إضافة طلب جديد");
        } else if (result.type === "CLOSED" || result.type === "DELETE") {
          console.log("🗑️ العملية: حذف/إغلاق طلب");
        } else if (result.type && result.type.includes("DELETE")) {
          console.log("✏️ العملية: حذف جزئي");
        } else if (
          result.type &&
          (result.type.includes("Set") || result.type.includes("Moved"))
        ) {
          console.log("✏️ العملية: تعديل/تحديث");
        }

        console.log("\n" + "=".repeat(50) + "\n");
      } catch (error) {
        console.error("\n❌ خطأ في الاتصال بالـ API:", error.message);
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

// API
app.post("/parse-order", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.status(400).json({ error: "الرسالة غير موجودة" });

    // استدعاء Cerebras AI مع تعليمات محسنة ومفصلة
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
          content: `Parse this trading message and return ONLY JSON:

${message}`,
        },
      ],
      max_completion_tokens: 800,
      temperature: 0.1,
      top_p: 0.95,
      stream: false,
    });

    const rawJSON = completion.choices[0].message.content;
    const modelData = extractJSON(rawJSON);

    // تطبيق المنطق الصارم كطبقة تحقق إضافية
    const strictData = strictParse(message);

    // دمج ذكي: استخدم AI للحقول المعقدة والمنطق الصارم للتحقق
    const finalData = {};

    // استخدم AI كمصدر رئيسي مع التحقق من المنطق الصارم
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
      // إذا كان المنطق الصارم وجد قيمة واضحة، استخدمها
      if (
        strictData[key] !== null &&
        strictData[key] !== undefined &&
        strictData[key] !== "Unknown"
      ) {
        finalData[key] = strictData[key];
      }
      // وإلا استخدم نتيجة AI
      else if (modelData[key] !== null && modelData[key] !== undefined) {
        finalData[key] = modelData[key];
      }
      // وإلا null
      else {
        finalData[key] = null;
      }
    }

    // حفظ البيانات في قاعدة البيانات حسب نوع الرسالة
    if (finalData.id && db) {
      try {
        const orderType = finalData.type;

        // حالات الحذف
        if (orderType === "DELETE" || orderType === "CLOSED") {
          // حذف الطلب من قاعدة البيانات
          await db.execute(`DELETE FROM orders WHERE id = ?`, [finalData.id]);
          console.log(
            `🗑️ تم حذف Order #${finalData.id} من قاعدة البيانات (${orderType})`,
          );

          // إرسال إشعار بالحذف للعملاء
          broadcastToClients({ ...finalData, action: "delete" });
        }
        // حالات الحذف الجزئي (DELETE SL, DELETE TP, DELETE LOTS)
        else if (orderType === "DELETE SL") {
          await db.execute(`UPDATE orders SET sl = NULL WHERE id = ?`, [
            finalData.id,
          ]);
          console.log(`✏️ تم حذف SL من Order #${finalData.id}`);

          // جلب البيانات المحدثة وإرسالها
          const [rows] = await db.execute(`SELECT * FROM orders WHERE id = ?`, [
            finalData.id,
          ]);
          if (rows.length > 0) {
            broadcastToClients({ ...rows[0], action: "update" });
          }
        } else if (orderType === "DELETE TP") {
          await db.execute(`UPDATE orders SET tp = NULL WHERE id = ?`, [
            finalData.id,
          ]);
          console.log(`✏️ تم حذف TP من Order #${finalData.id}`);

          const [rows] = await db.execute(`SELECT * FROM orders WHERE id = ?`, [
            finalData.id,
          ]);
          if (rows.length > 0) {
            broadcastToClients({ ...rows[0], action: "update" });
          }
        } else if (orderType === "DELETE LOTS") {
          await db.execute(`UPDATE orders SET lots = NULL WHERE id = ?`, [
            finalData.id,
          ]);
          console.log(`✏️ تم حذف Lots من Order #${finalData.id}`);

          const [rows] = await db.execute(`SELECT * FROM orders WHERE id = ?`, [
            finalData.id,
          ]);
          if (rows.length > 0) {
            broadcastToClients({ ...rows[0], action: "update" });
          }
        }
        // حالات التعديل (Set SL, Set TP, Moved SL, Moved TP, Moved SL & TP)
        else if (orderType === "Set SL" || orderType === "Moved SL") {
          await db.execute(`UPDATE orders SET sl = ? WHERE id = ?`, [
            finalData.sl,
            finalData.id,
          ]);
          console.log(`✏️ تم تحديث SL للـ Order #${finalData.id}`);

          const [rows] = await db.execute(`SELECT * FROM orders WHERE id = ?`, [
            finalData.id,
          ]);
          if (rows.length > 0) {
            broadcastToClients({ ...rows[0], action: "update" });
          }
        } else if (orderType === "Set TP" || orderType === "Moved TP") {
          await db.execute(`UPDATE orders SET tp = ? WHERE id = ?`, [
            finalData.tp,
            finalData.id,
          ]);
          console.log(`✏️ تم تحديث TP للـ Order #${finalData.id}`);

          const [rows] = await db.execute(`SELECT * FROM orders WHERE id = ?`, [
            finalData.id,
          ]);
          if (rows.length > 0) {
            broadcastToClients({ ...rows[0], action: "update" });
          }
        } else if (orderType === "Moved SL & TP") {
          await db.execute(`UPDATE orders SET sl = ?, tp = ? WHERE id = ?`, [
            finalData.sl,
            finalData.tp,
            finalData.id,
          ]);
          console.log(`✏️ تم تحديث SL & TP للـ Order #${finalData.id}`);

          const [rows] = await db.execute(`SELECT * FROM orders WHERE id = ?`, [
            finalData.id,
          ]);
          if (rows.length > 0) {
            broadcastToClients({ ...rows[0], action: "update" });
          }
        }
        // حالة إضافة طلب جديد (NEW) أو أي نوع آخر
        else {
          await db.execute(
            `INSERT INTO orders (id, deal, type, symbol, lots, sl, tp, balance) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE 
             deal = VALUES(deal), 
             type = VALUES(type), 
             symbol = VALUES(symbol), 
             lots = VALUES(lots), 
             sl = VALUES(sl), 
             tp = VALUES(tp), 
             balance = VALUES(balance)`,
            [
              finalData.id,
              finalData.deal,
              finalData.type,
              finalData.symbol,
              finalData.lots,
              finalData.sl,
              finalData.tp,
              finalData.balance,
            ],
          );
          console.log(
            `✅ تم حفظ Order #${finalData.id} في قاعدة البيانات (${orderType || "NEW"})`,
          );

          // إرسال البيانات لجميع العملاء المتصلين عبر WebSocket
          broadcastToClients({ ...finalData, action: "add" });
        }
      } catch (dbError) {
        console.error("❌ خطأ في معالجة البيانات:", dbError.message);
      }
    }

    res.json(finalData);
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
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
