import fs from 'fs';
import https from 'https';
import express from 'express';
import path from 'path';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import multer from 'multer';

// --- Path setup and config file locations ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KEYS_PATH = path.join(__dirname, 'keys.json');
const LOG_PATH = path.join(__dirname, 'access.log');
const DB_PATH = path.join(__dirname, 'usage.sqlite');
const CONFIG_PATH = path.join(__dirname, 'config.json');

// --- Ensure keys.json exists with example users ---
if (!fs.existsSync(KEYS_PATH)) {
  fs.writeFileSync(KEYS_PATH, JSON.stringify([
    { key: "user-api-key-1", name: "Alice", email: "alice@example.com" },
    { key: "user-api-key-2", name: "Bob", email: "bob@example.com" }
  ], null, 2));
  console.log('✅ Created default keys.json');
}

// --- Load OpenAI API key from config or env ---
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

// --- Initialize SQLite DB for usage logging ---
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

// --- Log usage to DB if model and tokens are valid ---
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

// --- Load API keys from keys.json into memory ---
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
// --- Hot-reload keys.json on change ---
fs.watchFile(KEYS_PATH, { interval: 1000 }, () => {
  console.log('🔄 Reloading keys.json...');
  loadKeys();
});

const app = express();
app.use(express.json({ limit: '50mb' })); // Large payloads for images

// Add multer for handling multipart/form-data with temporary disk storage
const upload = multer({ 
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const tempDir = path.join(__dirname, 'temp-uploads');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      cb(null, tempDir);
    },
    filename: (req, file, cb) => {
      // Create unique filename with timestamp and random string
      const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(2)}-${file.originalname}`;
      cb(null, uniqueName);
    }
  }),
  limits: { 
    fileSize: 50 * 1024 * 1024, // 50MB per file
    files: 5 // Max 5 files per request
  },
  fileFilter: (req, file, cb) => {
    // Only allow audio files for audio endpoints
    if (req.url.includes('/audio/')) {
      const allowedMimes = [
        'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/m4a', 
        'audio/flac', 'audio/ogg', 'audio/webm'
      ];
      if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`Unsupported audio format: ${file.mimetype}`));
      }
    } else {
      cb(null, true);
    }
  }
});

// --- CORS and preflight handling ---
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Api-Key, User-Agent');
    return res.status(204).end();
  }
  next();
});

// --- Main proxy handler ---
app.use((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Robustly extract API key from headers (case-insensitive, trim, support common variants)
  function getApiKeyFromHeaders(headers) {
    // Try common header names, case-insensitive
    const possibleNames = ['api-key', 'x-api-key', 'apikey', 'authorization'];
    for (const name of possibleNames) {
      if (headers[name]) return headers[name].trim();
      // Try all-lowercase
      if (headers[name.toLowerCase()]) return headers[name.toLowerCase()].trim();
      // Try all-uppercase
      if (headers[name.toUpperCase()]) return headers[name.toUpperCase()].trim();
      // Try capitalized
      const cap = name.charAt(0).toUpperCase() + name.slice(1);
      if (headers[cap]) return headers[cap].trim();
    }
    return '';
  }

  const userKey = getApiKeyFromHeaders(req.headers);
  console.log('[DEBUG] Received API key:', userKey);
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

  // Handle multipart/form-data for audio endpoints
  const isMultipartEndpoint = req.url.includes('/audio/') && 
    req.headers['content-type']?.startsWith('multipart/form-data');

  if (isMultipartEndpoint) {
    // Check rate limit for uploads
    if (!checkUploadRateLimit(userKey)) {
      const line = `[${timestamp}] ⚠️ Rate limit exceeded for ${user.name} from ${ip} → ${req.method} ${req.url}`;
      console.warn(line);
      fs.writeFileSync(LOG_PATH, line + '\n', { flag: 'a' });
      return res.status(429).json({ error: 'Too many concurrent uploads. Please wait and try again.' });
    }
    
    // Use multer to parse multipart data
    upload.any()(req, res, (err) => {
      // Always release the upload slot
      releaseUploadSlot(userKey);
      
      if (err) {
        console.error('Multer error:', err);
        return res.status(400).json({ error: `Failed to parse multipart data: ${err.message}` });
      }
      handleMultipartRequest(req, res, user, userKey, timestamp, ip);
    });
  } else {
    handleJsonRequest(req, res, user, userKey, timestamp, ip);
  }

});

function handleJsonRequest(req, res, user, userKey, timestamp, ip) {
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
  console.log(`[DEBUG] Request size: ${Buffer.byteLength(bodyBuffer)} bytes`);
  
  const startTime = Date.now();
  const proxyReq = https.request({
    hostname: OPENAI_HOST,
    path: req.url,
    method: req.method,
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyBuffer)
    },
    timeout: 120000, // 2 minutes for complex requests
    family: 4 // Force IPv4
  }, proxyRes => {
    const responseChunks = [];
    console.log(`[DEBUG] OpenAI responded with status: ${proxyRes.statusCode}`);
    proxyRes.on('data', chunk => {
      responseChunks.push(chunk);
      console.log(`[DEBUG] Received data chunk from OpenAI (${chunk.length} bytes)`);
    });
    proxyRes.on('end', () => {
      const buffer = Buffer.concat(responseChunks);
      const responseTime = Date.now() - startTime;
      console.log(`[DEBUG] Request completed in ${responseTime}ms`);
      
      const contentType = proxyRes.headers['content-type'] || '';
      if (contentType.startsWith('application/json') || contentType.startsWith('text/')) {
        // Handle as text/JSON
        const raw = buffer.toString();
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
        } catch (err) {
          console.error('⚠️ Failed to parse OpenAI response:', err.message);
        }
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(raw);
      } else {
        // Binary data: forward as-is
        console.log(`[DEBUG] Binary response from OpenAI, content-type: ${contentType}, length: ${buffer.length}`);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(buffer);
      }
    });
  });

  proxyReq.on('timeout', () => {
    console.error('⏰ OpenAI request timed out after 2 minutes');
    proxyReq.destroy();
    if (!res.headersSent) {
      res.statusCode = 504;
      res.end('OpenAI request timed out');
    }
  });

  proxyReq.on('socket', (socket) => {
    console.log(`[DEBUG] Socket assigned, connecting to ${OPENAI_HOST}`);
    socket.on('connect', () => {
      console.log(`[DEBUG] Socket connected to ${OPENAI_HOST}`);
    });
    socket.on('timeout', () => {
      console.error('⏰ Socket timeout');
    });
  });

  proxyReq.on('error', err => {
    console.error('💥 Proxy error:', err.message);
    console.error('💥 Error details:', {
      code: err.code,
      errno: err.errno,
      syscall: err.syscall,
      hostname: err.hostname,
      port: err.port
    });
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end('Bad Gateway');
    }
  });

  proxyReq.write(bodyBuffer);
  proxyReq.end();
}

function handleMultipartRequest(req, res, user, userKey, timestamp, ip) {
  const uploadedFiles = req.files || [];
  
  // Cleanup function to remove temporary files
  const cleanupFiles = () => {
    for (const file of uploadedFiles) {
      try {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
          console.log(`🧹 Cleaned up temp file: ${file.filename}`);
        }
      } catch (err) {
        console.warn(`⚠️ Failed to cleanup ${file.filename}:`, err.message);
      }
    }
  };
  
  console.log(`[DEBUG] Handling multipart request for audio endpoint`);
  console.log(`[DEBUG] Form fields:`, req.body);
  console.log(`[DEBUG] Files:`, uploadedFiles.map(f => ({ 
    fieldname: f.fieldname, 
    filename: f.filename,
    originalname: f.originalname,
    size: f.size, 
    mimetype: f.mimetype 
  })));

  // Reconstruct multipart form data
  const boundary = '----formdata-openai-proxy-' + Math.random().toString(36);
  let formData = '';
  
  try {
    // Add form fields
    for (const [key, value] of Object.entries(req.body || {})) {
      formData += `--${boundary}\r\n`;
      formData += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
      formData += `${value}\r\n`;
    }
    
    // Add files - read from disk instead of memory
    for (const file of uploadedFiles) {
      formData += `--${boundary}\r\n`;
      formData += `Content-Disposition: form-data; name="${file.fieldname}"; filename="${file.originalname || 'audio.wav'}"\r\n`;
      formData += `Content-Type: ${file.mimetype || 'audio/wav'}\r\n\r\n`;
      
      // Read file from disk
      const fileBuffer = fs.readFileSync(file.path);
      formData += fileBuffer.toString('binary') + '\r\n';
    }
    
    formData += `--${boundary}--\r\n`;
    
    const bodyBuffer = Buffer.from(formData, 'binary');
    
    // Log request (without file data)
    const logData = { ...req.body, files: uploadedFiles.map(f => ({ name: f.fieldname, size: f.size })) };
    const logLine = `[${timestamp}] ✅ ${user.name} <${user.email}> from ${ip} → ${req.method} ${req.url} | multipart: ${JSON.stringify(logData)}`;
    fs.writeFileSync(LOG_PATH, logLine + '\n', { flag: 'a' });

    console.log(`[DEBUG] Forwarding multipart request to OpenAI: https://${OPENAI_HOST}${req.url}`);
    const proxyReq = https.request({
      hostname: OPENAI_HOST,
      path: req.url,
      method: req.method,
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(bodyBuffer)
      },
      timeout: 30000, // Longer timeout for audio processing
      family: 4
    }, proxyRes => {
      const responseChunks = [];
      console.log(`[DEBUG] OpenAI responded with status: ${proxyRes.statusCode}`);
      proxyRes.on('data', chunk => {
        responseChunks.push(chunk);
        console.log(`[DEBUG] Received data chunk from OpenAI (${chunk.length} bytes)`);
      });
      proxyRes.on('end', () => {
        // Cleanup temp files after successful response
        cleanupFiles();
        
        const buffer = Buffer.concat(responseChunks);
        const contentType = proxyRes.headers['content-type'] || '';
        if (contentType.startsWith('application/json') || contentType.startsWith('text/')) {
          // Handle as text/JSON
          const raw = buffer.toString();
          console.log(`[DEBUG] Full response from OpenAI:`, raw);
          try {
            const json = JSON.parse(raw);
            // Audio endpoints may not have usage data, but log if available
            const usage = json.usage || {};
            const model = req.body?.model || 'unknown';
            const prompt = usage.prompt_tokens || 0;
            const completion = usage.completion_tokens || 0;
            const total = prompt + completion;

            if (total > 0) {
              const usageLine = `[${timestamp}] 📊 ${user.name} used ${total} tokens (${prompt}+${completion}) on ${model}`;
              console.log(usageLine);
              fs.writeFileSync(LOG_PATH, usageLine + '\n', { flag: 'a' });
              logToDB(userKey, model, req.url, prompt, completion);
            }
          } catch (err) {
            console.error('⚠️ Failed to parse OpenAI response:', err.message);
          }
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.end(raw);
        } else {
          // Binary data: forward as-is
          console.log(`[DEBUG] Binary response from OpenAI, content-type: ${contentType}, length: ${buffer.length}`);
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.end(buffer);
        }
      });
    });

    proxyReq.on('timeout', () => {
      console.error('⏰ OpenAI request timed out after 30 seconds');
      cleanupFiles(); // Cleanup on timeout
      proxyReq.destroy();
      res.statusCode = 504;
      res.end('OpenAI request timed out');
    });

    proxyReq.on('error', err => {
      console.error('💥 Proxy error:', err.message);
      cleanupFiles(); // Cleanup on error
      res.statusCode = 502;
      res.end('Bad Gateway');
    });

    proxyReq.write(bodyBuffer);
    proxyReq.end();
    
  } catch (err) {
    console.error('💥 Error processing multipart request:', err.message);
    cleanupFiles(); // Cleanup on processing error
    res.status(500).json({ error: 'Internal server error processing upload' });
  }
}

// --- Cleanup and rate limiting ---
let activeUploads = new Map(); // Track active uploads per user
const UPLOAD_RATE_LIMIT = 10; // Max 10 concurrent uploads per user
const CLEANUP_INTERVAL = 5 * 60 * 1000; // Cleanup every 5 minutes
const TEMP_FILE_MAX_AGE = 10 * 60 * 1000; // Delete temp files after 10 minutes

// Cleanup temporary files periodically
function cleanupTempFiles() {
  const tempDir = path.join(__dirname, 'temp-uploads');
  if (!fs.existsSync(tempDir)) return;
  
  const now = Date.now();
  const files = fs.readdirSync(tempDir);
  let cleaned = 0;
  
  for (const file of files) {
    const filePath = path.join(tempDir, file);
    try {
      const stats = fs.statSync(filePath);
      const age = now - stats.mtime.getTime();
      
      if (age > TEMP_FILE_MAX_AGE) {
        fs.unlinkSync(filePath);
        cleaned++;
        console.log(`🧹 Cleaned up old temp file: ${file}`);
      }
    } catch (err) {
      console.warn(`⚠️ Failed to cleanup ${file}:`, err.message);
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleanup complete: removed ${cleaned} temporary files`);
  }
}

// Log rotation to prevent access.log from growing too large
function rotateLogs() {
  const maxLogSize = 100 * 1024 * 1024; // 100MB
  
  try {
    const stats = fs.statSync(LOG_PATH);
    if (stats.size > maxLogSize) {
      const backupPath = `${LOG_PATH}.${Date.now()}.bak`;
      fs.renameSync(LOG_PATH, backupPath);
      console.log(`📋 Rotated access log to ${backupPath}`);
      
      // Keep only last 5 backup files
      const backupFiles = fs.readdirSync(__dirname)
        .filter(f => f.startsWith('access.log.') && f.endsWith('.bak'))
        .sort()
        .reverse();
        
      if (backupFiles.length > 5) {
        for (const file of backupFiles.slice(5)) {
          fs.unlinkSync(path.join(__dirname, file));
          console.log(`🗑️ Deleted old log backup: ${file}`);
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ Log rotation failed:', err.message);
  }
}

// Rate limiting check
function checkUploadRateLimit(userKey) {
  const currentUploads = activeUploads.get(userKey) || 0;
  if (currentUploads >= UPLOAD_RATE_LIMIT) {
    return false;
  }
  activeUploads.set(userKey, currentUploads + 1);
  return true;
}

function releaseUploadSlot(userKey) {
  const currentUploads = activeUploads.get(userKey) || 0;
  if (currentUploads > 0) {
    activeUploads.set(userKey, currentUploads - 1);
  }
}

// Start cleanup intervals
setInterval(cleanupTempFiles, CLEANUP_INTERVAL);
setInterval(rotateLogs, CLEANUP_INTERVAL);

// Cleanup on shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  cleanupTempFiles();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Server terminated...');
  cleanupTempFiles();
  process.exit(0);
});

app.listen(8080, () => {
  console.log('OpenAI running on http://localhost:8080');
});