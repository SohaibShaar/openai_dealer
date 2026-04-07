import express from "express";
import Cerebras from "@cerebras/cerebras_cloud_sdk";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const cerebras = new Cerebras({
  apiKey: process.env.CEREBRAS_API_KEY,
});

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

    res.json(finalData);
  } catch (err) {
    console.error("حدث خطأ:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
