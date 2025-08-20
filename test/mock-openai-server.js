import express from 'express';
import { createServer } from 'http';

/**
 * Mock OpenAI Server for Testing Retry & Backoff Logic
 * 
 * This server simulates various failure scenarios:
 * - 429 Rate Limit with Retry-After headers
 * - 5xx Server Errors (500, 502, 503, 504)
 * - Network timeouts and connection issues
 * - Successful responses after retries
 * - Idempotency key handling
 */
class MockOpenAIServer {
  constructor(port = 3001) {
    this.port = port;
    this.app = express();
    this.server = null;
    this.requestLog = [];
    this.scenarios = new Map();
    this.globalConfig = {
      defaultDelay: 0,
      defaultRetryAfter: 1
    };
    
    this.setupRoutes();
  }

  setupRoutes() {
    // Parse JSON bodies
    this.app.use(express.json({ limit: '50mb' }));
    
    // Parse multipart/form-data for audio endpoints
    this.app.use(express.raw({ type: 'multipart/form-data', limit: '50mb' }));
    
    // Log all requests
    this.app.use((req, res, next) => {
      const timestamp = new Date().toISOString();
      const logEntry = {
        timestamp,
        method: req.method,
        url: req.url,
        headers: req.headers,
        idempotencyKey: req.headers['idempotency-key'],
        userAgent: req.headers['user-agent']
      };
      this.requestLog.push(logEntry);
      console.log(`[MOCK] ${timestamp} ${req.method} ${req.url} (Idempotency: ${logEntry.idempotencyKey || 'none'})`);
      next();
    });

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        scenarios: Array.from(this.scenarios.keys()),
        requestCount: this.requestLog.length 
      });
    });

    // Scenario management endpoints
    this.app.post('/mock/scenario/:endpoint', (req, res) => {
      const endpoint = req.params.endpoint;
      const scenario = req.body;
      this.scenarios.set(endpoint, scenario);
      res.json({ message: `Scenario set for ${endpoint}`, scenario });
    });

    this.app.get('/mock/scenarios', (req, res) => {
      const scenarios = {};
      for (const [key, value] of this.scenarios.entries()) {
        scenarios[key] = value;
      }
      res.json({ scenarios, requestLog: this.requestLog.slice(-10) });
    });

    this.app.delete('/mock/scenarios', (req, res) => {
      this.scenarios.clear();
      this.requestLog = [];
      res.json({ message: 'All scenarios and logs cleared' });
    });

    // OpenAI API endpoints with scenario simulation
    this.setupOpenAIEndpoints();
  }

  setupOpenAIEndpoints() {
    // Chat completions endpoint
    this.app.post('/v1/chat/completions', (req, res) => {
      this.handleScenario('/v1/chat/completions', req, res, () => {
        // Successful response
        res.json({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: req.body.model || 'gpt-4',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: 'This is a mock response from the test server.'
            },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 12,
            total_tokens: 22
          }
        });
      });
    });

    // Completions endpoint
    this.app.post('/v1/completions', (req, res) => {
      this.handleScenario('/v1/completions', req, res, () => {
        res.json({
          id: `cmpl-${Date.now()}`,
          object: 'text_completion',
          created: Math.floor(Date.now() / 1000),
          model: req.body.model || 'gpt-3.5-turbo-instruct',
          choices: [{
            text: 'This is a mock completion response.',
            index: 0,
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 8,
            total_tokens: 16
          }
        });
      });
    });

    // Embeddings endpoint
    this.app.post('/v1/embeddings', (req, res) => {
      this.handleScenario('/v1/embeddings', req, res, () => {
        const inputArray = Array.isArray(req.body.input) ? req.body.input : [req.body.input];
        res.json({
          object: 'list',
          data: inputArray.map((input, index) => ({
            object: 'embedding',
            index: index,
            embedding: new Array(1536).fill(0).map(() => Math.random() - 0.5)
          })),
          model: req.body.model || 'text-embedding-ada-002',
          usage: {
            prompt_tokens: inputArray.join(' ').split(' ').length,
            total_tokens: inputArray.join(' ').split(' ').length
          }
        });
      });
    });

    // Audio transcription endpoint
    this.app.post('/v1/audio/transcriptions', (req, res) => {
      this.handleScenario('/v1/audio/transcriptions', req, res, () => {
        res.json({
          text: 'This is a mock transcription of the uploaded audio file.'
        });
      });
    });

    // Audio speech endpoint
    this.app.post('/v1/audio/speech', (req, res) => {
      this.handleScenario('/v1/audio/speech', req, res, () => {
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', '1024');
        // Send mock audio data
        res.send(Buffer.alloc(1024, 0));
      });
    });
  }

  handleScenario(endpoint, req, res, successCallback) {
    const scenario = this.scenarios.get(endpoint) || this.scenarios.get('*');
    
    if (!scenario) {
      // No scenario configured, execute success callback
      return successCallback();
    }

    // Apply delay if configured
    const delay = scenario.delay || this.globalConfig.defaultDelay;
    
    setTimeout(() => {
      this.executeScenario(scenario, req, res, successCallback);
    }, delay);
  }

  executeScenario(scenario, req, res, successCallback) {
    const { type, statusCode, retryAfter, headers = {}, body, count = 1 } = scenario;

    // Check if this is a counted scenario (fail N times then succeed)
    if (scenario.remainingFailures > 0) {
      scenario.remainingFailures--;
      this.executeFailureScenario(scenario, req, res);
      return;
    }

    // If we've exhausted failures, or no failure count, check scenario type
    switch (type) {
      case 'success':
        successCallback();
        break;

      case 'rate_limit':
        res.setHeader('Retry-After', retryAfter || this.globalConfig.defaultRetryAfter);
        res.status(429).json({
          error: {
            message: 'Rate limit exceeded',
            type: 'rate_limit_exceeded',
            code: 'rate_limit_exceeded'
          }
        });
        break;

      case 'server_error':
        const status = statusCode || 500;
        res.status(status).json({
          error: {
            message: 'Internal server error',
            type: 'server_error',
            code: 'server_error'
          }
        });
        break;

      case 'timeout':
        // Don't respond, let the request timeout
        console.log('[MOCK] Simulating timeout - not responding');
        break;

      case 'connection_error':
        // Close the connection abruptly
        req.socket.destroy();
        break;

      case 'custom':
        // Custom response
        Object.keys(headers).forEach(key => {
          res.setHeader(key, headers[key]);
        });
        res.status(statusCode || 200);
        if (body) {
          res.send(body);
        } else {
          res.end();
        }
        break;

      case 'fail_then_succeed':
        // This scenario was set up with remainingFailures, 
        // so if we reach here, all failures are done
        successCallback();
        break;

      default:
        successCallback();
    }
  }

  executeFailureScenario(scenario, req, res) {
    const { failureType = 'rate_limit', statusCode = 429, retryAfter } = scenario;
    
    switch (failureType) {
      case 'rate_limit':
        res.setHeader('Retry-After', retryAfter || this.globalConfig.defaultRetryAfter);
        res.status(429).json({
          error: {
            message: 'Rate limit exceeded',
            type: 'rate_limit_exceeded',
            code: 'rate_limit_exceeded'
          }
        });
        break;

      case 'server_error':
        res.status(statusCode || 500).json({
          error: {
            message: 'Internal server error',
            type: 'server_error',
            code: 'server_error'
          }
        });
        break;

      case 'timeout':
        console.log('[MOCK] Simulating timeout failure - not responding');
        break;

      default:
        res.status(500).json({
          error: {
            message: 'Unknown failure type',
            type: 'server_error',
            code: 'server_error'
          }
        });
    }
  }

  // Scenario configuration helpers
  setScenario(endpoint, scenario) {
    // If scenario has a failure count, set up remainingFailures
    if (scenario.failCount) {
      scenario.remainingFailures = scenario.failCount;
    }
    this.scenarios.set(endpoint, scenario);
  }

  clearScenarios() {
    this.scenarios.clear();
    this.requestLog = [];
  }

  getRequestLog() {
    return [...this.requestLog];
  }

  getLastRequest() {
    return this.requestLog[this.requestLog.length - 1];
  }

  countRequests(endpoint = null) {
    if (!endpoint) return this.requestLog.length;
    return this.requestLog.filter(log => log.url.includes(endpoint)).length;
  }

  // Server lifecycle
  async start() {
    return new Promise((resolve, reject) => {
      this.server = createServer(this.app);
      this.server.listen(this.port, (err) => {
        if (err) {
          reject(err);
        } else {
          console.log(`🎭 Mock OpenAI server running on port ${this.port}`);
          resolve();
        }
      });
    });
  }

  async stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('🎭 Mock OpenAI server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

export default MockOpenAIServer;
