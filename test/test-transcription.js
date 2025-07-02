#!/usr/bin/env node

// Test script for audio transcription endpoint with multipart/form-data
import fs from 'fs';
import http from 'http';
import FormData from 'form-data';

// Default values
let host = 'localhost:8080';
let apiKey = 'test-api-key-123'; // Default key

// Parse command-line arguments
// Usage: node test-transcription.js --host=localhost:8080 --api-key=your-key
process.argv.slice(2).forEach(arg => {
  if (arg.startsWith('--host=')) {
    host = arg.substring('--host='.length);
  } else if (arg.startsWith('--api-key=')) {
    apiKey = arg.substring('--api-key='.length);
  }
});

const [hostname, portStr] = host.split(':');
const port = portStr ? parseInt(portStr, 10) : 8080;

console.log(`🎤 Testing audio transcription with multipart/form-data via http://${hostname}:${port}...`);

// Use the helloworld.m4a file for the test
const audioFilePath = '/Users/au166305/Programming/openai-proxy/test/helloworld.m4a';
if (!fs.existsSync(audioFilePath)) {
  console.error(`❌ Audio file not found at: ${audioFilePath}`);
  process.exit(1);
}

const testAudio = fs.createReadStream(audioFilePath);

// Create FormData
const form = new FormData();
form.append('file', testAudio, {
  filename: 'helloworld.m4a',
  contentType: 'audio/m4a'
});
form.append('model', 'whisper-1');
form.append('language', 'en');

const options = {
  hostname: hostname,
  port: port,
  path: '/v1/audio/transcriptions',
  method: 'POST',
  headers: {
    ...form.getHeaders(),
    'Api-Key': apiKey
  }
};

const req = http.request(options, (res) => {
  console.log(`📡 Status: ${res.statusCode}`);
  console.log(`📋 Headers:`, res.headers);
  
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
    console.log(`📦 Received chunk: ${chunk.length} bytes`);
  });
  
  res.on('end', () => {
    console.log(`✅ Complete! Response:`, data);
    
    try {
      const json = JSON.parse(data);
      console.log('🎯 Parsed response:', JSON.stringify(json, null, 2));
    } catch (err) {
      console.log('📄 Raw response (not JSON):', data);
    }
    
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

req.setTimeout(60000); // 60 seconds for audio processing
form.pipe(req);
