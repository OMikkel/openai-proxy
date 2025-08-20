import Bottleneck from 'bottleneck';
import fs from 'fs';

// Load configuration
let config;
try {
  config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
} catch (error) {
  console.error('Failed to load config.json, using default rate limiting settings:', error.message);
  config = {
    RATE_LIMITING: {
      global: {
        requests_per_minute: 800,
        concurrent_limit: 40,
        queue_size: 100
      },
      per_user: {
        requests_per_minute: 60,
        concurrent_limit: 2,
        queue_size: 10
      },
      enabled: true,
      metrics_enabled: true
    }
  };
}

const rateLimitConfig = config.RATE_LIMITING || {
  global: { requests_per_minute: 800, concurrent_limit: 40, queue_size: 100 },
  per_user: { requests_per_minute: 60, concurrent_limit: 2, queue_size: 10 },
  enabled: true,
  metrics_enabled: true
};

// Global rate limiter - configurable limits
const globalLimiter = new Bottleneck({
  reservoir: rateLimitConfig.global.requests_per_minute,
  reservoirRefreshAmount: rateLimitConfig.global.requests_per_minute,
  reservoirRefreshInterval: 60 * 1000,  // Every minute
  maxConcurrent: rateLimitConfig.global.concurrent_limit,
  minTime: 0,            // No minimum time between requests
  highWater: rateLimitConfig.global.queue_size,
  strategy: Bottleneck.strategy.OVERFLOW
});

// Per-user rate limiters - configurable limits
const userLimiters = new Map();

function getUserLimiter(userKey) {
  if (!userLimiters.has(userKey)) {
    const userLimiter = new Bottleneck({
      reservoir: rateLimitConfig.per_user.requests_per_minute,
      reservoirRefreshAmount: rateLimitConfig.per_user.requests_per_minute,
      reservoirRefreshInterval: 60 * 1000,  // Every minute
      maxConcurrent: rateLimitConfig.per_user.concurrent_limit,
      minTime: 0,            // No minimum time between requests
      highWater: rateLimitConfig.per_user.queue_size,
      strategy: Bottleneck.strategy.OVERFLOW
    });
    
    // Chain user limiter to global limiter
    userLimiter.chain(globalLimiter);
    
    userLimiters.set(userKey, userLimiter);
    
    // Clean up user limiter after inactivity (1 hour)
    setTimeout(() => {
      if (userLimiters.has(userKey)) {
        const limiter = userLimiters.get(userKey);
        limiter.stop(); // Stop the limiter
        userLimiters.delete(userKey);
        console.log(`🧹 Cleaned up rate limiter for user: ${userKey.substring(0, 8)}...`);
      }
    }, 60 * 60 * 1000); // 1 hour
  }
  
  return userLimiters.get(userKey);
}

// Wrap a request function with rate limiting
export async function scheduleRequest(userKey, requestFunction) {
  const userLimiter = getUserLimiter(userKey);
  
  try {
    return await userLimiter.schedule(requestFunction);
  } catch (error) {
    // Check if it's a queue overflow error
    if (error.message && error.message.includes('This job has been dropped')) {
      const queueOverflowError = new Error('Rate limit queue overflow');
      queueOverflowError.status = 503;
      queueOverflowError.code = 'QUEUE_OVERFLOW';
      throw queueOverflowError;
    }
    throw error;
  }
}

// Get current queue status for monitoring
export function getQueueStatus() {
  let globalReservoir = 0;
  try {
    // Try to get reservoir count safely
    globalReservoir = globalLimiter._store?.reservoir ?? 0;
  } catch (error) {
    // If accessing private property fails, default to 0
    globalReservoir = 0;
  }

  const globalStatus = {
    running: globalLimiter.running(),
    queued: globalLimiter.queued(),
    reservoir: globalReservoir
  };
  
  const userStatus = {};
  for (const [userKey, limiter] of userLimiters.entries()) {
    const maskedKey = userKey.substring(0, 8) + '...';
    
    let userReservoir = 0;
    try {
      userReservoir = limiter._store?.reservoir ?? 0;
    } catch (error) {
      userReservoir = 0;
    }
    
    userStatus[maskedKey] = {
      running: limiter.running(),
      queued: limiter.queued(),
      reservoir: userReservoir
    };
  }
  
  return {
    global: globalStatus,
    users: userStatus,
    totalUsers: userLimiters.size
  };
}

// Get metrics for prometheus
export function getRateLimitMetrics() {
  const status = getQueueStatus();
  
  // Ensure all values are valid numbers, defaulting to 0 if undefined/null
  return {
    global_requests_running: Number(status.global.running) || 0,
    global_requests_queued: Number(status.global.queued) || 0,
    global_reservoir_remaining: Number(status.global.reservoir) || 0,
    active_user_limiters: Number(status.totalUsers) || 0,
    total_user_requests_running: Object.values(status.users).reduce((sum, u) => sum + (Number(u.running) || 0), 0),
    total_user_requests_queued: Object.values(status.users).reduce((sum, u) => sum + (Number(u.queued) || 0), 0)
  };
}

// Graceful shutdown - drain all queues
export async function shutdown() {
  console.log('🔄 Draining rate limiters...');
  
  const shutdownPromises = [globalLimiter.stop({ dropWaitingJobs: false })];
  
  for (const [userKey, limiter] of userLimiters.entries()) {
    shutdownPromises.push(limiter.stop({ dropWaitingJobs: false }));
  }
  
  try {
    await Promise.all(shutdownPromises);
    console.log('✅ Rate limiters drained successfully');
  } catch (error) {
    console.error('❌ Error draining rate limiters:', error.message);
  }
}

// Event listeners for monitoring
globalLimiter.on('failed', (error, jobInfo) => {
  console.error('🚨 Global limiter job failed:', error.message);
});

globalLimiter.on('retry', (error, jobInfo) => {
  console.warn('🔄 Global limiter retrying job:', error.message);
});

globalLimiter.on('dropped', (dropped) => {
  console.warn('🗑️ Global limiter dropped job due to queue overflow');
});

export { globalLimiter, rateLimitConfig };

// Export configuration for use by other modules
export function getRateLimitConfig() {
  return rateLimitConfig;
}

// Check if rate limiting is enabled
export function isRateLimitingEnabled() {
  return rateLimitConfig.enabled !== false;
}

// Check if metrics are enabled  
export function areMetricsEnabled() {
  return rateLimitConfig.metrics_enabled !== false;
}
