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

// دالة المنطق الصارم لاستخراج القيم بدقة
function strictParse(message) {
  // id
  const idMatch = message.match(/#\s*(\d+)/);
  const id = idMatch ? idMatch[1] : null;

  // deal: Sell أو Buy
  let deal = "Unknown";
  if (/sell/i.test(message)) deal = "Sell";
  else if (/buy/i.test(message)) deal = "Buy";

  // type: اكتشاف جميع أنواع الأوامر (محسن)
  let type = "Unknown";

  // ✅ التعامل مع الحذف الجزئي
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

  // symbol: بعد "on" أو "ORDER -" أو قبل Buy/Sell
  let symbol = null;

  // الحالة 1: "on XAUUSD"
  const onMatch = message.match(/on\s+([A-Z]{3,10})/i);
  if (onMatch) symbol = onMatch[1].toUpperCase();
  // الحالة 2: ORDER -
  else {
    const orderMatch = message.match(/ORDER\s*-\s*([A-Z]{3,10})/i);
    if (orderMatch) symbol = orderMatch[1].toUpperCase();
    // الحالة 3: قبل Buy/Sell (fallback)
    else {
      const symbolMatch = message.match(/([A-Z]{3,10})\s+(Buy|Sell)/i);
      if (symbolMatch) symbol = symbolMatch[1].toUpperCase();
    }
  }

  // فلترة كلمات خاطئة
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

  return { id, deal, type, symbol, lots, sl, tp };
}

// استخراج JSON من نص النموذج
function extractJSON(rawText) {
  try {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return {};
  } catch {
    return {};
  }
}

// API endpoint
app.post("/parse-order", async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.status(400).json({ error: "الرسالة غير موجودة" });

    // استدعاء Cerebras للمساعدة في الحالات المعقدة
    const completion = await cerebras.chat.completions.create({
      model: "llama3.1-8b",
      messages: [
        {
          role: "system",
          content:
            "أنت مساعد يحول رسائل التداول إلى JSON فقط، بدون أي نص إضافي. الحقول: id, deal (Buy/Sell), type (NEW/CLOSED/Set SL/Set TP/Moved SL & TP), symbol, lots, sl, tp.",
        },
        {
          role: "user",
          content: `اقرأ الرسالة التالية واخرج JSON:
${message}`,
        },
      ],
      max_completion_tokens: 512,
      temperature: 0,
      top_p: 1,
      stream: false,
    });

    const rawJSON = completion.choices[0].message.content;
    const modelData = extractJSON(rawJSON);

    // تطبيق المنطق الصارم لضمان دقة 100%
    const strictData = strictParse(message);

    // دمج البيانات: المنطق الصارم له الأولوية
    const finalData = { ...modelData, ...strictData };

    res.json(finalData);
  } catch (err) {
    console.error("حدث خطأ:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
