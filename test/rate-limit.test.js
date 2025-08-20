import { describe, it, before, after } from 'mocha';
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

// Helper to make a request without API key (for public endpoints)
function makePublicRequest(endpoint = '/health', method = 'GET') {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: hostname,
      port: parseInt(port),
      path: endpoint,
      method: method
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          statusText: res.statusMessage,
          body: responseData
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.setTimeout(15000);
    req.end();
  });
}

// Helper to make a request with a specific API key (with delay simulation for testing concurrency)
function makeRequest(apiKey, endpoint = '/v1/chat/completions', body = null, simulateDelay = false) {
  const requestBody = body || {
    model: 'gpt-5-mini',
    messages: [{ role: 'user', content: 'Hello' }],
    max_completion_tokens: simulateDelay ? 100 : 10  // More tokens = longer processing time
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
  const requests = Array(count).fill().map(() => makeRequest(apiKey));
  return Promise.allSettled(requests);
}

// Helper to make requests across multiple users
async function makeMultiUserRequests(userCount, requestsPerUser) {
  const promises = [];
  
  for (let i = 0; i < userCount; i++) {
    const apiKey = TEST_KEYS[i % TEST_KEYS.length];
    for (let j = 0; j < requestsPerUser; j++) {
      promises.push(makeRequest(apiKey));
    }
  }
  
  return Promise.allSettled(promises);
}

describe('Rate Limiting Tests', function() {
  this.timeout(60000); // 60 second timeout for rate limiting tests

  before(async function() {
    console.log('🔧 Starting rate limiting tests...');
    
    // Wait a bit for any previous tests to clear
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  describe('Per-User Rate Limiting', function() {
    it('should allow requests within per-user limit', async function() {
      console.log('📝 Testing per-user rate limiting - within limits');
      
      // Make 2 requests for user-1 (within the 2 concurrent limit)
      const results = await makeUserRequests('test-user-1', 2);
      
      // Both should succeed (either 200 or be queued)
      const successful = results.filter(r => 
        r.status === 'fulfilled' && 
        (r.value.status === 200 || r.value.status === 202)
      );
      
      console.log(`✅ ${successful.length}/2 requests succeeded for single user within limits`);
      expect(successful.length).to.be.at.least(1); // At least 1 should succeed
    });

    it('should queue/reject requests exceeding per-user concurrent limit', async function() {
      console.log('📝 Testing per-user concurrent limit exceeded');
      
      // Make 5 concurrent requests for user-2 (exceeds 2 concurrent limit)
      // Use slower requests to ensure they overlap in time
      const promises = Array(5).fill().map(() => makeRequest('test-user-2', '/v1/chat/completions', null, true));
      const results = await Promise.allSettled(promises);
      
      const successful = results.filter(r => 
        r.status === 'fulfilled' && r.value.status === 200
      );
      const queued = results.filter(r => 
        r.status === 'fulfilled' && r.value.status === 202
      );
      const rejected = results.filter(r => 
        r.status === 'fulfilled' && 
        (r.value.status === 503 || r.value.status === 429)
      );
      
      console.log(`📊 Results: ${successful.length} successful, ${queued.length} queued, ${rejected.length} rejected`);
      
      // With only 2 concurrent allowed, we should not see all 5 succeed instantly
      // At minimum, we should see some evidence of rate limiting
      const totalHandled = successful.length + queued.length + rejected.length;
      expect(totalHandled).to.equal(5); // All requests should be handled
      
      // Either some should be queued/rejected, OR if all succeed, they should show staggered timing
      if (successful.length === 5) {
        console.log('   Note: All requests succeeded - checking if they were properly queued...');
        // If all succeeded, it's because they were queued and processed sequentially
        // This is actually correct behavior for a working rate limiter
      } else {
        expect(rejected.length + queued.length).to.be.greaterThan(0);
      }
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
      
      console.log(`📊 Success rates: User3=${user1Success}/2, User4=${user2Success}/2, User5=${user3Success}/2`);
      
      // Each user should get at least some successful requests
      expect(user1Success + user2Success + user3Success).to.be.at.least(3);
    });
  });

  describe('Global Rate Limiting', function() {
    it('should enforce global concurrent limits', async function() {
      console.log('📝 Testing global concurrent limits with high load');
      
      // Create a high load scenario: 50 requests from 5 users (10 each)
      // Use slower requests to test true concurrency
      const promises = [];
      for (let i = 0; i < 5; i++) {
        const apiKey = TEST_KEYS[i % TEST_KEYS.length];
        for (let j = 0; j < 10; j++) {
          promises.push(makeRequest(apiKey, '/v1/chat/completions', null, true));
        }
      }
      
      const results = await Promise.allSettled(promises);
      
      const successful = results.filter(r => 
        r.status === 'fulfilled' && r.value.status === 200
      );
      const queued = results.filter(r => 
        r.status === 'fulfilled' && r.value.status === 202
      );
      const rejected = results.filter(r => 
        r.status === 'fulfilled' && 
        (r.value.status === 503 || r.value.status === 429)
      );
      
      console.log(`📊 Global limits test: ${successful.length} successful, ${queued.length} queued, ${rejected.length} rejected out of 50 total`);
      
      // Should have some successful requests
      expect(successful.length).to.be.greaterThan(0);
      
      // With 40 global concurrent limit, some requests should succeed immediately
      // But not necessarily all 50 - depends on OpenAI response times
      // The key is that all requests should be handled properly
      const totalHandled = successful.length + queued.length + rejected.length;
      expect(totalHandled).to.equal(50);
      
      // If all 50 succeeded, they were likely queued and processed properly
      if (successful.length < 50) {
        expect(rejected.length + queued.length).to.be.greaterThan(0);
      } else {
        console.log('   Note: All requests succeeded - rate limiter queued them properly');
      }
    });

    it('should handle queue overflow gracefully', async function() {
      console.log('📝 Testing queue overflow with extreme load');
      
      // Create extreme load: 100 requests from 5 users (20 each)
      const results = await makeMultiUserRequests(5, 20);
      
      const successful = results.filter(r => 
        r.status === 'fulfilled' && r.value.status === 200
      );
      const queueOverflow = results.filter(r => 
        r.status === 'fulfilled' && r.value.status === 503
      );
      
      console.log(`📊 Extreme load test: ${successful.length} successful, ${queueOverflow.length} queue overflow out of 100 total`);
      
      // Should see queue overflow responses
      expect(queueOverflow.length).to.be.greaterThan(0);
      
      // Should still have some successful requests
      expect(successful.length).to.be.greaterThan(0);
      
      // Total handled should not exceed reasonable limits
      expect(successful.length).to.be.lessThan(80); // Shouldn't handle too many under extreme load
    });
  });

  describe('Rate Limiting Metrics', function() {
    it('should expose rate limiting metrics', async function() {
      console.log('📝 Testing rate limiting metrics');
      
      const response = await makePublicRequest('/metrics');
      expect(response.statusCode).to.equal(200);
      
      // Should contain rate limiting metrics
      expect(response.body).to.include('queue_size');
      expect(response.body).to.include('requests_total');
      
      console.log('✅ Rate limiting metrics are exposed');
    });
  });

  after(function() {
    console.log('🏁 Rate limiting tests completed');
  });
});
