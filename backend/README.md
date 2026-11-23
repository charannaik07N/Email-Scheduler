# 📧 Email Scheduler - Backend

Express.js + TypeScript backend API for the Email Scheduler application.

The full API reference is in [API_DOCS.md](./API_DOCS.md).

---

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- Redis server running on port 6379
- Supabase account with project
- Google OAuth Client ID

### Installation

```bash
# Navigate to backend directory
cd backend

# Install dependencies
npm install

# Create environment file
cp .env.example .env
```

### Environment Variables

Set these in `backend/.env` (`.env.example` has all of them with comments):

| Variable                         | Required | Default                  | Description                                                                                     |
| -------------------------------- | -------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| `JWT_SECRET`                     | Yes      | -                        | Signs login tokens. No fallback: the server refuses to start without it (`openssl rand -hex 32`) |
| `GOOGLE_CLIENT_ID`               | Yes      | -                        | Google OAuth client ID(s), comma-separated; must match the frontend's `VITE_GOOGLE_CLIENT_ID`   |
| `SUPABASE_URL`                   | Yes      | -                        | Supabase project URL                                                                            |
| `SUPABASE_SERVICE_ROLE_KEY`      | Yes      | -                        | Server-side Supabase key; never expose it to the frontend                                       |
| `DATABASE_URL`                   | No       | -                        | Only for the Prisma CLI (`npm run prisma:push`), not used by the app                            |
| `PORT`                           | No       | `5000`                   | HTTP port                                                                                       |
| `NODE_ENV`                       | No       | -                        | `development` / `production`                                                                    |
| `LOG_LEVEL`                      | No       | `info`                   | Winston log level                                                                               |
| `REDIS_URL`                      | No       | `redis://localhost:6379` | Redis for BullMQ and rate limits                                                                |
| `SMTP_HOST`                      | No       | `smtp.ethereal.email`    | Shared SMTP server for senders without their own SMTP settings                                  |
| `SMTP_PORT`                      | No       | `587`                    | 465 uses implicit TLS; 587 uses STARTTLS                                                        |
| `ETHEREAL_USER`                  | No       | -                        | Shared SMTP username                                                                            |
| `ETHEREAL_PASS`                  | No       | -                        | Shared SMTP password                                                                            |
| `RUN_WORKER`                     | No       | `true`                   | Run the email worker inside the API process; `false` when a separate worker runs                |
| `WORKER_CONCURRENCY`             | No       | `5`                      | Jobs processed in parallel per worker process                                                   |
| `MIN_DELAY_BETWEEN_EMAILS_MS`    | No       | `2000`                   | Minimum gap between any two sends, across all workers                                           |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | No       | `100`                    | Per-sender limit per UTC hour                                                                   |
| `CORS_ORIGIN`                    | No       | `*`                      | Allowed browser origins, comma-separated                                                        |
| `API_RATE_LIMIT_PER_15_MIN`      | No       | `600`                    | Requests per 15 minutes on `/api`, per signed-in user (per IP without a valid token)           |
| `TRUST_PROXY`                    | No       | -                        | Hop count or subnet when behind a proxy, so rate limits see the real IP (automatically 1 on Vercel) |

### Database

The app talks to Supabase through `@supabase/supabase-js`. `prisma/schema.prisma` documents the tables and can create them on a fresh database:

```bash
npm run prisma:push   # needs DATABASE_URL
```

### Running the Server

```bash
# Development mode (with auto-reload), API + worker
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

The server will be available at **http://localhost:5000**

---

## 📁 Project Structure

```
backend/
├── prisma/
│   └── schema.prisma        # Database schema
├── src/
│   ├── config/
│   │   ├── auth.ts          # JWT_SECRET / GOOGLE_CLIENT_ID (required)
│   │   ├── mailer.ts        # Nodemailer SMTP config
│   │   ├── redis.ts         # Redis connection
│   │   └── supabase.ts      # Supabase service client
│   ├── controllers/
│   │   ├── auth.controller.ts    # Auth endpoints
│   │   └── email.controller.ts   # Email + sender endpoints
│   ├── routes/
│   │   ├── auth.routes.ts        # /api/auth/*
│   │   └── email.routes.ts       # /api/emails/*
│   ├── services/
│   │   ├── email.service.ts      # Email CRUD
│   │   ├── emailLog.service.ts   # Email logs
│   │   ├── rateLimit.service.ts  # Hourly limit + send locks
│   │   ├── sender.service.ts     # Sender management
│   │   └── user.service.ts       # User management
│   ├── queues/
│   │   └── emailQueue.ts         # BullMQ queue config
│   ├── workers/
│   │   └── emailWorker.ts        # Email processor
│   ├── loaders/
│   │   └── requeueOnRestart.ts   # Restart recovery
│   ├── middlewares/
│   │   ├── auth.middleware.ts    # JWT validation
│   │   └── apiRate.middleware.ts # API rate limiting
│   ├── utils/
│   │   ├── logger.ts             # Winston logger
│   │   └── time.ts               # UTC hour windows
│   ├── app.ts                    # Express app
│   ├── server.ts                 # API entry (starts the worker unless RUN_WORKER=false)
│   └── worker.ts                 # Standalone worker entry
├── .env.example                  # Environment template
├── API_DOCS.md                   # API reference
├── Dockerfile                    # Production image (Node 20)
├── docker-compose.yml            # Redis + API + worker
├── package.json                  # Dependencies
├── tsconfig.json                 # TypeScript config
└── nodemon.json                  # Nodemon config
```

---

## 🔌 API Endpoints

See [API_DOCS.md](./API_DOCS.md) for request and response details. Responses use `{ success, data?, message?, error? }`.

### Health Check

| Method | Endpoint  | Description          |
| ------ | --------- | -------------------- |
| GET    | `/health` | Server health status |

### Authentication

| Method | Endpoint                 | Description                      | Auth |
| ------ | ------------------------ | -------------------------------- | ---- |
| POST   | `/api/auth/google-login` | Sign in with a Google ID token   | No   |
| GET    | `/api/auth/profile`      | Get user profile                 | Yes  |
| PUT    | `/api/auth/profile`      | Update display name (`name` only) | Yes  |

### Emails

| Method | Endpoint                       | Description                                    | Auth |
| ------ | ------------------------------ | ---------------------------------------------- | ---- |
| POST   | `/api/emails/schedule`         | Schedule one email                             | Yes  |
| POST   | `/api/emails/schedule/bulk`    | Schedule up to 500 recipients                  | Yes  |
| GET    | `/api/emails`                  | List emails (`status`, `page`, `limit`)        | Yes  |
| GET    | `/api/emails/stats`            | Counts (`tzOffset`)                            | Yes  |
| GET    | `/api/emails/:emailId`         | Email with its logs                            | Yes  |
| DELETE | `/api/emails/:emailId`         | Cancel a `SCHEDULED`/`RETRYING` email          | Yes  |
| POST   | `/api/emails/:emailId/retry`   | Retry a `FAILED` email                         | Yes  |

### Senders

| Method | Endpoint                         | Description        | Auth |
| ------ | -------------------------------- | ------------------ | ---- |
| GET    | `/api/emails/senders`            | Get user's senders | Yes  |
| POST   | `/api/emails/senders`            | Create sender      | Yes  |
| PUT    | `/api/emails/senders/:senderId`  | Update sender      | Yes  |
| DELETE | `/api/emails/senders/:senderId`  | Delete sender      | Yes  |

---

## 📡 API Details

### Authentication

All protected endpoints require the app token in the header:

```
Authorization: Bearer <jwt-token>
```

### POST /api/auth/google-login

Sign-in is Google only. The frontend sends the Google ID token; the backend verifies it with `google-auth-library` against `GOOGLE_CLIENT_ID`, creates the user (and a default sender) on first sign-in, and returns a 7-day app token.

**Request:**

```json
{
  "googleToken": "<Google ID token>"
}
```

**Response (200):**

```json
{
  "success": true,
  "message": "Google login successful",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "Jane Doe",
    "createdAt": "2026-01-30T10:00:00Z",
    "picture": "https://..."
  },
  "token": "jwt-token"
}
```

### POST /api/emails/schedule/bulk

Schedule the same message to many recipients; each has its own `scheduledAt`.

**Request:**

```json
{
  "senderId": "sender-uuid",
  "subject": "Hello!",
  "body": "Email content here...",
  "recipients": [
    { "recipientEmail": "a@example.com", "scheduledAt": "2026-01-31T10:00:00Z", "idempotencyKey": "draft-1:a@example.com" },
    { "recipientEmail": "b@example.com", "scheduledAt": "2026-01-31T10:00:30Z" }
  ]
}
```

**Response:** `201` (all scheduled), `207` (partial), or `503` (queue unavailable), with `data.scheduled` and `data.failed`.

### GET /api/emails

**Query Parameters:**

- `status` - Comma-separated: `SCHEDULED`, `RETRYING`, `SENT`, `FAILED`
- `page` - Page number (default: 1)
- `limit` - Page size, 1-100 (default: 50)

**Response (200):**

```json
{
  "success": true,
  "data": {
    "data": [{ "id": "email-uuid", "recipientEmail": "recipient@example.com", "status": "SENT" }],
    "total": 1,
    "page": 1,
    "pageSize": 50,
    "totalPages": 1
  }
}
```

### DELETE /api/emails/:emailId

Cancel an unsent email. The queued job is removed and the email is deleted. Returns `409` if the email is already sent/failed or is being sent right now.

---

## ⚙️ How Email Scheduling Works

### 1. Email Creation Flow

```
User Request → API → Validate → Save to DB → Add to BullMQ Queue
```

1. Frontend sends one bulk request with a send time per recipient
2. Server validates input (email format, schedule time, sender ownership)
3. Each email saved to Supabase with status `SCHEDULED`
4. BullMQ job created with delay until scheduled time (job ID = email ID)
5. Response returned to user

If the queue can't be reached, the email row is deleted again so nothing is left looking scheduled.

### 2. Email Processing Flow

```
BullMQ Worker → Fetch Email → Check Rate Limit → Send via SMTP → Update DB
```

1. Worker picks up job when delay expires
2. Fetches email from database (skips it if cancelled or already sent)
3. Reserves a slot in the sender's hourly window
4. Sends email via Nodemailer, through the sender's own SMTP server if it has one
5. Updates email status to `SENT`, `RETRYING`, or `FAILED`
6. Creates email log entry

### 3. Server Restart Recovery

On startup, the API (when running the worker) and the standalone worker:

1. Query all unsent emails (`SCHEDULED` and `RETRYING`)
2. Re-add them to the BullMQ queue under their email ID (already queued ones are left alone)
3. Send overdue ones immediately

### Email Statuses

| Status      | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `SCHEDULED` | Waiting in the queue                                                    |
| `RETRYING`  | An attempt failed, or the hourly limit was hit; will be tried again     |
| `SENT`      | Delivered to the SMTP server                                            |
| `FAILED`    | Gave up after all attempts                                              |

Cancelled emails are deleted.

---

## 🗄️ Database Schema

Defined in `prisma/schema.prisma`.

### Users Table

```sql
- id (UUID, primary key)
- email (string, unique)
- name (string, nullable)
- created_at (timestamp)
- updated_at (timestamp)
```

Users sign in with Google only; no password is stored.

### Senders Table

```sql
- id (UUID, primary key)
- user_id (UUID, foreign key)
- name (string)
- email (string)
- smtp_host (string, nullable)
- smtp_port (integer, nullable)
- smtp_user (string, nullable)
- smtp_pass (string, nullable; never returned by the API)
- created_at (timestamp)
- updated_at (timestamp)
```

### Emails Table

```sql
- id (UUID, primary key)
- sender_id (UUID, foreign key)
- recipient_email (string)
- recipient_name (string, nullable)
- subject (string)
- body (text)
- html_body (text, nullable)
- status (enum: SCHEDULED, RETRYING, SENT, FAILED)
- scheduled_at (timestamp)
- sent_at (timestamp, nullable)
- error_message (string, nullable)
- attempt_count (integer)
- idempotency_key (string, unique; stored as "<userId>:<client key>")
- created_at (timestamp)
- updated_at (timestamp)
```

### Email Logs Table

```sql
- id (UUID, primary key)
- email_id (UUID, foreign key)
- status (enum)
- message (string)
- created_at (timestamp)
```

---

## 🔧 Available Scripts

| Command                 | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `npm run dev`           | Start API + worker with nodemon (auto-reload)  |
| `npm run build`         | Compile TypeScript to `dist/`                  |
| `npm run typecheck`     | Type-check without emitting                    |
| `npm start`             | Run production API (`dist/server.js`)          |
| `npm run start:worker`  | Run production standalone worker (`dist/worker.js`) |
| `npm run worker`        | Run standalone worker with ts-node (`src/worker.ts`) |
| `npm run prisma:push`   | Create/update tables from `schema.prisma`      |
| `npm run prisma:studio` | Browse the database with Prisma Studio         |

---

## 🛠️ Tech Stack

| Technology          | Version | Purpose                    |
| ------------------- | ------- | -------------------------- |
| Express.js          | 4.x     | Web framework              |
| TypeScript          | 5.x     | Type safety                |
| Supabase            | 2.x     | PostgreSQL database        |
| BullMQ              | 5.x     | Job queue                  |
| Redis               | -       | Queue storage, rate limits |
| Nodemailer          | 6.x     | Email sending              |
| google-auth-library | 9.x     | Google ID token checks     |
| JWT                 | -       | Authentication             |
| Winston             | 3.x     | Logging                    |
| Zod                 | 3.x     | Validation                 |

---

## 🔒 Security Features

- **Google Sign-In** - Identity comes only from a verified Google ID token
- **JWT Authentication** - 7-day app tokens; `JWT_SECRET` is required, with no fallback
- **Sender Rules** - Without its own SMTP settings, a sender can only use the account's own email
- **No Secrets in Responses** - SMTP passwords are never returned (`hasSmtpPassword` instead)
- **Rate Limiting** - Per-sender hourly limits, API limits, and a stricter sign-in limit
- **Input Validation** - Zod schema validation
- **CORS** - Configured via `CORS_ORIGIN`

---

## 📝 Error Codes

| Code | Description                                              |
| ---- | -------------------------------------------------------- |
| 400  | Bad Request - Invalid input                              |
| 401  | Unauthorized - Invalid/missing token                     |
| 404  | Not Found - Resource doesn't exist (or isn't yours)      |
| 409  | Conflict - e.g. cancelling a sent email, deleting a sender with unsent emails |
| 429  | Too Many Requests - Rate limit exceeded                  |
| 500  | Internal Server Error                                    |
| 503  | Email queue (Redis) unavailable                          |

---

## 🧪 Testing with Ethereal

For development, use [Ethereal Email](https://ethereal.email/):

1. Go to https://ethereal.email/
2. Click "Create Ethereal Account"
3. Copy SMTP credentials to `.env` (`ETHEREAL_USER`, `ETHEREAL_PASS`)
4. Sent emails appear in Ethereal inbox (not actually delivered); the logs print a preview URL

---

## 🏗️ Architecture Deep Dive

### Email Scheduling Architecture

**Flow Diagram:**

```
User Input → API Validation → Database → BullMQ Queue → Worker → SMTP → Update DB
```

**Step-by-Step Process:**

1. **User Creates Email**
   - Frontend: `pages/ComposeEmail.tsx` computes a send time per recipient and sends POST to `/api/emails/schedule/bulk`
   - Request includes: senderId, subject, body, and recipients (each with recipientEmail, scheduledAt, idempotencyKey)

2. **API Layer** (`controllers/email.controller.ts`)
   - Validates input with Zod schema
   - Checks user authentication via JWT
   - Checks the sender belongs to the user

3. **Service Layer** (`services/email.service.ts`)
   - Returns the existing email if the idempotency key was already used
   - Saves email to Supabase with status `SCHEDULED`
   - Transforms DB snake_case to camelCase for frontend

4. **Queue Layer** (`queues/emailQueue.ts`)
   - Calculates delay: `scheduledAt - now()`
   - Adds BullMQ job with `jobId` = email ID, so an email can't be queued twice
   - 3 attempts with exponential backoff
   - Job persisted to Redis

5. **Worker Layer** (`workers/emailWorker.ts`)
   - Runs in the API process, or standalone via `src/worker.ts`
   - Processes up to `WORKER_CONCURRENCY` jobs concurrently
   - When delay expires, job executes

6. **Email Sending**
   - Re-reads the email from the database; skips it if deleted or no longer pending
   - Takes a per-email Redis lock so it can't be sent twice at once
   - Checks the hourly limit: `rateLimit.service.ts`
   - Sends via SMTP: the sender's own SMTP settings if present, else the shared account (`mailer.ts`)
   - Updates status to `SENT`, `RETRYING`, or `FAILED`
   - Creates log entry: `emailLog.service.ts`

### Persistence on Restart - Implementation

**Problem:**

- Jobs live in Redis; if Redis loses them, or queuing failed, scheduled emails would never go out

**Solution:** Database as source of truth

**File:** `backend/src/loaders/requeueOnRestart.ts`

**Logic:**

```typescript
export const requeuePendingEmails = async () => {
  // 1. All unsent emails (SCHEDULED or RETRYING)
  const pendingEmails = await EmailService.getPendingEmails();

  // 2. Queue each one again under its own ID. addEmailToQueue leaves
  //    already-queued jobs alone, and a scheduledAt in the past means
  //    no delay, so overdue emails are sent immediately.
  for (const email of pendingEmails) {
    await addEmailToQueue({ emailId: email.id, ... }, new Date(email.scheduledAt));
  }
};
```

**When it runs:** On startup of `server.ts` and `worker.ts`

**Benefits:**

- ✅ Zero email loss on crashes
- ✅ Works across deployments
- ✅ Database is single source of truth

### Rate Limiting - Three Layers

#### Layer 1: API Rate Limiting

**File:** `backend/src/middlewares/apiRate.middleware.ts`

**Purpose:** Prevent API abuse

- All `/api/*` routes: `API_RATE_LIMIT_PER_15_MIN` requests per 15 minutes per signed-in user, or per IP without a valid token (default 600)
- `POST /api/auth/google-login`: 10 failed attempts per 15 minutes per IP (successful sign-ins don't count)
- Returns 429 when exceeded
- Uses the in-memory store; set `TRUST_PROXY` behind a proxy so the real client IP is used

#### Layer 2: Per-Sender Hourly Limit

**File:** `backend/src/services/rateLimit.service.ts`

**Purpose:** Prevent spam and SMTP server bans

**Configuration:** `MAX_EMAILS_PER_HOUR_PER_SENDER` (default 100)

**Redis Key Structure:**

```
rate_limit:{senderId}:{YYYY-MM-DD-HH}  → count   (UTC hour window, TTL 2 hours)
```

**Implementation:** A Lua script increments the counter and gives the slot back if the limit is already reached, all in one atomic step, so concurrent workers can't overshoot. If the send then fails, the slot is released.

**When the limit is reached:** The email is set to `RETRYING` and the job is moved to the start of the next UTC hour. This does not use up a retry attempt.

#### Layer 3: Global Gap Between Sends

**File:** `backend/src/workers/emailWorker.ts`

`MIN_DELAY_BETWEEN_EMAILS_MS` (default 2000) is applied as the BullMQ worker limiter (`max: 1` per that duration). The limiter lives in Redis, so the gap holds across all worker processes.

### Concurrency Implementation

**File:** `backend/src/workers/emailWorker.ts`

```typescript
worker = new Worker(EMAIL_QUEUE_NAME, processEmailJob, {
  connection: redis,
  concurrency: WORKER_CONCURRENCY, // default 5
  limiter: { max: 1, duration: MIN_DELAY_MS },
});
```

**Safety:**

- The hourly limit and global gap are enforced in Redis, across all jobs and processes
- A per-email lock (`email_send_lock:{emailId}`) prevents duplicate sends
- Failed jobs don't block others

### Retries

- 3 attempts per job, exponential backoff starting at 2 seconds
- Between attempts the status is `RETRYING`; after the last attempt it is `FAILED`
- `POST /api/emails/:emailId/retry` queues a `FAILED` email again immediately with a fresh attempt count

### Database Schema Transformation

**Problem:** Supabase returns snake_case, frontend expects camelCase

**File:** `backend/src/services/email.service.ts` (and the other services)

**Solution:** Each service maps rows with a transform function, e.g. `transformEmailFromDB` turns `sender_id` into `senderId`, `scheduled_at` into `scheduledAt`, and so on.

---

## 🔧 Running Individual Components

### Run API Without the Worker

Set `RUN_WORKER=false` in `.env`, then:

```bash
npm run dev
```

### Run BullMQ Worker Separately

```bash
npm run worker            # development (ts-node src/worker.ts)
npm run start:worker      # production (node dist/worker.js, after npm run build)
```

### Run with Docker

```bash
docker compose up --build
```

`docker-compose.yml` starts:

- **redis** - Redis 7 with append-only persistence
- **api** - the API on port 5000 with `RUN_WORKER=false`
- **worker** - the same image running `node dist/worker.js`

Both `api` and `worker` read `.env` (`env_file`) and use `REDIS_URL=redis://redis:6379`. The image is built on Node 20.

### Check Redis Queue Status

```bash
redis-cli
> KEYS bull:email-queue:*
> ZCARD bull:email-queue:delayed
> LLEN bull:email-queue:wait
> LLEN bull:email-queue:active
```

### Create Database Tables

```bash
npm run prisma:push
```

---

## 📊 Monitoring & Debugging

### View Logs

All logs use Winston logger (`utils/logger.ts`); set `LOG_LEVEL=debug` for more detail.

```bash
# Watch logs in real-time
npm run dev

# Logs include:
# - Server startup
# - Redis connection
# - Email queue events
# - Worker processing
# - SMTP sending
# - Rate limit violations
# - Errors with stack traces
```

### Check Scheduled Emails

```bash
# Query database
SELECT * FROM emails WHERE status IN ('SCHEDULED', 'RETRYING');

# Check Redis queue
redis-cli
> ZCARD bull:email-queue:delayed
```

### Test SMTP Connection

```typescript
// Verify in logs on startup:
// ✅ SMTP connection verified successfully
```

### Debug Rate Limiting

```bash
redis-cli
> KEYS rate_limit:*
> GET rate_limit:{senderId}:{YYYY-MM-DD-HH}
> TTL rate_limit:{senderId}:{YYYY-MM-DD-HH}
```

---

## 🚨 Common Issues & Solutions

### Issue: Server exits with "Missing required environment variable"

Set `JWT_SECRET` and `GOOGLE_CLIENT_ID` in `.env`. There is no fallback secret. A missing `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` also stops startup.

### Issue: Port 5000 already in use

```powershell
# Windows
Get-NetTCPConnection -LocalPort 5000 | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }

# macOS/Linux
lsof -ti:5000 | xargs kill -9
```

### Issue: Redis connection failed

```bash
# Check if Redis is running
redis-cli ping

# Start Redis
# Windows: Run Redis server executable
# macOS: brew services start redis
# Linux: sudo systemctl start redis
```

### Issue: SMTP authentication failed

- Verify `ETHEREAL_USER` / `ETHEREAL_PASS` are correct
- Check `.env` file has no extra spaces
- Generate new Ethereal account if expired

### Issue: Emails not sending

1. Check email status in database: `SELECT * FROM emails`
2. Check a worker is running: look for "Email worker started" in logs (with `RUN_WORKER=false`, run `npm run worker`)
3. Check the hourly limit: `redis-cli KEYS rate_limit:*`
4. Check the queue: `redis-cli ZCARD bull:email-queue:delayed`

---

## 🎯 Performance Optimization

### Current Settings

- **Concurrency:** `WORKER_CONCURRENCY` (default 5) per worker process
- **Hourly Limit:** `MAX_EMAILS_PER_HOUR_PER_SENDER` (default 100)
- **Send Gap:** `MIN_DELAY_BETWEEN_EMAILS_MS` (default 2000 ms), global
- **Queue:** Redis with append-only persistence (docker-compose)

### Scaling Recommendations

**Horizontal Scaling:**

- Run the API with `RUN_WORKER=false` and one or more worker processes
- Use a shared Redis instance; limits are enforced there, so they hold across workers

**Vertical Scaling:**

- Increase `WORKER_CONCURRENCY`
- Lower `MIN_DELAY_BETWEEN_EMAILS_MS` or raise `MAX_EMAILS_PER_HOUR_PER_SENDER` if your SMTP provider allows it

---
