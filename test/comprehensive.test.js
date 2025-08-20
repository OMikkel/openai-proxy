import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import fs from 'fs';
import http from 'http';
import FormData from 'form-data';

// Configuration
const DEFAULT_HOST = 'localhost:8080';
const DEFAULT_API_KEY = 'test-user-1';

// Parse environment variables for configuration
const host = process.env.TEST_HOST || DEFAULT_HOST;
const apiKey = process.env.TEST_API_KEY || DEFAULT_API_KEY;

const [hostname, portStr] = host.split(':');
const port = portStr ? parseInt(portStr, 10) : 8080;

// Helper function to make HTTP requests
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

describe('OpenAI Proxy Comprehensive Tests', function() {
  this.timeout(120000); // 2 minute timeout for comprehensive tests

  before(function() {
    console.log(`🚀 Starting comprehensive test suite for http://${host}`);
    console.log(`Using API key: ${apiKey.substring(0, 8)}...`);
  });

  describe('Chat Completion API', function() {
    it('should handle basic chat completion requests', async function() {
      const requestData = JSON.stringify({
        model: 'gpt-5-mini',
        messages: [{ role: 'user', content: 'Say "Hello, proxy test!"' }],
        max_completion_tokens: 20
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
      
      const response = await makeRequest(options, requestData);
      
      expect(response.statusCode).to.equal(200);
      
      const json = JSON.parse(response.data);
      expect(json.choices).to.exist;
      expect(json.choices.length).to.be.greaterThan(0);
      expect(json.usage).to.exist;
      expect(json.usage.total_tokens).to.be.greaterThan(0);
      expect(json.model).to.match(/^gpt-5-mini/);
    });

    it('should handle vision API requests', async function() {
      const pngData = fs.readFileSync('./test/image.png');
      const base64Image = pngData.toString('base64');
      
      const requestData = JSON.stringify({
        model: 'gpt-5-mini',
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
        max_completion_tokens: 50
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
      
      const response = await makeRequest(options, requestData, 60000);
      
      expect(response.statusCode).to.equal(200);
      
      const json = JSON.parse(response.data);
      expect(json.choices).to.exist;
      expect(json.choices.length).to.be.greaterThan(0);
      expect(json.usage).to.exist;
      expect(json.usage.total_tokens).to.be.greaterThan(0);
    });
  });

  describe('Audio API', function() {
    it('should handle TTS (text-to-speech) requests', async function() {
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
      
      const response = await makeRequest(options, requestData, 30000);
      
      expect(response.statusCode).to.equal(200);
      expect(response.headers['content-type']).to.equal('audio/mpeg');
      expect(response.buffer.length).to.be.greaterThan(40000);
      
      // Check MP3 header
      const mp3Header = response.buffer.slice(0, 3);
      const isValidMP3 = (mp3Header[0] === 0xFF && (mp3Header[1] & 0xE0) === 0xE0) || 
                         mp3Header.toString() === 'ID3';
      expect(isValidMP3).to.be.true;
    });

    it('should handle audio transcription requests', async function() {
      // Create a test audio file (0.2 seconds to meet minimum requirement)
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
      
      const response = await makeRequest(options, form, 60000);
      
      expect(response.statusCode).to.be.lessThan(500);
      
      if (response.statusCode === 200) {
        const json = JSON.parse(response.data);
        expect(json.text).to.exist;
      } else {
        // Even errors should be properly formatted
        const json = JSON.parse(response.data);
        expect(json.error).to.exist;
        expect(json.error.message).to.exist;
      }
    });
  });

  describe('Security & Authentication', function() {
    it('should reject requests with invalid API keys', async function() {
      const requestData = JSON.stringify({
        model: 'gpt-5-mini',
        messages: [{ role: 'user', content: 'Test' }],
        max_completion_tokens: 10
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
      
      const response = await makeRequest(options, requestData);
      
      expect(response.statusCode).to.equal(403);
      
      const json = JSON.parse(response.data);
      expect(json.error).to.exist;
      expect(json.error).to.include('Invalid');
    });
  });

  describe('System Endpoints', function() {
    it('should provide health endpoint', async function() {
      const options = {
        hostname: hostname,
        port: port,
        path: '/health',
        method: 'GET'
      };
      
      const response = await makeRequest(options);
      
      expect(response.statusCode).to.equal(200);
      
      const json = JSON.parse(response.data);
      expect(json.status).to.equal('healthy');
      expect(json.queue).to.exist;
      expect(json.queue.global).to.exist;
    });

    it('should provide metrics endpoint', async function() {
      const options = {
        hostname: hostname,
        port: port,
        path: '/metrics',
        method: 'GET'
      };
      
      const response = await makeRequest(options);
      
      expect(response.statusCode).to.equal(200);
      expect(response.headers['content-type']).to.equal('text/plain');
      expect(response.data).to.include('openai_proxy_requests_total');
    });
  });

  describe('Rate Limiting', function() {
    it('should handle moderate load without errors', async function() {
      const requestData = JSON.stringify({
        model: 'gpt-5-mini',
        messages: [{ role: 'user', content: 'Quick test' }],
        max_completion_tokens: 10
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
      
      // Make 8 concurrent requests
      const promises = [];
      for (let i = 0; i < 8; i++) {
        promises.push(
          makeRequest(options, requestData, 15000)
            .then(response => ({ success: true, statusCode: response.statusCode, index: i }))
            .catch(error => ({ success: false, error: error.message, index: i }))
        );
      }
      
      const results = await Promise.all(promises);
      
      const successfulRequests = results.filter(r => r.success && r.statusCode === 200).length;
      const handledRequests = results.filter(r => r.success || r.error === 'Request timeout').length;
      
      expect(successfulRequests).to.be.greaterThan(0);
      expect(handledRequests).to.equal(8);
    });

    it('should handle high volume load gracefully', async function() {
      this.timeout(120000); // 2 minute timeout for high volume test
      
      const requestData = JSON.stringify({
        model: 'gpt-5-mini',
        messages: [{ role: 'user', content: 'Hi' }],
        max_completion_tokens: 5
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
      
      console.log('   Launching 50 requests to test high volume handling...');
      
      const promises = [];
      const startTime = Date.now();
      const batchSize = 10;
      
      // Send requests in batches with small delays
      for (let batch = 0; batch < 5; batch++) {
        for (let i = 0; i < batchSize; i++) {
          const requestIndex = batch * batchSize + i;
          promises.push(
            makeRequest(options, requestData, 30000)
              .then(response => ({ 
                success: true, 
                statusCode: response.statusCode, 
                index: requestIndex,
                timestamp: Date.now() 
              }))
              .catch(error => ({ 
                success: false, 
                error: error.message, 
                index: requestIndex,
                timestamp: Date.now()
              }))
          );
        }
        // Small delay between batches
        if (batch < 4) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      
      const results = await Promise.all(promises);
      const endTime = Date.now();
      const totalTime = endTime - startTime;
      
      const successfulRequests = results.filter(r => r.success && r.statusCode === 200).length;
      const rateLimitedRequests = results.filter(r => r.success && r.statusCode === 429).length;
      const serviceUnavailableRequests = results.filter(r => r.success && r.statusCode === 503).length;
      const failedRequests = results.filter(r => !r.success).length;
      
      console.log(`   Results: ${successfulRequests} successful, ${rateLimitedRequests} rate limited, ${serviceUnavailableRequests} service unavailable, ${failedRequests} failed`);
      console.log(`   Total time: ${Math.round(totalTime/1000)}s`);
      
      expect(successfulRequests).to.be.greaterThan(10); // At least 20% should succeed
      expect(successfulRequests + rateLimitedRequests + serviceUnavailableRequests).to.be.greaterThan(40); // Most should be handled
      expect(totalTime).to.be.lessThan(60000); // Should complete within 1 minute
      
      // Test system responsiveness after load
      console.log('   Testing system responsiveness after high load...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const postLoadResponse = await makeRequest(options, requestData, 15000);
      expect(postLoadResponse.statusCode).to.equal(200);
    });
  });

  after(function() {
    console.log('🏁 Comprehensive tests completed');
  });
});
