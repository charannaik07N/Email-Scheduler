// Standalone worker process: `npm run worker` or `node dist/worker.js`.
// dotenv must load before any module that reads process.env at import time.
import 'dotenv/config';
import { disconnectRedis } from './config/redis';
import { closeQueue } from './queues/emailQueue';
import { startEmailWorker, closeWorker } from './workers/emailWorker';
import { requeuePendingEmailsWithRetry } from './loaders/requeueOnRestart';
import { logger } from './utils/logger';

logger.info('🚀 Starting email worker as a standalone process...');
startEmailWorker();
requeuePendingEmailsWithRetry().catch((error) => logger.error('❌ Requeue failed:', error));

let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`⚠️  ${signal} received, closing worker...`);
  try {
    await closeWorker();
    await closeQueue();
    await disconnectRedis();
    process.exit(0);
  } catch (error) {
    logger.error('❌ Error during worker shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('❌ Unhandled Rejection:', reason);
});
