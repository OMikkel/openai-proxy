import { HttpTransport } from '../http-client.js';

/**
 * Mock HTTP Transport - returns configured fake responses for testing
 * This mock transport simulates HTTP responses without retry logic.
 */
class MockHttpTransport extends HttpTransport {
  constructor() {
    super();
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

  async executeRequest(options, data) {
    // Log the request
    const logEntry = {
      timestamp: new Date().toISOString(),
      path: options.path,
      method: options.method || 'POST',
      headers: options.headers || {},
      data: data
    };
    this.requestLog.push(logEntry);

    // Find and execute scenario
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
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export { MockHttpTransport };
