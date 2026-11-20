// config/redis.config.js
const { createClient } = require('redis');
const { logger } = require('./logger');

let redisClient = null;

const connectRedis = async () => {
  const url = process.env.REDIS_URL || (process.env.NODE_ENV === 'production'
    ? null
    : 'redis://localhost:6379');

  if (!url) {
    throw new Error(
      'REDIS_URL is not set. Copy the TCP URL from Upstash (Connect → TCP) ' +
      'and add it to Render → Environment.'
    );
  }
  if (!url.startsWith('rediss://')) {
    throw new Error(
      'REDIS_URL must start with rediss:// (Upstash requires TLS). ' +
      'redis:// fails with ECONNRESET. Copy the TCP URL exactly from the dashboard.'
    );
  }

  redisClient = createClient({
    url,
    socket: {
      // Upstash free tier drops idle connections; keep sockets alive
      reconnectStrategy: (retries) => Math.min(retries * 200, 3000),
      tls: true,   // node-redis v4: explicit TLS flag
    },
  });

  redisClient.on('error',  (err) => logger.error('Redis error', { err: err.message }));
  redisClient.on('connect', () => logger.info('✅ Redis connected'));
  redisClient.on('end',    () => logger.warn('⚠️ Redis connection closed'));

  try {
    await redisClient.connect();
    return redisClient;
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('❌ Redis connection failed — refusing to boot without it', { err: error.message });
      throw error;   // let server.js's outer try/catch exit(1)
    }
    logger.warn('Redis unavailable in dev — continuing without it', { err: error.message });
    return null;
  }
};

const getRedisClient = () => redisClient;   // null if never connected — callers check

const disconnectRedis = async () => {
  if (!redisClient) return;
  try {
    await redisClient.quit();
    logger.info('✅ Redis disconnected successfully');
  } catch (error) {
    logger.error('Error disconnecting from Redis', { err: error.message });
  } finally {
    redisClient = null;
  }
};

const getRedisStatus = () => {
  if (!redisClient) return 'disconnected';
  const states = {
    ready:        'connected',
    open:         'connected',
    connecting:   'connecting',
    reconnecting: 'reconnecting',
    end:          'disconnected',
  };
  return states[redisClient.status] || 'unknown';
};

module.exports = {
  connectRedis,
  getRedisClient,
  disconnectRedis,
  getRedisStatus,
};
