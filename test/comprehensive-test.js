#!/usr/bin/env node

// Comprehensive test suite for OpenAI proxy
import fs from 'fs';
import http from 'http';
import FormData from 'form-data';

// Default values
let host = 'localhost:8080';
let apiKey = 'test-api-key-123'; // Default key

// Parse command-line arguments
// Usage: node comprehensive-test.js --host=localhost:8080 --api-key=your-key
process.argv.slice(2).forEach(arg => {
  if (arg.startsWith('--host=')) {
    host = arg.substring('--host='.length);
  } else if (arg.startsWith('--api-key=')) {
    apiKey = arg.substring('--api-key='.length);
  }
});

const [hostname, portStr] = host.split(':');
const port = portStr ? parseInt(portStr, 10) : 8080;

let testsPassed = 0;
let testsFailed = 0;

function logTest(name, success, details = '') {
  if (success) {
    console.log(`✅ ${name}`);
    testsPassed++;
  } else {
    console.log(`❌ ${name}: ${details}`);
    testsFailed++;
  }
}

function makeRequest(options, data, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let responseData = '';
      const chunks = [];
      
      res.on('data', (chunk) => {
        chunks.push(chunk);
        responseData += chunk;
      });
      
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: responseData,
          buffer: buffer
        });
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.setTimeout(timeout);
    
    if (data) {
      if (data.pipe) {
        data.pipe(req);
      } else {
        req.write(data);
        req.end();
      }
    } else {
      req.end();
    }
  });
}

async function testChatCompletion() {
  console.log(`\n🧪 Testing Chat Completion (JSON) via http://${hostname}:${port}...`);
  
  const requestData = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Say "Hello, proxy test!"' }],
    max_tokens: 20
  });
  
  const options = {
    hostname: hostname,
    port: port,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': apiKey,
      'Content-Length': Buffer.byteLength(requestData)
    }
  };
  
  try {
    const response = await makeRequest(options, requestData);
    
    logTest('Chat completion status', response.statusCode === 200, `Got ${response.statusCode}`);
    
    const json = JSON.parse(response.data);
    logTest('Chat completion response format', json.choices && json.choices.length > 0, 'Missing choices');
    logTest('Chat completion usage tracking', json.usage && json.usage.total_tokens > 0, 'Missing usage data');
    logTest('Chat completion model field', json.model.startsWith('gpt-4o-mini'), `Got model: ${json.model}`);
    
  } catch (error) {
    logTest('Chat completion request', false, error.message);
  }
}

async function testTTSBinary() {
  console.log(`\n🧪 Testing TTS (Binary Response) via http://${hostname}:${port}...`);
  
  const requestData = JSON.stringify({
    model: 'tts-1',
    input: 'This is a test of binary response handling.',
    voice: 'alloy'
  });
  
  const options = {
    hostname: hostname,
    port: port,
    path: '/v1/audio/speech',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': apiKey,
      'Content-Length': Buffer.byteLength(requestData)
    }
  };
  
  try {
    const response = await makeRequest(options, requestData, 30000);
    
    logTest('TTS status', response.statusCode === 200, `Got ${response.statusCode}`);
    logTest('TTS content type', response.headers['content-type'] === 'audio/mpeg', `Got ${response.headers['content-type']}`);
    logTest('TTS binary data size', response.buffer.length > 40000, `Got ${response.buffer.length} bytes`);
    
    // Check MP3 header
    const mp3Header = response.buffer.slice(0, 3);
    const isValidMP3 = (mp3Header[0] === 0xFF && (mp3Header[1] & 0xE0) === 0xE0) || mp3Header.toString() === 'ID3';
    logTest('TTS MP3 format validation', isValidMP3, 'Invalid MP3 header');
    
  } catch (error) {
    logTest('TTS request', false, error.message);
  }
}

async function testTranscription() {
  console.log(`\n🧪 Testing Audio Transcription (Multipart) via http://${hostname}:${port}...`);
  
  // Create a longer test audio file (0.2 seconds to meet minimum requirement)
  const wavHeader = Buffer.from([
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    0x64, 0x46, 0x00, 0x00, // File size - 8 (larger)
    0x57, 0x41, 0x56, 0x45, // "WAVE"
    0x66, 0x6D, 0x74, 0x20, // "fmt "
    0x10, 0x00, 0x00, 0x00, // Format chunk size
    0x01, 0x00,             // Audio format (PCM)
    0x01, 0x00,             // Number of channels
    0x44, 0xAC, 0x00, 0x00, // Sample rate (44100)
    0x88, 0x58, 0x01, 0x00, // Byte rate
    0x02, 0x00,             // Block align
    0x10, 0x00,             // Bits per sample
    0x64, 0x61, 0x74, 0x61, // "data"
    0x40, 0x46, 0x00, 0x00  // Data size (larger)
  ]);
  
  // 0.2 seconds of silence at 44100Hz = 8820 samples * 2 bytes = 17640 bytes
  const silence = Buffer.alloc(17640, 0);
  const testAudio = Buffer.concat([wavHeader, silence]);
  
  const form = new FormData();
  form.append('file', testAudio, {
    filename: 'test-audio.wav',
    contentType: 'audio/wav'
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
  
  try {
    const response = await makeRequest(options, form, 60000);
    
    logTest('Transcription multipart handling', response.statusCode < 500, `Got ${response.statusCode}`);
    
    try {
      const json = JSON.parse(response.data);
      if (response.statusCode === 200) {
        logTest('Transcription success', json.text !== undefined, 'Missing text field');
      } else {
        // Even errors should be properly formatted
        logTest('Transcription error format', json.error && json.error.message, 'Missing error details');
        console.log(`   Note: ${json.error?.message || 'Unknown error'}`);
      }
    } catch (parseError) {
      logTest('Transcription response parsing', false, 'Invalid JSON response');
    }
    
  } catch (error) {
    logTest('Transcription request', false, error.message);
  }
}

async function testVisionAPI() {
  console.log(`\n🧪 Testing Vision API (Multimodal) via http://${hostname}:${port}...`);
  
  // Use the actual test image file
  const pngData = fs.readFileSync('/Users/au166305/Programming/openai-proxy/test/image.png');
  const base64Image = pngData.toString('base64');
  
  const requestData = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image briefly.' },
        { 
          type: 'image_url', 
          image_url: { url: `data:image/png;base64,${base64Image}` }
        }
      ]
    }],
    max_tokens: 50
  });
  
  const options = {
    hostname: hostname,
    port: port,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': apiKey,
      'Content-Length': Buffer.byteLength(requestData)
    }
  };
  
  try {
    const response = await makeRequest(options, requestData, 30000);
    
    logTest('Vision API status', response.statusCode === 200, `Got ${response.statusCode}`);
    
    const json = JSON.parse(response.data);
    logTest('Vision API response format', json.choices && json.choices.length > 0, 'Missing choices');
    logTest('Vision API usage tracking', json.usage && json.usage.total_tokens > 0, 'Missing usage data');
    
  } catch (error) {
    logTest('Vision API request', false, error.message);
  }
}

async function testInvalidAPIKey() {
  console.log(`\n🧪 Testing Invalid API Key via http://${hostname}:${port}...`);
  
  const requestData = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Test' }],
    max_tokens: 10
  });
  
  const options = {
    hostname: hostname,
    port: port,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': 'invalid-key-12345',
      'Content-Length': Buffer.byteLength(requestData)
    }
  };
  
  try {
    const response = await makeRequest(options, requestData);
    
    logTest('Invalid API key rejection', response.statusCode === 403, `Got ${response.statusCode}`);
    
    const json = JSON.parse(response.data);
    logTest('Invalid API key error message', json.error && json.error.includes('Invalid'), 'Wrong error message');
    
  } catch (error) {
    logTest('Invalid API key test', false, error.message);
  }
}

async function runAllTests() {
  console.log(`🚀 Starting comprehensive OpenAI proxy test suite for http://${host}...\n`);
  
  await testChatCompletion();
  await testTTSBinary();
  await testTranscription();
  await testVisionAPI();
  await testInvalidAPIKey();
  
  console.log('\n📊 Test Results:');
  console.log(`✅ Passed: ${testsPassed}`);
  console.log(`❌ Failed: ${testsFailed}`);
  console.log(`🎯 Success Rate: ${Math.round((testsPassed / (testsPassed + testsFailed)) * 100)}%`);
  
  if (testsFailed === 0) {
    console.log('\n🎉 All tests passed! Proxy is working perfectly.');
  } else {
    console.log('\n⚠️  Some tests failed. Check the logs above for details.');
  }
  
  process.exit(testsFailed === 0 ? 0 : 1);
}

runAllTests().catch(console.error);
