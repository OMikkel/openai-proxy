#!/usr/bin/env node
// usage.js: Show usage stats for a user specified by email, or all users if no email
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';

// --- Path setup ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KEYS_PATH = path.join(__dirname, 'keys.json');
const DB_PATH = path.join(__dirname, 'usage.sqlite');

// --- Parse arguments ---
const [,, email] = process.argv;

let userKey = null;
let userName = null;
if (email) {
  // --- Lookup user by email ---
  try {
    const raw = fs.readFileSync(KEYS_PATH, 'utf-8');
    const keys = JSON.parse(raw);
    const user = keys.find(k => k.email.toLowerCase() === email.toLowerCase());
    if (!user) {
      console.error('No user found with email:', email);
      process.exit(1);
    }
    userKey = user.key;
    userName = user.name;
  } catch (err) {
    console.error('Failed to read keys.json:', err.message);
    process.exit(1);
  }
}

const db = new sqlite3.Database(DB_PATH);

if (!email) {
  // --- No email: show summary for all users ---
  const raw = fs.readFileSync(KEYS_PATH, 'utf-8');
  const keys = JSON.parse(raw);
  db.all(
    `SELECT api_key, SUM(prompt_tokens) as prompt, SUM(completion_tokens) as completion, SUM(total_tokens) as total, COUNT(*) as prompts
     FROM usage_log GROUP BY api_key`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Failed to query usage.sqlite:', err.message);
        process.exit(1);
      }
      if (!rows.length) {
        console.log('No usage found for any user.');
        process.exit(0);
      }
      // Join with keys for name/email
      const userMap = new Map(keys.map(k => [k.key, k]));
      // Sort by total tokens used (desc)
      rows.sort((a, b) => (b.total || 0) - (a.total || 0));
      // Table header
      console.log(`Name                | Email                  | Prompts | Prompt tokens | Completion | Total tokens`);
      console.log(`--------------------+------------------------+---------+--------------+------------+-------------`);
      for (const row of rows) {
        const user = userMap.get(row.api_key) || { name: 'Unknown', email: row.api_key };
        console.log(`${user.name.padEnd(20)} | ${user.email.padEnd(22)} | ${String(row.prompts).padStart(7)} | ${String(row.prompt).padStart(12)} | ${String(row.completion).padStart(10)} | ${String(row.total).padStart(11)}`);
      }
      db.close();
    }
  );
} else {
  // --- Per-user summary ---
  db.get(
    `SELECT COUNT(*) as numPrompts FROM usage_log WHERE api_key = ?`,
    [userKey],
    (err, countRow) => {
      if (err) {
        console.error('Failed to query usage.sqlite for prompt count:', err.message);
        process.exit(1);
      }
      const numPrompts = countRow.numPrompts;
      db.get(
        `SELECT SUM(prompt_tokens) as prompt, SUM(completion_tokens) as completion, SUM(total_tokens) as total
         FROM usage_log WHERE api_key = ?`,
        [userKey],
        (err, sumRow) => {
          if (err) {
            console.error('Failed to query usage.sqlite:', err.message);
            process.exit(1);
          }
          if (!sumRow || (!sumRow.prompt && !sumRow.completion)) {
            console.log(`No usage found for ${userName} <${email}>`);
            process.exit(0);
          }
          const avgPrompt = numPrompts ? (sumRow.prompt / numPrompts).toFixed(2) : 0;
          const avgCompletion = numPrompts ? (sumRow.completion / numPrompts).toFixed(2) : 0;
          // Summary table
          console.log(`Usage summary for ${userName} <${email}> (key: ${userKey}):\n`);
          console.log(`Prompts | Prompt tokens | Completion | Total tokens | Avg prompt | Avg completion`);
          console.log(`------- + ------------- + ---------- + ------------ + ---------- + --------------`);
          console.log(`${String(numPrompts).padStart(7)} | ${String(sumRow.prompt).padStart(13)} | ${String(sumRow.completion).padStart(10)} | ${String(sumRow.total).padStart(12)} | ${String(avgPrompt).padStart(10)} | ${String(avgCompletion).padStart(14)}`);
          db.close();
        }
      );
    }
  );
}
