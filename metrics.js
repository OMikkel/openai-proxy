import promClient from 'prom-client';
import { getRateLimitMetrics } from './rate-limit.js';
import fs from 'fs';

// Load configuration
let config = {};
try {
  const configData = fs.readFileSync('./config.json', 'utf8');
  config = JSON.parse(configData);
} catch (error) {
  console.warn('Could not load config.json for metrics configuration:', error.message);
  config = {};
}

// Check if metrics are enabled
export function areMetricsEnabled() {
  return config.RATE_LIMITING?.metrics_enabled !== false; // Default to true if not specified
}

// Create a Registry to register metrics
const register = new promClient.Registry();

// Add default metrics (process metrics like memory, CPU, etc.)
promClient.collectDefaultMetrics({ register });

// --- Custom metrics for the OpenAI proxy ---

// Counter for total requests
const requestsTotal = new promClient.Counter({
  name: 'openai_proxy_requests_total',
  help: 'Total number of requests to the OpenAI proxy',
  labelNames: ['method', 'endpoint', 'status_code', 'user']
});

// Counter for rate limit hits (429 errors)
const rateLimitHits = new promClient.Counter({
  name: 'openai_proxy_rate_limit_hits_total',
  help: 'Total number of 429 rate limit responses from OpenAI',
  labelNames: ['user']
});

// Counter for server errors (5xx from OpenAI)
const serverErrors = new promClient.Counter({
  name: 'openai_proxy_server_errors_total',
  help: 'Total number of 5xx server errors from OpenAI',
  labelNames: ['status_code', 'user']
});

// Counter for client errors (4xx from OpenAI, excluding 429)
const clientErrors = new promClient.Counter({
  name: 'openai_proxy_client_errors_total',
  help: 'Total number of 4xx client errors from OpenAI (excluding 429)',
  labelNames: ['status_code', 'user']
});

// Histogram for request latency
const requestLatency = new promClient.Histogram({
  name: 'openai_proxy_request_duration_seconds',
  help: 'Request duration in seconds',
  labelNames: ['method', 'endpoint', 'status_code'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120] // seconds
});

// Gauge for queue sizes
const globalQueueSize = new promClient.Gauge({
  name: 'openai_proxy_global_queue_size',
  help: 'Number of requests in the global rate limit queue'
});

const globalRunningRequests = new promClient.Gauge({
  name: 'openai_proxy_global_running_requests',
  help: 'Number of currently running requests in the global limiter'
});

const globalReservoir = new promClient.Gauge({
  name: 'openai_proxy_global_reservoir_remaining',
  help: 'Remaining requests in the global rate limit reservoir'
});

const activeUserLimiters = new promClient.Gauge({
  name: 'openai_proxy_active_user_limiters',
  help: 'Number of active per-user rate limiters'
});

const totalUserQueueSize = new promClient.Gauge({
  name: 'openai_proxy_total_user_queue_size',
  help: 'Total number of requests queued across all user limiters'
});

const totalUserRunningRequests = new promClient.Gauge({
  name: 'openai_proxy_total_user_running_requests', 
  help: 'Total number of running requests across all user limiters'
});

// Counter for token usage
const tokensUsed = new promClient.Counter({
  name: 'openai_proxy_tokens_total',
  help: 'Total number of tokens used',
  labelNames: ['type', 'model', 'user'] // type: prompt, completion, total
});

// Counter for dropped requests (queue overflow)
const droppedRequests = new promClient.Counter({
  name: 'openai_proxy_dropped_requests_total',
  help: 'Total number of requests dropped due to queue overflow',
  labelNames: ['limiter_type'] // global, user
});

// Register all metrics
register.registerMetric(requestsTotal);
register.registerMetric(rateLimitHits);
register.registerMetric(serverErrors);
register.registerMetric(clientErrors);
register.registerMetric(requestLatency);
register.registerMetric(globalQueueSize);
register.registerMetric(globalRunningRequests);
register.registerMetric(globalReservoir);
register.registerMetric(activeUserLimiters);
register.registerMetric(totalUserQueueSize);
register.registerMetric(totalUserRunningRequests);
register.registerMetric(tokensUsed);
register.registerMetric(droppedRequests);

// --- Helper functions to record metrics ---

export function recordRequest(method, endpoint, statusCode, user = 'unknown') {
  const maskedUser = user.length > 8 ? user.substring(0, 8) + '...' : user;
  requestsTotal.inc({ method, endpoint, status_code: statusCode, user: maskedUser });
  
  if (statusCode === 429) {
    rateLimitHits.inc({ user: maskedUser });
  } else if (statusCode >= 500) {
    serverErrors.inc({ status_code: statusCode, user: maskedUser });
  } else if (statusCode >= 400 && statusCode !== 429) {
    clientErrors.inc({ status_code: statusCode, user: maskedUser });
  }
}

export function recordLatency(method, endpoint, statusCode, durationSeconds) {
  requestLatency.observe({ method, endpoint, status_code: statusCode }, durationSeconds);
}

export function recordTokenUsage(type, model, user, count) {
  const maskedUser = user.length > 8 ? user.substring(0, 8) + '...' : user;
  tokensUsed.inc({ type, model, user: maskedUser }, count);
}

export function recordDroppedRequest(limiterType) {
  droppedRequests.inc({ limiter_type: limiterType });
}

// Update queue metrics periodically
function updateQueueMetrics() {
  try {
    const metrics = getRateLimitMetrics();
    
    // Only set metrics if they have valid numeric values
    if (typeof metrics.global_requests_queued === 'number') {
      globalQueueSize.set(metrics.global_requests_queued);
    }
    if (typeof metrics.global_requests_running === 'number') {
      globalRunningRequests.set(metrics.global_requests_running);
    }
    if (typeof metrics.global_reservoir_remaining === 'number') {
      globalReservoir.set(metrics.global_reservoir_remaining);
    }
    if (typeof metrics.active_user_limiters === 'number') {
      activeUserLimiters.set(metrics.active_user_limiters);
    }
    if (typeof metrics.total_user_requests_queued === 'number') {
      totalUserQueueSize.set(metrics.total_user_requests_queued);
    }
    if (typeof metrics.total_user_requests_running === 'number') {
      totalUserRunningRequests.set(metrics.total_user_requests_running);
    }
  } catch (error) {
    console.error('❌ Error updating queue metrics:', error.message);
  }
}

// Update metrics every 5 seconds
const metricsInterval = setInterval(updateQueueMetrics, 5000);

// Export the register for /metrics endpoint
export async function getMetrics() {
  updateQueueMetrics(); // Update once more before returning
  return await register.metrics();
}

// Cleanup function
export function stopMetrics() {
  clearInterval(metricsInterval);
}

export { register };
