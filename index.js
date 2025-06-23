import fs from 'fs';
import https from 'https';
import express from 'express';
import path from 'path';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEYS_PATH = path.join(__dirname, 'keys.json');
const LOG_PATH = path.join(__dirname, 'access.log');
const DB_PATH = path.join(__dirname, 'usage.sqlite');
const CONFIG_PATH = path.join(__dirname, 'config.json');

const OPENAI_HOST = 'api.openai.com';
let OPENAI_API_KEY = 'sk-...';

try {
  const configRaw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(configRaw);
  if (config.OPENAI_API_KEY) {
    OPENAI_API_KEY = config.OPENAI_API_KEY;
  }
} catch (err) {
  console.warn('⚠️ Could not load config.json or OPENAI_API_KEY not set. Using default or environment variable.');
  OPENAI_API_KEY = process.env.OPENAI_API_KEY || OPENAI_API_KEY;
}

let VALID_KEYS = new Map();

// 🗃️ Initialize SQLite database
const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key TEXT,
    date TEXT,
    model TEXT,
    endpoint TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER
  )`);
});

function logToDB(apiKey, model, endpoint, prompt, completion) {
  // Only log if model is a non-empty string and at least one token is nonzero
  if (!model || model === 'unknown') return;
  if ((prompt === 0 && completion === 0)) return;
  const date = new Date().toISOString().split('T')[0];
  const total = prompt + completion;
  db.run(
    `INSERT INTO usage_log (api_key, date, model, endpoint, prompt_tokens, completion_tokens, total_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [apiKey, date, model, endpoint, prompt, completion, total]
  );
}

function loadKeys() {
  try {
    const raw = fs.readFileSync(KEYS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    VALID_KEYS = new Map(parsed.map(k => [k.key, { name: k.name, email: k.email }]));
    console.log(`🔑 Loaded ${VALID_KEYS.size} API key(s)`);
  } catch (err) {
    console.error('❌ Failed to load keys.json:', err.message);
    VALID_KEYS = new Map();
  }
}
loadKeys();
fs.watchFile(KEYS_PATH, { interval: 1000 }, () => {
  console.log('🔄 Reloading keys.json...');
  loadKeys();
});

const app = express();
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Api-Key, User-Agent');
    return res.status(204).end();
  }
  next();
});

app.use((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const userKey = req.headers['api-key'];
  const user = VALID_KEYS.get(userKey);
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const timestamp = new Date().toISOString();

  console.log(`[DEBUG] Incoming request: ${req.method} ${req.url} from ${ip}`);
  console.log(`[DEBUG] Headers:`, req.headers);

  if (!user) {
    const line = `[${timestamp}] ❌ Invalid or missing API key from ${ip} → ${req.method} ${req.url}`;
    console.warn(line);
    fs.writeFileSync(LOG_PATH, line + '\n', { flag: 'a' });
    return res.status(403).json({ error: 'Invalid or missing API key' });
  }

  // Utility: Redact base64 image data in request body for logging, but log a short prefix for traceability
  function redactBase64Images(obj) {
    if (Array.isArray(obj)) {
      return obj.map(redactBase64Images);
    } else if (obj && typeof obj === 'object') {
      const redacted = {};
      for (const [key, value] of Object.entries(obj)) {
        // Common fields for image data
        if (
          (key === 'image' || key === 'data' || key === 'content' || key === 'image_data') &&
          typeof value === 'string' &&
          value.length > 100 &&
          /^(data:image\/(png|jpeg|jpg|webp);base64,|[A-Za-z0-9+/=]{100,})/.test(value)
        ) {
          // Log only the first 32 base64 chars for traceability
          const prefix = value.slice(0, 32);
          redacted[key] = `[BASE64_IMAGE_REDACTED: prefix=${prefix}...]`;
        } else {
          redacted[key] = redactBase64Images(value);
        }
      }
      return redacted;
    }
    return obj;
  }

  // Use body parsed by express.json()
  const bodyString = JSON.stringify(req.body || {});
  // Redact base64 image data for logging
  const redactedBody = redactBase64Images(req.body || {});
  const redactedBodyString = JSON.stringify(redactedBody);

  // Serialize request body for proxying
  const bodyBuffer = Buffer.from(bodyString);

  // Only print a short preview of the redacted body to the console for debugging
  const debugPreview = redactedBodyString.slice(0, 512);
  console.log(`[DEBUG] Request body (redacted, preview):`, debugPreview + (redactedBodyString.length > 512 ? ' ...[truncated]' : ''));

  // Only log the full redacted body to the file, not to the console
  const logLine = `[${timestamp}] ✅ ${user.name} <${user.email}> from ${ip} → ${req.method} ${req.url} | body: ${redactedBodyString}`;
  fs.writeFileSync(LOG_PATH, logLine + '\n', { flag: 'a' });

  console.log(`[DEBUG] Forwarding request to OpenAI: https://${OPENAI_HOST}${req.url}`);
  const proxyReq = https.request({
    hostname: OPENAI_HOST,
    path: req.url,
    method: req.method,
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyBuffer)
    },
    timeout: 15000, // 15 seconds
    family: 4 // Force IPv4
  }, proxyRes => {
    const responseChunks = [];
    console.log(`[DEBUG] OpenAI responded with status: ${proxyRes.statusCode}`);
    proxyRes.on('data', chunk => {
      responseChunks.push(chunk);
      console.log(`[DEBUG] Received data chunk from OpenAI (${chunk.length} bytes)`);
    });
    proxyRes.on('end', () => {
      const raw = Buffer.concat(responseChunks).toString();
      console.log(`[DEBUG] Full response from OpenAI:`, raw);
      try {
        const json = JSON.parse(raw);
        const usage = json.usage || {};
        const model = json.model || 'unknown';
        const prompt = usage.prompt_tokens || 0;
        const completion = usage.completion_tokens || 0;
        const total = prompt + completion;

        const usageLine = `[${timestamp}] 📊 ${user.name} used ${total} tokens (${prompt}+${completion}) on ${model}`;
        console.log(usageLine);
        fs.writeFileSync(LOG_PATH, usageLine + '\n', { flag: 'a' });

        logToDB(userKey, model, req.url, prompt, completion);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(raw);
      } catch (err) {
        console.error('⚠️ Failed to parse OpenAI response:', err.message);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(raw);
      }
    });
  });

  proxyReq.on('timeout', () => {
    console.error('⏰ OpenAI request timed out after 15 seconds');
    proxyReq.destroy();
    res.statusCode = 504;
    res.end('OpenAI request timed out');
  });

  proxyReq.on('error', err => {
    console.error('💥 Proxy error:', err.message);
    res.statusCode = 502;
    res.end('Bad Gateway');
  });

  proxyReq.write(bodyBuffer);
  proxyReq.end();
});

app.listen(8080, () => {
  console.log('🚀 OpenAI proxy with SQLite logging on http://localhost:8080');
});