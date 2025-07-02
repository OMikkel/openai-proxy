#!/usr/bin/env node
// create.js: Command-line tool to add a new API key to keys.json
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

// --- Path setup ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KEYS_PATH = path.join(__dirname, 'keys.json');

// --- Usage/help ---
function usage() {
  console.log('Usage: node create.js <name> <email>');
  process.exit(1);
}

// --- Parse arguments ---
const [,, name, email] = process.argv;
if (!name || !email) usage();

// --- Load or initialize keys.json ---
let keys = [];
try {
  const raw = fs.readFileSync(KEYS_PATH, 'utf-8');
  keys = JSON.parse(raw);
  if (!Array.isArray(keys)) throw new Error('keys.json is not an array');
} catch (err) {
  if (err.code === 'ENOENT') {
    keys = [];
  } else {
    console.error('Failed to read keys.json:', err.message);
    process.exit(1);
  }
}

// --- Add new key entry ---
const key = randomUUID();
const entry = { key, name, email };
keys.push(entry);

// --- Save updated keys.json ---
try {
  fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
  console.log('✅ Created new API key:');
  console.log(JSON.stringify(entry, null, 2));
} catch (err) {
  console.error('Failed to write keys.json:', err.message);
  process.exit(1);
}
