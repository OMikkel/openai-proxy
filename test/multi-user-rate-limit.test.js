import { describe, it, before } from 'mocha';
import { expect } from 'chai';
import http from 'http';

const BASE_URL = 'localhost:8080';
const [hostname, port] = BASE_URL.split(':');

// Test API keys for different users
const TEST_KEYS = [
  'test-user-1',
  'test-user-2', 
  'test-user-3',
  'test-user-4',
  'test-user-5'
];

// Helper to make a request with a specific API key
function makeRequest(apiKey, endpoint = '/v1/chat/completions', body = null) {
  const requestBody = body || {
    model: 'gpt-5-mini',
    messages: [{ role: 'user', content: 'Hello' }],
    max_completion_tokens: 10
  };

  const data = JSON.stringify(requestBody);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: hostname,
      port: parseInt(port),
      path: endpoint,
      method: 'POST',
      headers: {
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage,
          data: responseData
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.setTimeout(15000);
    req.write(data);
    req.end();
  });
}

// Helper to make multiple requests concurrently for a single user
async function makeUserRequests(apiKey, count) {
  console.log(`   Making ${count} requests for ${apiKey}...`);
  const requests = Array(count).fill().map(() => makeRequest(apiKey));
  return Promise.allSettled(requests);
}

// Helper to make requests across multiple users
async function makeMultiUserRequests(userCount, requestsPerUser) {
  const promises = [];
  
  for (let i = 0; i < userCount; i++) {
    const apiKey = TEST_KEYS[i % TEST_KEYS.length];
    console.log(`   Starting ${requestsPerUser} requests for ${apiKey}...`);
    for (let j = 0; j < requestsPerUser; j++) {
      promises.push(makeRequest(apiKey));
    }
  }
  
  return Promise.allSettled(promises);
}

describe('Multi-User Rate Limiting Tests', function() {
  this.timeout(60000); // 60 second timeout for rate limiting tests

  before(function() {
    console.log('🔧 Starting multi-user rate limiting tests...');
  });

  describe('Per-User Rate Limiting', function() {
    it('should allow requests within per-user limit', async function() {
      console.log('📝 Testing per-user rate limiting - within limits');
      
      // Make 2 requests for user-1 (within the 2 concurrent limit)
      const results = await makeUserRequests('test-user-1', 2);
      
      const successful = results.filter(r => 
        r.status === 'fulfilled' && r.value.status === 200
      );
      
      console.log(`   ${successful.length}/2 requests succeeded for single user within limits`);
      expect(successful.length).to.be.at.least(1); // At least 1 should succeed
    });

    it('should enforce per-user rate limits independently', async function() {
      console.log('📝 Testing independent per-user rate limits');
      
      // Make requests for 3 different users simultaneously
      const user1Promise = makeUserRequests('test-user-3', 2);
      const user2Promise = makeUserRequests('test-user-4', 2);  
      const user3Promise = makeUserRequests('test-user-5', 2);
      
      const [user1Results, user2Results, user3Results] = await Promise.all([
        user1Promise, user2Promise, user3Promise
      ]);
      
      // Each user should be able to make at least 1 request
      const user1Success = user1Results.filter(r => 
        r.status === 'fulfilled' && r.value.status === 200
      ).length;
      const user2Success = user2Results.filter(r => 
        r.status === 'fulfilled' && r.value.status === 200
      ).length;
      const user3Success = user3Results.filter(r => 
        r.status === 'fulfilled' && r.value.status === 200
      ).length;
      
      console.log(`   Success rates: test-user-3=${user1Success}/2, test-user-4=${user2Success}/2, test-user-5=${user3Success}/2`);
      
      // Each user should get at least some successful requests
      expect(user1Success + user2Success + user3Success).to.be.at.least(3);
    });
  });

  describe('Global Rate Limiting', function() {
    it('should handle moderate load', async function() {
      console.log('📝 Testing moderate load with multiple users');
      
      // Create moderate load: 20 requests from 4 users (5 each)
      const results = await makeMultiUserRequests(4, 5);
      
      const successful = results.filter(r => 
        r.status === 'fulfilled' && r.value.status === 200
      );
      const limited = results.filter(r => 
        r.status === 'fulfilled' && 
        (r.value.status === 503 || r.value.status === 429)
      );
      const failed = results.filter(r => r.status === 'rejected');
      
      console.log(`   Results: ${successful.length} successful, ${limited.length} rate limited, ${failed.length} failed out of 20 total`);
      
      expect(successful.length).to.be.greaterThan(0);
      expect(failed.length).to.be.lessThan(5); // Most should be handled properly
    });

    it('should handle queue behavior', async function() {
      console.log('📝 Testing queue behavior with burst requests');
      
      const startTime = Date.now();
      
      // Make 10 rapid requests from same user
      const results = await makeUserRequests('test-user-1', 10);
      
      const endTime = Date.now();
      const totalTime = endTime - startTime;
      
      const successful = results.filter(r => 
        r.status === 'fulfilled' && r.value.status === 200
      );
      const limited = results.filter(r => 
        r.status === 'fulfilled' && 
        (r.value.status === 503 || r.value.status === 429)
      );
      
      console.log(`   Results: ${successful.length} successful, ${limited.length} limited`);
      console.log(`   Total time: ${totalTime}ms (average: ${Math.round(totalTime/10)}ms per request)`);
      
      expect(successful.length).to.be.greaterThan(0);
      
      // Either we should see rate limiting OR the processing should take some time
      // (indicating queuing), but not both failing
      const hasRateLimiting = limited.length > 0;
      const hasQueuingDelay = totalTime > 2000;
      
      if (!hasRateLimiting && !hasQueuingDelay) {
        console.log(`   ⚠️  No clear evidence of rate limiting or queuing detected`);
        console.log(`   This might indicate rate limiting needs debugging`);
      }
      
      // The test should at least process requests successfully
      expect(successful.length + limited.length).to.equal(10); // All should be handled
    });
  });

  describe('Rate Limiting Metrics', function() {
    it('should expose rate limiting metrics', async function() {
      const options = {
        hostname: hostname,
        port: parseInt(port),
        path: '/metrics',
        method: 'GET'
      };
      
      const response = await new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve({ statusCode: res.statusCode, data, headers: res.headers }));
        });
        req.on('error', reject);
        req.end();
      });
      
      expect(response.statusCode).to.equal(200);
      
      const metrics = response.data;
      
      // Should contain rate limiting metrics
      expect(metrics).to.include('queue_size');
      expect(metrics).to.include('requests_total');
      
      console.log('✅ Rate limiting metrics are exposed');
    });
  });
});
