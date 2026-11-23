import 'dotenv/config';
import type { Server } from 'http';
import app from './app';
import { describeRedisError, testRedisConnection, disconnectRedis } from './config/redis';
import { verifyMailConnection, defaultTransporter } from './config/mailer';
import { closeQueue } from './queues/emailQueue';
import { startEmailWorker, closeWorker } from './workers/emailWorker';
import { requeuePendingEmailsWithRetry } from './loaders/requeueOnRestart';
import { logger } from './utils/logger';

const PORT = process.env.PORT || 5000;

// Set RUN_WORKER=false when a separate worker process sends the emails (see docker-compose.yml).
const RUN_WORKER = process.env.RUN_WORKER !== 'false';

let server: Server | undefined;

const startServer = async () => {
  logger.info('🚀 Starting Email Scheduler Server...');

  try {
    await testRedisConnection();
  } catch (error) {
    logger.warn(`⚠️  Redis is not reachable, so scheduling will fail until it is: ${describeRedisError(error as Error)}`);
  }

  // Background check: a slow SMTP server shouldn't delay startup.
  verifyMailConnection(defaultTransporter).catch(() => undefined);

  if (RUN_WORKER) {
    startEmailWorker();
    // Only the process that sends emails rebuilds the queue (a separate worker
    // does it itself). Runs in the background so Redis can't delay startup.
    requeuePendingEmailsWithRetry().catch((error) => logger.error('❌ Requeue failed:', error));
  }

  server = app.listen(PORT, () => {
    logger.info(`✅ Server is running on port ${PORT} (worker ${RUN_WORKER ? 'on' : 'off'})`);
    logger.info(`🔗 Health check: http://localhost:${PORT}/health`);
  });
};

const withTimeout = (promise: Promise<unknown>, ms: number, label: string) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]).catch((error) => logger.warn(`⚠️  ${label}: ${(error as Error).message}`));

let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`⚠️  ${signal} received, shutting down...`);

  // Stop accepting requests and let in-flight ones finish first.
  if (server) {
    const httpServer = server;
    await withTimeout(
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
      10000,
      'HTTP server close'
    );
  }
  await withTimeout(closeWorker(), 10000, 'Worker close');
  await withTimeout(closeQueue(), 5000, 'Queue close');
  await withTimeout(disconnectRedis(), 5000, 'Redis disconnect');

  logger.info('✅ Graceful shutdown completed');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('❌ Unhandled Rejection:', reason);
});

startServer().catch((error) => {
  logger.error('❌ Failed to start server:', error);
  process.exit(1);
});
