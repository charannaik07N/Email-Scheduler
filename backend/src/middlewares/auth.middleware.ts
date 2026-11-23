import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/auth';
import * as UserService from '../services/user.service';
import { logger } from '../utils/logger';

export interface AuthUser {
  userId: string;
  email: string;
}

export const getAuthUser = (req: Request): AuthUser => (req as any).user as AuthUser;

/**
 * JWT Authentication Middleware.
 * Also confirms the user still exists, so tokens of deleted accounts stop working.
 */
export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'No token provided' });
    return;
  }

  let decoded: AuthUser;
  try {
    decoded = jwt.verify(authHeader.substring(7), JWT_SECRET) as AuthUser;
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
    return;
  }

  try {
    const user = await UserService.getUserById(decoded.userId);
    if (!user) {
      res.status(401).json({ success: false, error: 'Account no longer exists' });
      return;
    }
    (req as any).user = { userId: user.id, email: user.email } satisfies AuthUser;
    next();
  } catch (error) {
    logger.error('❌ Authentication error:', error);
    res.status(500).json({ success: false, error: 'Authentication failed' });
  }
};
