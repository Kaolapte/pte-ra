const express = require("express");
const multer = require("multer");
const WebSocket = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const cors = require("cors");
const path = require("path");
const { execSync } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
const upload = multer({ dest: "uploads/" });

const CONFIG = {
  APPID: "bdce20fd",
  APIKey: "efef87a8d1ebcdb28b58b8a9923d0dc0",
  APISecret: "ZGEwYTI0YzU2MzE1MjExNmVhMzM2NjQ4",
  HOST: "ise-api.xfyun.cn",
  PATH: "/v2/open-ise",
};

function buildAuthUrl() {
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${CONFIG.HOST}\ndate: ${date}\nGET ${CONFIG.PATH} HTTP/1.1`;
  const hmac = crypto.createHmac("sha256", CONFIG.APISecret);
  hmac.update(signatureOrigin);
  const signature = hmac.digest("base64");
  const authorizationOrigin = `api_key="${CONFIG.APIKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin).toString("base64");
  return `wss://${CONFIG.HOST}${CONFIG.PATH}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${CONFIG.HOST}`;
}

function convertToPcm(inputPath) {
  const outputPath = inputPath + ".pcm";
  try {
    execSync(`ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -f s16le "${outputPath}" 2>/dev/null`);
    return outputPath;
  } catch(e) {
    return null;
  }
}

function webmToPcmFallback(inputBuffer) {
  return inputBuffer;
}

function evaluate(audioBuffer, refText, category = "read_sentence") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(buildAuthUrl());
    let resultBuffer = "";
    ws.on("open", () => {
      ws.send(JSON.stringify({
        common: { app_id: CONFIG.APPID },
        business: { category, ise_unite: "1", sub: "ise", ent: "en_vip", cmd: "ssb", auf: "audio/L16;rate=16000", aue: "raw", text: "\uFEFF" + refText, rst: "json", extra_ability: "syll,stress,multiline" },
        data: { status: 0, encoding: "raw", data_type: 1, data: "" },
      }));
      const CHUNK = 1280;
      let offset = 0;
      const sendChunk = () => {
        if (offset >= audioBuffer.length) {
          ws.send(JSON.stringify({ business: { cmd: "auw", aus: 4, aue: "raw" }, data: { status: 2, encoding: "raw", data_type: 1, data: "" } }));
          return;
        }
        const chunk = audioBuffer.slice(offset, offset + CHUNK);
        offset += CHUNK;
        ws.send(JSON.stringify({ business: { cmd: "auw", aus: offset === CHUNK ? 1 : 2, aue: "raw" }, data: { status: offset >= audioBuffer.length ? 2 : 1, encoding: "raw", data_type: 1, data: chunk.toString("base64") } }));
        setTimeout(sendChunk, 40);
      };
      sendChunk();
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (msg.code !== 0) { ws.close(); return reject(new Error(`讯飞错误 ${msg.code}: ${msg.message}`)); }
      if (msg.data?.data) resultBuffer += msg.data.data;
      if (msg.data?.status === 2) ws.close();
    });
    ws.on("close", () => {
      if (!resultBuffer) return reject(new Error("未收到评测结果"));
      try { resolve(parseResult(Buffer.from(resultBuffer, "base64").toString("utf-8"), refText)); } catch (e) { reject(e); }
    });
    ws.on("error", reject);
  });
}

function parseResult(xml, refText) {
  const find = (re) => { const m = xml.match(re); return m ? parseFloat(m[1]) : null; };
  const words = [];
  const re = /<word[^>]*content="([^"]*)"[^>]*score="([\d.]+)"[^>]*>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const score = parseFloat(m[2]);
    words.push({ word: m[1], score, color: score >= 80 ? "green" : score >= 60 ? "yellow" : "red" });
  }
  if (!words.length && refText) refText.split(/\s+/).forEach(w => words.push({ word: w, score: null, color: "gray" }));
  return { overall: find(/overall="([\d.]+)"/), fluency: find(/fluency[^>]*score="([\d.]+)"/), integrity: find(/integrity[^>]*score="([\d.]+)"/), words };
}

app.post("/api/evaluate", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "缺少音频" });
  if (!req.body.text) return res.status(400).json({ error: "缺少文本" });
  const map = { sentence: "read_sentence", chapter: "read_chapter", word: "read_word" };

  let pcmPath = null;
  let audioBuffer;

  try {
    pcmPath = convertToPcm(req.file.path);
    if (pcmPath && fs.existsSync(pcmPath)) {
      audioBuffer = fs.readFileSync(pcmPath);
    } else {
      audioBuffer = fs.readFileSync(req.file.path);
    }
    const result = await evaluate(audioBuffer, req.body.text, map[req.body.type] || "read_sentence");
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(req.file.path, () => {});
    if (pcmPath) fs.unlink(pcmPath, () => {});
  }
});

app.get("/api/health", (_, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 3000, () => console.log("✅ 服务启动: http://localhost:3000"));
