import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { createUser } from './create.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KEYS_PATH = path.join(__dirname, 'keys.json');

async function bulkCreateFromCSV(csvPath) {
  // Load existing keys
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
  const existingEmails = new Set(keys.map(k => k.email));

  // Read CSV
  const rl = readline.createInterface({
    input: fs.createReadStream(csvPath),
    crlfDelay: Infinity
  });

  let created = 0, skipped = 0, total = 0;
  let isHeader = true;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    const [name, email] = line.split(',').map(s => s.trim());
    if (!name || !email) continue;
    total++;
    if (existingEmails.has(email)) {
      console.log(`Skipping existing user: ${email}`);
      skipped++;
      continue;
    }
    try {
      createUser(name, email);
      console.log(`Created user: ${email}`);
      existingEmails.add(email);
      created++;
    } catch (err) {
      console.error(`Failed to create user ${email}: ${err.message}`);
    }
  }
  console.log(`Done. Created: ${created}, Skipped: ${skipped}, Total processed: ${total}`);
}

// CLI usage
if (import.meta.url === process.argv[1] || import.meta.url === `file://${process.argv[1]}`) {
  const [,, csvPath] = process.argv;
  if (!csvPath) {
    console.log('Usage: node bulk_create.js <users.csv>');
    process.exit(1);
  }
  bulkCreateFromCSV(csvPath).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
