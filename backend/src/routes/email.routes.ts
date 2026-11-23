import { Router } from 'express';
import {
  scheduleEmailController,
  bulkScheduleEmailController,
  cancelEmailController,
  retryEmailController,
  getEmailController,
  getEmailsController,
  getEmailStatsController,
  createSenderController,
  getSendersController,
  updateSenderController,
  deleteSenderController,
} from '../controllers/email.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Fixed paths first, so they aren't captured by /:emailId.
router.post('/schedule', scheduleEmailController);
router.post('/schedule/bulk', bulkScheduleEmailController);
router.get('/', getEmailsController);
router.get('/stats', getEmailStatsController);

router.get('/senders', getSendersController);
router.post('/senders', createSenderController);
router.put('/senders/:senderId', updateSenderController);
router.delete('/senders/:senderId', deleteSenderController);

router.get('/:emailId', getEmailController);
router.delete('/:emailId', cancelEmailController);
router.post('/:emailId/retry', retryEmailController);

export default router;
