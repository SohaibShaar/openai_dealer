import express from "express";
import dotenv from "dotenv";
import cors from "cors";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

function parseOrder(message) {
  // id
  const idMatch = message.match(/#\s*(\d+)/);
  const id = idMatch ? idMatch[1] : null;

  // deal: Sell أو Buy
  let deal = "Unknown";
  if (/sell/i.test(message)) deal = "Sell";
  else if (/buy/i.test(message)) deal = "Buy";

  // type
  let type = "Unknown";
  if (/{\s*NEW\s*}/i.test(message)) type = "NEW";
  else if (/{\s*CLOSED\s*}/i.test(message)) type = "CLOSED";
  else if (/Set SL/i.test(message)) type = "Set SL";
  else if (/Set TP/i.test(message)) type = "Set TP";
  else if (/Moved SL & TP/i.test(message)) type = "Moved SL & TP";
  else if (/Moved SL/i.test(message)) type = "Moved SL";
  else if (/Moved TP/i.test(message)) type = "Moved TP";

  // symbol: عادة يأتي بعد "ORDER -" مباشرة قبل Buy/Sell
  const symbolMatch = message.match(/ORDER\s*-\s*([A-Z]{3,6})/i);
  const symbol = symbolMatch ? symbolMatch[1].toUpperCase() : null;

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

app.post("/parse-order", (req, res) => {
  const message = req.body.message;
  if (!message) return res.status(400).json({ error: "الرسالة غير موجودة" });

  const parsed = parseOrder(message);
  res.json(parsed);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
