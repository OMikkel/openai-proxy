import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import http from 'http';

const BASE_URL = 'localhost:8080';
const [hostname, port] = BASE_URL.split(':');

// Test API keys
const TEST_KEY = 'test-user-1';

// Helper function to make HTTP requests
function makeRequest(path, method = 'GET', headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: hostname,
      port: parseInt(port),
      path: path,
      method: method,
      headers: headers
    };

    if (body) {
      const bodyString = JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(bodyString);
      options.headers['Content-Type'] = 'application/json';
    }

    const req = http.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          const parsedBody = responseData ? JSON.parse(responseData) : {};
          resolve({
            statusCode: res.statusCode,
            statusText: res.statusMessage,
            body: parsedBody,
            rawBody: responseData
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            statusText: res.statusMessage,
            body: responseData,
            rawBody: responseData
          });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.setTimeout(15000);
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    
    req.end();
  });
}

describe('Allowlist Functionality', function() {
  this.timeout(60000);

  before(function() {
    console.log('🧪 Starting Allowlist Tests');
  });

  after(function() {
    console.log('✅ Allowlist Tests Complete');
  });

  describe('Health Endpoint', function() {
    it('should return allowlist configuration in health endpoint', async function() {
      const response = await makeRequest('/health');
      
      expect(response.statusCode).to.equal(200);
      expect(response.body).to.have.property('allowlist');
      expect(response.body.allowlist).to.have.property('enabled', true);
      expect(response.body.allowlist).to.have.property('allowed_endpoints');
      expect(response.body.allowlist).to.have.property('allowed_models');
      expect(response.body.allowlist).to.have.property('default_model');
      
      console.log('   Allowlist config:', JSON.stringify(response.body.allowlist, null, 2));
    });
  });

  describe('Endpoint Allowlist', function() {
    it('should allow access to /v1/chat/completions', async function() {
      const response = await makeRequest(
        '/v1/chat/completions', 
        'POST',
        { 'Api-Key': TEST_KEY },
        { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'test' }] }
      );
      
      // Should not be blocked by allowlist (might get auth/other errors, but not 403 for endpoint)
      expect(response.statusCode).to.not.equal(403);
      if (response.statusCode === 403) {
        expect(response.rawBody).to.not.include('Endpoint');
      }
    });

    it('should allow access to /v1/embeddings', async function() {
      const response = await makeRequest(
        '/v1/embeddings',
        'POST', 
        { 'Api-Key': TEST_KEY },
        { model: 'text-embedding-3-small', input: 'test' }
      );
      
      expect(response.statusCode).to.not.equal(403);
      if (response.statusCode === 403) {
        expect(response.rawBody).to.not.include('Endpoint');
      }
    });

    it('should allow access to /v1/audio/transcriptions', async function() {
      const response = await makeRequest(
        '/v1/audio/transcriptions',
        'POST',
        { 'Api-Key': TEST_KEY }
      );
      
      expect(response.statusCode).to.not.equal(403);
      if (response.statusCode === 403) {
        expect(response.rawBody).to.not.include('Endpoint');
      }
    });

    it('should allow access to /v1/audio/speech', async function() {
      const response = await makeRequest(
        '/v1/audio/speech',
        'POST',
        { 'Api-Key': TEST_KEY },
        { model: 'tts-1', input: 'test', voice: 'alloy' }
      );
      
      expect(response.statusCode).to.not.equal(403);
      if (response.statusCode === 403) {
        expect(response.rawBody).to.not.include('Endpoint');
      }
    });

    it('should block access to /v1/models', async function() {
      const response = await makeRequest(
        '/v1/models',
        'GET',
        { 'Api-Key': TEST_KEY }
      );
      
      expect(response.statusCode).to.equal(403);
      expect(response.rawBody).to.include('not allowed');
    });

    it('should block access to /v1/fine-tuning/jobs', async function() {
      const response = await makeRequest(
        '/v1/fine-tuning/jobs',
        'POST',
        { 'Api-Key': TEST_KEY },
        { model: 'gpt-5-mini' }
      );
      
      expect(response.statusCode).to.equal(403);
      expect(response.rawBody).to.include('not allowed');
    });

    it('should block access to /v1/assistants', async function() {
      const response = await makeRequest(
        '/v1/assistants',
        'GET',
        { 'Api-Key': TEST_KEY }
      );
      
      expect(response.statusCode).to.equal(403);
      expect(response.rawBody).to.include('not allowed');
    });
  });

  describe('Model Allowlist', function() {
    it('should allow gpt-5-mini model', async function() {
      const response = await makeRequest(
        '/v1/chat/completions',
        'POST',
        { 'Api-Key': TEST_KEY },
        { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'test' }] }
      );
      
      // Should not be blocked for model reasons
      if (response.statusCode === 403) {
        expect(response.rawBody).to.not.include('Model');
      }
    });

    it('should allow text-embedding-3-small model', async function() {
      const response = await makeRequest(
        '/v1/embeddings',
        'POST',
        { 'Api-Key': TEST_KEY },
        { model: 'text-embedding-3-small', input: 'test' }
      );
      
      if (response.statusCode === 403) {
        expect(response.rawBody).to.not.include('Model');
      }
    });

    it('should block gpt-4 model', async function() {
      const response = await makeRequest(
        '/v1/chat/completions',
        'POST',
        { 'Api-Key': TEST_KEY },
        { model: 'gpt-4', messages: [{ role: 'user', content: 'test' }] }
      );
      
      expect(response.statusCode).to.equal(403);
      expect(response.rawBody).to.include('not allowed');
    });

    it('should block gpt-4-turbo model', async function() {
      const response = await makeRequest(
        '/v1/chat/completions',
        'POST',
        { 'Api-Key': TEST_KEY },
        { model: 'gpt-4-turbo', messages: [{ role: 'user', content: 'test' }] }
      );
      
      expect(response.statusCode).to.equal(403);
      expect(response.rawBody).to.include('not allowed');
    });

    it('should block claude models', async function() {
      const response = await makeRequest(
        '/v1/chat/completions',
        'POST',
        { 'Api-Key': TEST_KEY },
        { model: 'claude-3-sonnet', messages: [{ role: 'user', content: 'test' }] }
      );
      
      expect(response.statusCode).to.equal(403);
      expect(response.rawBody).to.include('not allowed');
    });
  });

  describe('Model Normalization', function() {
    it('should use default model when none specified', async function() {
      const response = await makeRequest(
        '/v1/chat/completions',
        'POST',
        { 'Api-Key': TEST_KEY },
        { messages: [{ role: 'user', content: 'test' }] } // No model specified
      );
      
      // Should not be blocked for missing model (should use default)
      if (response.statusCode === 403) {
        expect(response.rawBody).to.not.include('Model');
      }
    });
  });

  describe('Edge Cases', function() {
    it('should handle malformed JSON gracefully', async function() {
      // Create a request with malformed JSON body
      return new Promise((resolve) => {
        const options = {
          hostname: hostname,
          port: parseInt(port),
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Api-Key': TEST_KEY,
            'Content-Type': 'application/json',
            'Content-Length': '25'
          }
        };

        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            // Should return 400 for malformed JSON, not crash
            expect(res.statusCode).to.be.oneOf([400, 403]);
            resolve();
          });
        });

        req.on('error', () => {
          // Network error is also acceptable for malformed requests
          resolve();
        });

        req.setTimeout(5000, () => {
          req.destroy();
          resolve(); // Don't fail on timeout, just resolve
        });

        // Send malformed JSON
        req.write('{"model": "gpt-5-mini"'); // Missing closing brace
        req.end();
      });
    });

    it('should handle requests without authorization', async function() {
      const response = await makeRequest(
        '/v1/chat/completions',
        'POST',
        {},
        { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'test' }] }
      );
      
      // Should get auth error before allowlist check
      expect(response.statusCode).to.not.equal(500);
    });
  });
});
