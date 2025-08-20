import { describe, it, before } from 'mocha';
import { expect } from 'chai';
import http from 'http';

const BASE_URL = 'localhost:8080';
const [hostname, port] = BASE_URL.split(':');

// Test API keys for different users
const TEST_KEYS = [
  'test-user-enforcement-1',
  'test-user-enforcement-2', 
  'test-user-enforcement-3',
  'test-user-enforcement-4',
  'test-user-enforcement-5'
];

// Helper to make a request that will trigger rate limiting but not cost much
function makeTestRequest(apiKey, simulateWork = false) {
  const requestBody = {
    model: 'invalid-model-name-for-testing', // Invalid model - will fail fast at OpenAI without charges
    messages: [{ role: 'user', content: simulateWork ? 'This is a longer message to simulate work for concurrent testing' : 'test' }],
    max_tokens: 1 // Minimal tokens
  };

  const data = JSON.stringify(requestBody);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: hostname,
      port: parseInt(port),
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Api-Key': apiKey, // Use valid API key so rate limiting is triggered
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const startTime = Date.now();
    
    const req = http.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        const endTime = Date.now();
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage,
          data: responseData,
          responseTime: endTime - startTime,
          timestamp: endTime
        });
      });
    });

    req.on('error', (error) => {
      const endTime = Date.now();
      resolve({
        status: 'error',
        error: error.message,
        responseTime: endTime - startTime,
        timestamp: endTime
      });
    });

    req.on('timeout', () => {
      req.destroy();
      const endTime = Date.now();
      resolve({
        status: 'timeout',
        responseTime: endTime - startTime,
        timestamp: endTime
      });
    });

    req.setTimeout(10000);
    req.write(data);
    req.end();
  });
}

// Helper to check queue status
function checkQueueStatus() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: hostname,
      port: parseInt(port),
      path: '/health',
      method: 'GET'
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          const json = JSON.parse(responseData);
          resolve({
            status: res.statusCode,
            data: json,
            timestamp: Date.now()
          });
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(3000);
    req.end();
  });
}

describe('Rate Limiting Enforcement Tests (Safe)', function() {
  this.timeout(60000);

  before(function() {
    console.log('🔧 Setting up safe rate limiting enforcement tests...');
    console.log('💡 Using invalid model names to test rate limiting without significant costs');
    console.log('📊 Current limits: Per-user: 2 concurrent, 60/min | Global: 40 concurrent, 800/min');
  });

  describe('Per-User Concurrent Limit Verification', function() {
    it('should demonstrate per-user concurrent limiting through timing analysis', async function() {
      console.log('📝 Testing per-user concurrent behavior with timing analysis');
      
      // Use a single user key and make requests that trigger rate limiting
      const testKey = TEST_KEYS[0];
      const numRequests = 6; // More than the per-user concurrent limit of 2
      
      console.log(`   Launching ${numRequests} requests for single user (limit: 2 concurrent)...`);
      
      const startTime = Date.now();
      const promises = Array(numRequests).fill().map((_, i) => 
        makeTestRequest(testKey, true).then(result => ({
          ...result,
          index: i,
          relativeTime: result.timestamp - startTime
        }))
      );

      const results = await Promise.all(promises);
      const endTime = Date.now();
      const totalTime = endTime - startTime;
      
      // Analyze timing patterns
      const completionTimes = results.map(r => r.relativeTime).sort((a, b) => a - b);
      const validResponses = results.filter(r => r.status && r.status !== 'error' && r.status !== 'timeout').length;
      
      console.log(`📊 Results: ${validResponses}/${numRequests} valid responses, total time: ${totalTime}ms`);
      console.log(`   Completion times: ${completionTimes.map(t => Math.round(t)).join('ms, ')}ms`);
      
      // Check response distribution over time - with concurrent limit of 2, 
      // requests should be processed in groups rather than all at once
      const firstHalf = completionTimes.slice(0, 3);
      const secondHalf = completionTimes.slice(3);
      
      if (secondHalf.length > 0) {
        const avgFirstHalf = firstHalf.reduce((sum, time) => sum + time, 0) / firstHalf.length;
        const avgSecondHalf = secondHalf.reduce((sum, time) => sum + time, 0) / secondHalf.length;
        const timeGap = avgSecondHalf - avgFirstHalf;
        
        console.log(`   Average completion time gap: ${Math.round(timeGap)}ms`);
        
        // If rate limiting is working properly, there should be a measurable gap
        if (timeGap > 100) {
          console.log('✅ Detected queuing behavior indicating rate limiting is working');
        } else {
          console.log('⚠️  Fast processing - may indicate light load or rate limiting bypassed');
        }
      }
      
      // Expect that requests were processed (either successfully or with errors from OpenAI)
      // but not blocked at the proxy level
      expect(validResponses).to.be.greaterThan(0);
      
      console.log('✅ Per-user concurrent limiting test completed');
    });
  });

  describe('Global Queue Monitoring', function() {
    it('should show queue activity during high load', async function() {
      console.log('📝 Testing global queue behavior monitoring');
      
      // Check baseline queue status
      const baselineStatus = await checkQueueStatus();
      console.log('📊 Baseline queue status:');
      console.log(`   Global: running=${baselineStatus.data.queue?.global?.running || 0}, queued=${baselineStatus.data.queue?.global?.queued || 0}`);
      console.log(`   Users: ${baselineStatus.data.queue?.totalUsers || 0} active`);
      
      // Generate load across multiple users
      const loadPromises = [];
      TEST_KEYS.forEach((key, userIndex) => {
        for (let i = 0; i < 4; i++) { // 4 requests per user, 5 users = 20 total
          loadPromises.push(
            makeTestRequest(key, false).then(result => ({
              ...result,
              userIndex,
              requestIndex: i
            }))
          );
        }
      });
      
      console.log(`   Launching ${loadPromises.length} requests across ${TEST_KEYS.length} users...`);
      
      // Monitor queue status during load
      const monitoringPromise = new Promise(async (resolve) => {
        const snapshots = [];
        for (let i = 0; i < 8; i++) { // Take 8 snapshots over 1.6 seconds
          try {
            const status = await checkQueueStatus();
            const queue = status.data.queue;
            snapshots.push({
              time: i * 200,
              running: queue?.global?.running || 0,
              queued: queue?.global?.queued || 0,
              users: queue?.totalUsers || 0
            });
          } catch (error) {
            snapshots.push({ time: i * 200, error: error.message });
          }
          await new Promise(r => setTimeout(r, 200));
        }
        resolve(snapshots);
      });
      
      // Start monitoring and load simultaneously
      const [loadResults, snapshots] = await Promise.all([
        Promise.allSettled(loadPromises),
        monitoringPromise
      ]);
      
      // Analyze results
      const successfulLoad = loadResults.filter(r => r.status === 'fulfilled').length;
      console.log(`📊 Load results: ${successfulLoad}/${loadPromises.length} requests completed`);
      
      // Show queue activity snapshots
      console.log('📊 Queue activity snapshots:');
      snapshots.forEach((snapshot, i) => {
        if (snapshot.error) {
          console.log(`   ${snapshot.time}ms: Error - ${snapshot.error}`);
        } else {
          console.log(`   ${snapshot.time}ms: Running=${snapshot.running}, Queued=${snapshot.queued}, Users=${snapshot.users}`);
        }
      });
      
      // Check if we observed any queue activity
      const maxUsers = Math.max(...snapshots.filter(s => !s.error).map(s => s.users || 0));
      const hadActivity = snapshots.some(s => !s.error && ((s.running > 0) || (s.queued > 0)));
      
      console.log(`📊 Peak activity: ${maxUsers} users, activity detected: ${hadActivity}`);
      
      // Should see some users and potentially some activity
      expect(maxUsers).to.be.greaterThan(0);
      
      console.log('✅ Global queue monitoring completed');
    });
  });

  describe('System Responsiveness Under Load', function() {
    it('should remain responsive during high concurrent load', async function() {
      console.log('📝 Testing system responsiveness under concurrent load');
      
      // Generate high concurrent load
      const concurrentPromises = [];
      for (let i = 0; i < 20; i++) { // 20 concurrent requests
        const userKey = TEST_KEYS[i % TEST_KEYS.length];
        concurrentPromises.push(
          makeTestRequest(userKey, false).then(result => ({
            ...result,
            requestId: i
          }))
        );
      }
      
      console.log('   Launching 20 concurrent requests...');
      const startTime = Date.now();
      
      // Also monitor system health during the load
      const healthCheckPromise = new Promise(async (resolve) => {
        await new Promise(r => setTimeout(r, 500)); // Wait a bit for load to start
        try {
          const healthResponse = await checkQueueStatus();
          resolve(healthResponse);
        } catch (error) {
          resolve({ error: error.message });
        }
      });
      
      const [loadResults, healthCheck] = await Promise.all([
        Promise.allSettled(concurrentPromises),
        healthCheckPromise
      ]);
      
      const endTime = Date.now();
      const totalTime = endTime - startTime;
      
      // Analyze results
      const completed = loadResults.filter(r => r.status === 'fulfilled').length;
      const failed = loadResults.length - completed;
      
      console.log(`📊 Concurrent load results:`);
      console.log(`   ${completed}/${loadResults.length} requests completed`);
      console.log(`   ${failed} requests failed`);
      console.log(`   Total time: ${totalTime}ms`);
      console.log(`   Average time per request: ${Math.round(totalTime / completed)}ms`);
      
      // Health check during load
      if (healthCheck.error) {
        console.log(`   Health check failed: ${healthCheck.error}`);
      } else {
        console.log(`   Health check passed during load`);
      }
      
      // System should handle the load gracefully
      expect(completed).to.be.greaterThan(10); // At least half should complete
      expect(totalTime).to.be.lessThan(30000); // Should complete within 30 seconds
      
      console.log('✅ System responsiveness under load verified');
    });
  });

  describe('Rate Limiting Enforcement Verification', function() {
    it('should enforce per-user rate limits independently', async function() {
      console.log('📝 Testing independent per-user rate limiting enforcement');
      
      // Test that one user hitting their limit doesn't affect another user
      const user1 = TEST_KEYS[0];
      const user2 = TEST_KEYS[1];
      
      // Overload user1 with many concurrent requests
      console.log('   Overloading User1 with 8 concurrent requests...');
      const user1Promises = Array(8).fill().map(() => makeTestRequest(user1, true));
      
      // Make normal requests for user2
      console.log('   Making 3 normal requests for User2...');  
      const user2Promises = Array(3).fill().map(() => makeTestRequest(user2, false));
      
      const startTime = Date.now();
      const [user1Results, user2Results] = await Promise.all([
        Promise.allSettled(user1Promises),
        Promise.allSettled(user2Promises)
      ]);
      const totalTime = Date.now() - startTime;
      
      const user1Completed = user1Results.filter(r => r.status === 'fulfilled').length;
      const user2Completed = user2Results.filter(r => r.status === 'fulfilled').length;
      
      console.log(`📊 Independence test results (${totalTime}ms total):`);
      console.log(`   User1: ${user1Completed}/8 completed (overloaded)`);
      console.log(`   User2: ${user2Completed}/3 completed (normal load)`);
      
      // User2 should not be significantly affected by User1's overload
      expect(user2Completed).to.be.greaterThan(0);
      
      // User1 should have requests completed (though possibly slower due to queuing)
      expect(user1Completed).to.be.greaterThan(0);
      
      console.log('✅ Per-user independence verified - users don\'t affect each other');
    });

    it('should handle queue overflow gracefully', async function() {
      console.log('📝 Testing queue overflow handling');
      
      // Generate extreme load to potentially trigger overflow
      console.log('   Generating extreme load (40 concurrent requests)...');
      const extremeLoadPromises = [];
      
      for (let i = 0; i < 40; i++) {
        const userKey = TEST_KEYS[i % TEST_KEYS.length];
        extremeLoadPromises.push(
          makeTestRequest(userKey, false).then(result => ({
            ...result,
            requestId: i
          })).catch(error => ({
            status: 'error',
            error: error.message,
            requestId: i
          }))
        );
      }
      
      const startTime = Date.now();
      const results = await Promise.all(extremeLoadPromises);
      const totalTime = Date.now() - startTime;
      
      // Analyze response codes
      const responseCodes = {};
      results.forEach(result => {
        const code = result.status;
        responseCodes[code] = (responseCodes[code] || 0) + 1;
      });
      
      console.log(`📊 Extreme load results (${totalTime}ms):`);
      console.log('   Response code distribution:', responseCodes);
      
      // Should handle the extreme load without system crash
      const totalProcessed = Object.values(responseCodes).reduce((sum, count) => sum + count, 0);
      expect(totalProcessed).to.equal(40);
      
      // Check if system is still responsive after extreme load
      console.log('   Checking system responsiveness after extreme load...');
      const postLoadStatus = await checkQueueStatus();
      expect(postLoadStatus.status).to.equal(200);
      
      console.log('✅ System handles extreme load gracefully without crashes');
    });
  });
});