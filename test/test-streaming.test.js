import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import http from 'http';

// Configuration - following comprehensive.test.js pattern
const DEFAULT_HOST = 'localhost:8080';
const DEFAULT_API_KEY = 'test-user-1';

// Parse environment variables for configuration
const host = process.env.TEST_HOST || DEFAULT_HOST;
const apiKey = process.env.TEST_API_KEY || DEFAULT_API_KEY;

const [hostname, portStr] = host.split(':');
const port = portStr ? parseInt(portStr, 10) : 8080;

// Helper function to make HTTP requests - adapted from comprehensive.test.js
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
      req.write(data);
      req.end();
    } else {
      req.end();
    }
  });
}

// Helper for streaming requests
function makeStreamingRequest(options, data, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let finished = false;
    
    const req = http.request(options, (res) => {
      res.on('data', (chunk) => {
        chunks.push(chunk.toString());
      });
      
      res.on('end', () => {
        if (!finished) {
          finished = true;
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            chunks: chunks,
            data: chunks.join('')
          });
        }
      });
    });
    
    req.on('error', (err) => {
      if (!finished) {
        finished = true;
        reject(err);
      }
    });
    
    req.on('timeout', () => {
      if (!finished) {
        finished = true;
        req.destroy();
        reject(new Error('Request timeout'));
      }
    });
    
    req.setTimeout(timeout);
    
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

describe('Streaming Response Tests', function() {
  this.timeout(60000); // 1 minute timeout for streaming tests

  before(function() {
    console.log(`🚀 Starting streaming test suite for http://${host}`);
    console.log(`Using API key: ${apiKey.substring(0, 8)}...`);
  });

  it('should handle streaming chat completion requests', async function() {
    const requestData = JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Count from 1 to 3' }],
      max_completion_tokens: 50,
      stream: true
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
    
    const response = await makeStreamingRequest(options, requestData);
    
    if (response.statusCode !== 200) {
      console.log('Error response status:', response.statusCode);
      console.log('Error response data:', response.data);
    }
    
    expect(response.statusCode).to.equal(200);
    expect(response.headers['content-type']).to.equal('text/event-stream');
    
    // Log the actual streaming response for verification
    console.log('Received', response.chunks.length, 'chunks');
    console.log('First few chunks:', response.chunks.slice(0, 3));
    console.log('Last chunk:', response.chunks[response.chunks.length - 1]);
    
    // Verify we received multiple chunks
    expect(response.chunks.length).to.be.greaterThan(1);
    
    // Verify SSE format
    const allContent = response.data;
    expect(allContent).to.match(/^data: /m);
    
    // Verify we received [DONE] marker
    expect(allContent).to.include('[DONE]');
    
    // Parse and verify at least one valid JSON chunk
    const dataLines = allContent.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]'));
    expect(dataLines.length).to.be.greaterThan(0);
    
    let foundValidChunk = false;
    for (const line of dataLines) {
      try {
        const data = JSON.parse(line.substring(6));
        if (data.choices && data.choices[0] && data.choices[0].delta) {
          foundValidChunk = true;
          break;
        }
      } catch (e) {
        // Skip invalid JSON
      }
    }
    expect(foundValidChunk).to.be.true;
  });
  
  it('should handle non-streaming requests normally', async function() {
    const requestData = JSON.stringify({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'Say "test"' }],
      max_completion_tokens: 10,
      stream: false
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
    expect(response.headers['content-type']).to.include('application/json');
    
    const json = JSON.parse(response.data);
    expect(json.choices).to.exist;
    expect(json.choices[0]).to.have.property('message');
    expect(json.usage).to.exist;
    expect(json.usage.total_tokens).to.be.greaterThan(0);
  });
  
  it('should handle streaming errors gracefully', async function() {
    const requestData = JSON.stringify({
      model: 'invalid-model-xyz',
      messages: [{ role: 'user', content: 'test' }],
      stream: true
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
    
    // Even errors should be returned properly
    expect(response.statusCode).to.be.oneOf([400, 403, 404]);
  });
});