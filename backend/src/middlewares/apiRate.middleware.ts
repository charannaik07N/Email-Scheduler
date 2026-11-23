import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/auth';
import { logger } from '../utils/logger';

/**
 * Signed-in requests are counted per user, so people behind one office IP
 * don't share a limit. Only a valid (signed) token counts, so made-up tokens
 * can't be used to dodge the limit; anything else is counted per IP.
 */
export const clientKey = (req: Request): string => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const { userId } = jwt.verify(header.substring(7), JWT_SECRET) as { userId?: string };
      if (userId) return `user:${userId}`;
    } catch {
      // invalid or expired: fall through to the IP
    }
  }
  return `ip:${req.ip}`;
};

/**
 * General API limiter. The dashboard refreshes every 30 seconds while it's
 * visible (4 requests), about 120 per 15 minutes, so a user with a few tabs
 * open stays well below this.
 */
export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.API_RATE_LIMIT_PER_15_MIN || '600', 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  handler: (req, res) => {
    logger.warn(`⚠️  Rate limit exceeded for ${clientKey(req)}`);
    res.status(429).json({ success: false, error: 'Too many requests, please try again later.' });
  },
});

/**
 * Stricter limiter for login. Failed attempts count; successful logins don't,
 * so a shared office IP isn't locked out by normal sign-ins.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(`⚠️  Auth rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      error: 'Too many authentication attempts, please try again later.',
    });
  },
});
