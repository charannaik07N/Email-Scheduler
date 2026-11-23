import { Request, Response } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { GOOGLE_CLIENT_IDS, JWT_EXPIRES_IN, JWT_SECRET } from '../config/auth';
import { getAuthUser } from '../middlewares/auth.middleware';
import { logger } from '../utils/logger';
import * as UserService from '../services/user.service';
import * as SenderService from '../services/sender.service';

const googleClient = new OAuth2Client();

const googleLoginSchema = z.object({
  // The ID token (credential) returned by Google Identity Services.
  googleToken: z.string().min(1),
});

const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const toProfile = (user: UserService.User) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  createdAt: user.createdAt,
});

/**
 * Google OAuth login.
 * The identity comes only from the verified Google ID token, never from the request body.
 * POST /api/auth/google-login
 */
export const googleLogin = async (req: Request, res: Response): Promise<void> => {
  let payload;
  try {
    const { googleToken } = googleLoginSchema.parse(req.body);
    const ticket = await googleClient.verifyIdToken({
      idToken: googleToken,
      audience: GOOGLE_CLIENT_IDS,
    });
    payload = ticket.getPayload();
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
      return;
    }
    logger.warn('⚠️  Rejected Google token:', (error as Error)?.message);
    res.status(401).json({ success: false, error: 'Invalid Google credential' });
    return;
  }

  if (!payload?.email || !payload.email_verified) {
    res.status(401).json({ success: false, error: 'Google account email is not verified' });
    return;
  }

  try {
    // Stored exactly as Google reports it, matching existing rows.
    const email = payload.email;
    const { user, created } = await UserService.findOrCreateUser({ email, name: payload.name });
    if (created) logger.info(`✅ New Google user created: ${user.id}`);

    try {
      await SenderService.ensureDefaultSender(user.id, user.email, user.name);
    } catch (senderError) {
      // Not fatal: GET /emails/senders retries this.
      logger.error('⚠️  Failed to create default sender:', senderError);
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });

    logger.info(`✅ Google user logged in: ${user.id}`);

    res.json({
      success: true,
      message: 'Google login successful',
      user: { ...toProfile(user), picture: payload.picture },
      token,
    });
  } catch (error) {
    logger.error('❌ Google login error:', error);
    res.status(500).json({ success: false, error: 'Google login failed' });
  }
};

/**
 * GET /api/auth/profile
 */
export const getProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await UserService.getUserById(getAuthUser(req).userId);
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    res.json({ success: true, user: toProfile(user) });
  } catch (error) {
    logger.error('❌ Get profile error:', error);
    res.status(500).json({ success: false, error: 'Failed to get profile' });
  }
};

/**
 * Only the display name can change: the email is the Google identity.
 * PUT /api/auth/profile
 */
export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const data = updateProfileSchema.parse(req.body);
    const user = await UserService.updateUser(getAuthUser(req).userId, data);
    res.json({ success: true, message: 'Profile updated successfully', user: toProfile(user) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
      return;
    }
    logger.error('❌ Update profile error:', error);
    res.status(500).json({ success: false, error: 'Failed to update profile' });
  }
};
