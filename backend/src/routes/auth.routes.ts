import { Router } from 'express';
import { googleLogin, getProfile, updateProfile } from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { authRateLimiter } from '../middlewares/apiRate.middleware';

const router = Router();

/**
 * @route   POST /api/auth/google-login
 * @desc    Sign in with a Google ID token (the only sign-in method)
 * @access  Public
 */
router.post('/google-login', authRateLimiter, googleLogin);

/**
 * @route   GET /api/auth/profile
 * @access  Private
 */
router.get('/profile', authenticate, getProfile);

/**
 * @route   PUT /api/auth/profile
 * @desc    Update display name
 * @access  Private
 */
router.put('/profile', authenticate, updateProfile);

export default router;
