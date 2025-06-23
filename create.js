#!/usr/bin/env node
// create.js: Command-line tool to add a new API key to keys.json
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KEYS_PATH = path.join(__dirname, 'keys.json');

function usage() {
  console.log('Usage: node create.js <name> <email>');
  process.exit(1);
}

const [,, name, email] = process.argv;
if (!name || !email) usage();

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

const key = randomUUID();
const entry = { key, name, email };
keys.push(entry);

try {
  fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
  console.log('✅ Created new API key:');
  console.log(JSON.stringify(entry, null, 2));
} catch (err) {
  console.error('Failed to write keys.json:', err.message);
  process.exit(1);
}
