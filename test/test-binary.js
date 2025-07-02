#!/usr/bin/env node

// Test script for binary response (TTS MP3)
import fs from 'fs';
import http from 'http';

const API_KEY = 'test-api-key-123'; // Using the actual key from keys.json
const PROXY_URL = 'localhost';
const PROXY_PORT = 8080;

console.log('🎵 Testing binary response with OpenAI TTS API...');

const requestBody = JSON.stringify({
  model: 'tts-1',
  input: 'Hello, this is a test of the binary response handling in the OpenAI proxy.',
  voice: 'alloy'
});

const options = {
  hostname: PROXY_URL,
  port: PROXY_PORT,
  path: '/v1/audio/speech',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Api-Key': API_KEY,
    'Content-Length': Buffer.byteLength(requestBody)
  }
};

const req = http.request(options, (res) => {
  console.log(`📡 Status: ${res.statusCode}`);
  console.log(`📋 Headers:`, res.headers);
  
  const chunks = [];
  let totalSize = 0;
  
  res.on('data', (chunk) => {
    chunks.push(chunk);
    totalSize += chunk.length;
    console.log(`📦 Received chunk: ${chunk.length} bytes (total: ${totalSize} bytes)`);
  });
  
  res.on('end', () => {
    const buffer = Buffer.concat(chunks);
    console.log(`✅ Complete! Received ${buffer.length} bytes total`);
    
    // Check if it's actually MP3 data by looking at the header
    const mp3Header = buffer.slice(0, 3);
    if (mp3Header[0] === 0xFF && (mp3Header[1] & 0xE0) === 0xE0) {
      console.log('🎵 Valid MP3 header detected!');
    } else if (mp3Header.toString() === 'ID3') {
      console.log('🎵 MP3 with ID3 tag detected!');
    } else {
      console.log('⚠️  Unexpected header:', mp3Header);
      console.log('First 32 bytes:', buffer.slice(0, 32));
    }
    
    // Save to file for verification
    const outputPath = '/Users/au166305/Programming/openai-proxy/test/test-output.mp3';
    fs.writeFileSync(outputPath, buffer);
    console.log(`💾 Saved to: ${outputPath}`);
    
    // Try to get file info
    const stats = fs.statSync(outputPath);
    console.log(`📊 File size: ${stats.size} bytes`);
    
    process.exit(0);
  });
});

req.on('error', (err) => {
  console.error('❌ Request error:', err.message);
  process.exit(1);
});

req.on('timeout', () => {
  console.error('⏰ Request timed out');
  req.destroy();
  process.exit(1);
});

req.setTimeout(30000); // 30 seconds for audio generation
req.write(requestBody);
req.end();
