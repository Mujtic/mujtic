// middleware/cache.js
const { getRedisClient } = require('../config/redis');
const { logger } = require('../config/logger');

// fetchApi() in app.js appends `?_t=<timestamp>` to every request to defeat
// browser caching. The server cache must strip it, or every request has a
// unique URL and the cache never hits.
function cacheKeyFor(req) {
  const u = new URL(req.originalUrl, 'http://placeholder');
  u.searchParams.delete('_t');
  return `cache:${u.pathname}${u.search}`;
}

function cache(ttlSeconds = 30) {
  return async (req, res, next) => {
    if (req.method !== 'GET') return next();

    const redis = getRedisClient();
    if (!redis) return next();   // no Redis → serve uncached

    const key = cacheKeyFor(req);

    try {
      const hit = await redis.get(key);
      if (hit) {
        res.set('X-Cache', 'HIT');
        return res.type('application/json').send(hit);
      }
    } catch (err) {
      logger.warn('Redis GET failed', { err: err.message, key });
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200) {
        redis.setEx(key, ttlSeconds, JSON.stringify(body))
          .catch((err) => logger.warn('Redis SET failed', { err: err.message, key }));
      }
      res.set('X-Cache', 'MISS');
      return originalJson(body);
    };

    next();
  };
}

module.exports = { cache };
