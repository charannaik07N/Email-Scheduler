import express, { Application, Request, Response, NextFunction } from 'express';
import cors, { CorsOptions } from 'cors';
import { apiRateLimiter } from './middlewares/apiRate.middleware';
import authRoutes from './routes/auth.routes';
import emailRoutes from './routes/email.routes';
import { logger } from './utils/logger';

const app: Application = express();

// Behind a proxy (Vercel, a load balancer) the client IP is in X-Forwarded-For.
// Only trust it when configured, otherwise clients could spoof it to dodge rate limits.
const trustProxy = process.env.TRUST_PROXY ?? (process.env.VERCEL ? '1' : '');
if (trustProxy) {
  app.set('trust proxy', /^\d+$/.test(trustProxy) ? parseInt(trustProxy, 10) : trustProxy);
}

app.use((_req, res, next) => {
  // Google sign-in uses a popup that talks back via postMessage.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  next();
});

// Auth uses a Bearer token, not cookies, so CORS never needs credentials.
const allowedOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions: CorsOptions = {
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));

// HTML bodies from the composer can be large.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use('/api/', apiRateLimiter);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'Email Scheduler API',
    version: '2.0.0',
    status: 'running',
    endpoints: { health: '/health', auth: '/api/auth', emails: '/api/emails' },
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/emails', emailRoutes);

app.use((req: Request, res: Response) => {
  res.status(404).json({ success: false, error: 'Route not found', path: req.path });
});

// Errors from body parsing (bad JSON, body too large) carry their own 4xx status.
app.use((err: Error & { status?: number; statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    logger.error('❌ Unhandled error:', err);
  }
  res.status(status).json({
    success: false,
    error: status >= 500 ? 'Internal server error' : err.message,
  });
});

export default app;
