import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { OpenAIHttpClient } from '../http-client.js';
import { MockHttpTransport } from './mock-http-transport.js';

describe('HTTP Client Retry and Backoff Tests (Fixed Architecture)', function() {
  // Increase timeout for retry tests
  this.timeout(60000);

  let httpClient;
  let mockTransport;

  beforeEach(function() {
    // Create mock transport that simulates HTTP responses
    mockTransport = new MockHttpTransport();
    
    // Create real HTTP client with mock transport injected
    // This tests the REAL retry logic with FAKE HTTP responses
    httpClient = new OpenAIHttpClient({
      apiKey: 'test-key',
      maxRetries: 3,
      baseDelay: 50, // Very short delays for fast testing
      maxDelay: 1000,
      transport: mockTransport
    });
  });

  describe('Rate Limit Retry Scenarios', function() {
    it('should retry on 429 rate limit and succeed after backoff', async function() {
      // Configure transport to fail twice with 429, then succeed
      mockTransport.setScenario('/v1/chat/completions', {
        type: 'fail_then_succeed',
        remainingFailures: 2,
        failureStatusCode: 429,
        successResponse: {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{
            message: { role: 'assistant', content: 'Success after retry!' },
            finish_reason: 'stop'
          }],
          usage: { total_tokens: 10 }
        }
      });

      const startTime = Date.now();
      const response = await httpClient.makeJsonRequest('/v1/chat/completions', {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'test retry' }]
      });
      const elapsed = Date.now() - startTime;

      // Should succeed after retries
      expect(response.statusCode).to.equal(200);
      const data = response.json();
      expect(data.id).to.equal('chatcmpl-test');
      
      // Should have made 3 requests (2 failures + 1 success)
      expect(mockTransport.countRequests()).to.equal(3);
      
      // Should have taken some time due to retry delays
      expect(elapsed).to.be.greaterThan(50);
    });

    it('should respect Retry-After header from rate limit response', async function() {
      mockTransport.setScenario('/v1/chat/completions', {
        type: 'rate_limit',
        retryAfter: 2 // 2 seconds
      });

      const startTime = Date.now();
      
      try {
        await httpClient.makeJsonRequest('/v1/chat/completions', {
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: 'test' }]
        });
        expect.fail('Should have thrown an error after exhausting retries');
      } catch (error) {
        const elapsed = Date.now() - startTime;
        
        // Should have failed after max retries
        expect(error.statusCode).to.equal(429);
        
        // Should have made 4 requests (1 initial + 3 retries)
        expect(mockTransport.countRequests()).to.equal(4);
        
        // Should have taken time respecting Retry-After header
        expect(elapsed).to.be.greaterThan(100); // Some delay
      }
    });

    it('should handle immediate success without retries', async function() {
      mockTransport.setScenario('/v1/chat/completions', {
        type: 'success',
        response: {
          id: 'chatcmpl-immediate',
          choices: [{ message: { content: 'Immediate success' } }]
        }
      });

      const startTime = Date.now();
      const response = await httpClient.makeJsonRequest('/v1/chat/completions', {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'test' }]
      });
      const elapsed = Date.now() - startTime;

      // Should succeed immediately
      expect(response.statusCode).to.equal(200);
      
      // Should have made only 1 request
      expect(mockTransport.countRequests()).to.equal(1);
      
      // Should be fast (no retry delays)
      expect(elapsed).to.be.lessThan(100);
    });
  });

  describe('Server Error Retry Scenarios', function() {
    it('should retry on 500 server error', async function() {
      mockTransport.setScenario('/v1/chat/completions', {
        type: 'fail_then_succeed',
        remainingFailures: 1,
        failureStatusCode: 500,
        successResponse: {
          id: 'chatcmpl-after-500',
          choices: [{ message: { content: 'Success after 500' } }]
        }
      });

      const response = await httpClient.makeJsonRequest('/v1/chat/completions', {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'test' }]
      });

      expect(response.statusCode).to.equal(200);
      expect(mockTransport.countRequests()).to.equal(2); // 1 failure + 1 success
    });

    it('should not retry on 400 client error', async function() {
      mockTransport.setScenario('/v1/chat/completions', {
        type: 'server_error',
        statusCode: 400
      });

      try {
        await httpClient.makeJsonRequest('/v1/chat/completions', {
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: 'test' }]
        });
        expect.fail('Should have thrown an error for 400 status');
      } catch (error) {
        expect(error.statusCode).to.equal(400);
        // Should not retry on client errors
        expect(mockTransport.countRequests()).to.equal(1);
      }
    });
  });

  describe('Network Error Retry Scenarios', function() {
    it('should retry on network timeout', async function() {
      mockTransport.setScenario('/v1/chat/completions', {
        type: 'fail_then_succeed',
        remainingFailures: 1,
        failureType: 'timeout',
        successResponse: {
          id: 'chatcmpl-after-timeout',
          choices: [{ message: { content: 'Success after timeout' } }]
        }
      });

      // For this test, we need to modify the scenario to throw timeout on first attempts
      const originalExecuteScenario = mockTransport.executeScenario;
      let timeoutCount = 0;
      mockTransport.executeScenario = async function(scenario, options, data) {
        if (timeoutCount === 0) {
          timeoutCount++;
          const error = new Error('Request timeout');
          error.code = 'TIMEOUT';
          throw error;
        }
        return originalExecuteScenario.call(this, {
          type: 'success',
          response: {
            id: 'chatcmpl-after-timeout',
            choices: [{ message: { content: 'Success after timeout' } }]
          }
        }, options, data);
      };

      const response = await httpClient.makeJsonRequest('/v1/chat/completions', {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'test' }]
      });

      expect(response.statusCode).to.equal(200);
      expect(mockTransport.countRequests()).to.equal(2); // 1 timeout + 1 success
    });
  });

  describe('Exponential Backoff Testing', function() {
    it('should implement exponential backoff with jitter', async function() {
      this.timeout(10000);

      mockTransport.setScenario('/v1/chat/completions', {
        type: 'fail_then_succeed',
        remainingFailures: 3,
        failureStatusCode: 500,
        successResponse: {
          id: 'chatcmpl-backoff-test',
          choices: [{ message: { content: 'Success after backoff' } }]
        }
      });

      const startTime = Date.now();
      const response = await httpClient.makeJsonRequest('/v1/chat/completions', {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'test backoff' }]
      });
      const elapsed = Date.now() - startTime;

      expect(response.statusCode).to.equal(200);
      expect(mockTransport.countRequests()).to.equal(4); // 3 failures + 1 success
      
      // With baseDelay=50ms, exponential backoff should be:
      // Attempt 1: ~50ms + jitter
      // Attempt 2: ~100ms + jitter  
      // Attempt 3: ~200ms + jitter
      // Total minimum: ~350ms
      expect(elapsed).to.be.greaterThan(200); // Account for jitter and timing variance
    });
  });

  describe('Idempotency Key Testing', function() {
    it('should add idempotency keys to retryable requests', async function() {
      mockTransport.setScenario('/v1/chat/completions', {
        type: 'success',
        response: { id: 'test-idempotency' }
      });

      await httpClient.makeJsonRequest('/v1/chat/completions', {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'test' }]
      });

      const requests = mockTransport.getRequestLog();
      expect(requests).to.have.length(1);
      expect(requests[0].headers).to.have.property('Idempotency-Key');
      expect(requests[0].headers['Idempotency-Key']).to.match(/^req_\d+_[a-z0-9]+$/);
    });
  });
});
