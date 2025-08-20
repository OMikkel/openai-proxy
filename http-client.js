import https from 'https';
import { promisify } from 'util';

/**
 * HTTP Client Service for OpenAI API
 * 
 * This service abstracts HTTP requests to OpenAI and can be easily mocked for testing.
 * It handles retry logic, backoff, idempotency, and error handling.
 */
class OpenAIHttpClient {
  constructor(config = {}) {
    this.host = config.host || 'api.openai.com';
    this.apiKey = config.apiKey;
    this.timeout = config.timeout || 120000;
    this.retryConfig = {
      maxRetries: config.maxRetries || 3,
      baseDelay: config.baseDelay || 1000,
      maxDelay: config.maxDelay || 30000,
      retryOn: config.retryOn || [429, 500, 502, 503, 504]
    };
    this.enableIdempotency = config.enableIdempotency !== false;
  }

  /**
   * Make an HTTP request with retry logic and backoff
   */
  async makeRequest(options, data = null) {
    const requestOptions = {
      hostname: this.host,
      path: options.path,
      method: options.method || 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        ...options.headers
      },
      timeout: options.timeout || this.timeout,
      family: 4 // Force IPv4
    };

    // Add idempotency key for retryable requests
    if (this.enableIdempotency && ['POST', 'PUT', 'PATCH'].includes(requestOptions.method)) {
      if (!requestOptions.headers['Idempotency-Key']) {
        requestOptions.headers['Idempotency-Key'] = this.generateIdempotencyKey();
      }
    }

    let lastError;
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        const result = await this.executeRequest(requestOptions, data);
        
        // Success or non-retryable error
        if (!this.shouldRetry(result.statusCode, attempt)) {
          return result;
        }
        
        // Prepare for retry
        lastError = new Error(`HTTP ${result.statusCode}: ${result.statusText}`);
        lastError.statusCode = result.statusCode;
        lastError.response = result;
        
      } catch (error) {
        lastError = error;
        
        // Don't retry on non-retryable errors
        if (!this.shouldRetryError(error, attempt)) {
          throw error;
        }
      }

      // Calculate delay for next attempt
      if (attempt < this.retryConfig.maxRetries) {
        const delay = this.calculateRetryDelay(attempt, lastError);
        console.log(`[HTTP] Retrying request in ${delay}ms (attempt ${attempt + 1}/${this.retryConfig.maxRetries})`);
        await this.sleep(delay);
      }
    }

    // All retries exhausted
    throw lastError;
  }

  /**
   * Execute a single HTTP request (without retry logic)
   */
  executeRequest(options, data) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks = [];
        
        res.on('data', (chunk) => {
          chunks.push(chunk);
        });
        
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            data: buffer,
            text: buffer.toString(),
            json: () => {
              try {
                return JSON.parse(buffer.toString());
              } catch (e) {
                throw new Error('Response is not valid JSON');
              }
            }
          });
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        const timeoutError = new Error('Request timeout');
        timeoutError.code = 'TIMEOUT';
        reject(timeoutError);
      });

      // Send data if provided
      if (data) {
        if (Buffer.isBuffer(data)) {
          req.write(data);
        } else if (typeof data === 'string') {
          req.write(data);
        } else {
          req.write(JSON.stringify(data));
        }
      }

      req.end();
    });
  }

  /**
   * Determine if we should retry based on status code and attempt number
   */
  shouldRetry(statusCode, attempt) {
    return attempt < this.retryConfig.maxRetries && 
           this.retryConfig.retryOn.includes(statusCode);
  }

  /**
   * Determine if we should retry based on error type and attempt number
   */
  shouldRetryError(error, attempt) {
    if (attempt >= this.retryConfig.maxRetries) {
      return false;
    }

    // Retry on network errors, timeouts, etc.
    const retryableErrorCodes = ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'TIMEOUT'];
    return retryableErrorCodes.includes(error.code);
  }

  /**
   * Calculate delay for retry with exponential backoff
   */
  calculateRetryDelay(attempt, lastError) {
    // Check for Retry-After header first
    if (lastError?.response?.headers?.['retry-after']) {
      const retryAfter = parseInt(lastError.response.headers['retry-after'], 10);
      if (!isNaN(retryAfter)) {
        return Math.min(retryAfter * 1000, this.retryConfig.maxDelay);
      }
    }

    // Exponential backoff: baseDelay * 2^attempt + jitter
    const exponentialDelay = this.retryConfig.baseDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 1000; // Add up to 1 second of jitter
    const delay = exponentialDelay + jitter;

    return Math.min(delay, this.retryConfig.maxDelay);
  }

  /**
   * Generate a unique idempotency key
   */
  generateIdempotencyKey() {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * Sleep for specified milliseconds
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Make a JSON request to OpenAI
   */
  async makeJsonRequest(path, data, options = {}) {
    const requestOptions = {
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(data)),
        ...options.headers
      },
      ...options
    };

    const response = await this.makeRequest(requestOptions, JSON.stringify(data));
    
    if (response.statusCode >= 400) {
      const error = new Error(`HTTP ${response.statusCode}: ${response.statusText}`);
      error.statusCode = response.statusCode;
      error.response = response;
      try {
        error.details = response.json();
      } catch (e) {
        error.details = { message: response.text };
      }
      throw error;
    }

    return response;
  }

  /**
   * Make a multipart request to OpenAI
   */
  async makeMultipartRequest(path, bodyBuffer, boundary, options = {}) {
    const requestOptions = {
      path,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(bodyBuffer),
        ...options.headers
      },
      timeout: options.timeout || 30000, // Shorter timeout for audio
      ...options
    };

    const response = await this.makeRequest(requestOptions, bodyBuffer);
    
    if (response.statusCode >= 400) {
      const error = new Error(`HTTP ${response.statusCode}: ${response.statusText}`);
      error.statusCode = response.statusCode;
      error.response = response;
      try {
        error.details = response.json();
      } catch (e) {
        error.details = { message: response.text };
      }
      throw error;
    }

    return response;
  }
}

/**
 * Mock HTTP Client for Testing
 * 
 * This mock allows you to simulate various scenarios without making real HTTP requests.
 */
class MockOpenAIHttpClient {
  constructor(config = {}) {
    this.scenarios = new Map();
    this.requestLog = [];
    this.defaultResponse = {
      statusCode: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      data: Buffer.from('{"mock": true}'),
      text: '{"mock": true}',
      json: () => ({ mock: true })
    };
  }

  /**
   * Configure a scenario for specific endpoints
   */
  setScenario(pathPattern, scenario) {
    this.scenarios.set(pathPattern, scenario);
  }

  /**
   * Clear all scenarios and request logs
   */
  clearScenarios() {
    this.scenarios.clear();
    this.requestLog = [];
  }

  /**
   * Get request history
   */
  getRequestLog() {
    return [...this.requestLog];
  }

  /**
   * Count requests matching a pattern
   */
  countRequests(pathPattern = null) {
    if (!pathPattern) return this.requestLog.length;
    return this.requestLog.filter(log => log.path.includes(pathPattern)).length;
  }

  /**
   * Mock the makeRequest method
   */
  async makeRequest(options, data = null) {
    // Log the request
    const logEntry = {
      timestamp: new Date().toISOString(),
      path: options.path,
      method: options.method,
      headers: options.headers,
      data: data,
      idempotencyKey: options.headers?.['Idempotency-Key']
    };
    this.requestLog.push(logEntry);

    // Find matching scenario
    const scenario = this.findScenario(options.path);
    
    if (scenario) {
      return this.executeScenario(scenario, options, data);
    }

    // Return default success response
    return this.defaultResponse;
  }

  /**
   * Find scenario matching the request path
   */
  findScenario(path) {
    // Check for exact match first
    if (this.scenarios.has(path)) {
      return this.scenarios.get(path);
    }

    // Check for pattern matches
    for (const [pattern, scenario] of this.scenarios.entries()) {
      if (pattern === '*' || path.includes(pattern)) {
        return scenario;
      }
    }

    return null;
  }

  /**
   * Execute a mock scenario
   */
  async executeScenario(scenario, options, data) {
    // Apply delay if configured
    if (scenario.delay) {
      await this.sleep(scenario.delay);
    }

    // Handle different scenario types
    switch (scenario.type) {
      case 'success':
        return this.createResponse(200, scenario.response || this.defaultResponse.json());

      case 'rate_limit':
        const retryAfter = scenario.retryAfter || 1;
        return this.createResponse(429, {
          error: {
            message: 'Rate limit exceeded',
            type: 'rate_limit_exceeded',
            code: 'rate_limit_exceeded'
          }
        }, { 'retry-after': retryAfter.toString() });

      case 'server_error':
        return this.createResponse(scenario.statusCode || 500, {
          error: {
            message: 'Internal server error',
            type: 'server_error',
            code: 'server_error'
          }
        });

      case 'timeout':
        const error = new Error('Request timeout');
        error.code = 'TIMEOUT';
        throw error;

      case 'network_error':
        const networkError = new Error('Network error');
        networkError.code = scenario.errorCode || 'ECONNRESET';
        throw networkError;

      case 'fail_then_succeed':
        // Decrement failure counter
        if (scenario.remainingFailures > 0) {
          scenario.remainingFailures--;
          return this.createResponse(scenario.failureStatusCode || 500, {
            error: { message: 'Temporary failure' }
          });
        } else {
          return this.createResponse(200, scenario.successResponse || this.defaultResponse.json());
        }

      default:
        return this.createResponse(scenario.statusCode || 200, scenario.response || this.defaultResponse.json());
    }
  }

  /**
   * Create a mock response object
   */
  createResponse(statusCode, body, headers = {}) {
    const jsonBody = typeof body === 'string' ? body : JSON.stringify(body);
    const buffer = Buffer.from(jsonBody);
    
    return {
      statusCode,
      statusText: this.getStatusText(statusCode),
      headers: {
        'content-type': 'application/json',
        ...headers
      },
      data: buffer,
      text: jsonBody,
      json: () => typeof body === 'string' ? JSON.parse(body) : body
    };
  }

  /**
   * Get HTTP status text
   */
  getStatusText(statusCode) {
    const statusTexts = {
      200: 'OK',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
      504: 'Gateway Timeout'
    };
    return statusTexts[statusCode] || 'Unknown';
  }

  /**
   * Mock JSON request
   */
  async makeJsonRequest(path, data, options = {}) {
    const requestOptions = {
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(data)),
        ...options.headers
      },
      ...options
    };

    return this.makeRequest(requestOptions, JSON.stringify(data));
  }

  /**
   * Mock multipart request
   */
  async makeMultipartRequest(path, bodyBuffer, boundary, options = {}) {
    const requestOptions = {
      path,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': Buffer.byteLength(bodyBuffer),
        ...options.headers
      },
      ...options
    };

    return this.makeRequest(requestOptions, bodyBuffer);
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export { OpenAIHttpClient, MockOpenAIHttpClient };
