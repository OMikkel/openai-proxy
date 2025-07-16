#!/usr/bin/env node
// create.js: Command-line tool to add a new API key to keys.json
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KEYS_PATH = path.join(__dirname, 'keys.json');

export function createUser(name, email) {
  if (!name || !email) {
    throw new Error('Name and email are required');
  }

  let keys = [];
  try {
    const raw = fs.readFileSync(KEYS_PATH, 'utf-8');
    keys = JSON.parse(raw);
    if (!Array.isArray(keys)) throw new Error('keys.json is not an array');
  } catch (err) {
    if (err.code === 'ENOENT') {
      keys = [];
    } else {
      throw new Error('Failed to read keys.json: ' + err.message);
    }
  }

  const key = randomUUID();
  const entry = { key, name, email };
  keys.push(entry);

  try {
    fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
  } catch (err) {
    throw new Error('Failed to write keys.json: ' + err.message);
  }

  return entry;
}

// CLI usage
if (import.meta.url === process.argv[1] || import.meta.url === `file://${process.argv[1]}`) {
  const [,, name, email] = process.argv;
  if (!name || !email) {
    console.log('Usage: node create.js <name> <email>');
    process.exit(1);
  }
  try {
    const entry = createUser(name, email);
    console.log('✅ Created new API key:');
    console.log(JSON.stringify(entry, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
