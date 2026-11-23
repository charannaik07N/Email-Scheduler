# 📧 Email Scheduler

A full-stack email scheduling application built with React, Express.js, TypeScript, Supabase, BullMQ, and Redis.

## 🚀 Features

- **Google Sign-In** - Google is the only sign-in method; the backend verifies the Google ID token
- **Email Scheduling** - Schedule emails to be sent at a specific time, to up to 500 recipients per request
- **Send Spacing** - Space out send times with a delay between emails and an hourly limit
- **Multi-Sender Support** - Manage multiple sender identities, optionally with their own SMTP settings
- **Rate Limiting** - Per-sender hourly limits and a global minimum gap between sends
- **Email Queue** - BullMQ for reliable delivery, with retries and restart recovery
- **Status Tracking** - Track scheduled, retrying, sent, and failed emails; cancel scheduled ones and retry failed ones
- **Responsive UI** - Modern React frontend with Tailwind CSS

---

## 📁 Project Structure

```
email-scheduler/
├── frontend/          # React + TypeScript + Vite
│   ├── src/
│   │   ├── auth/      # Authentication (Google OAuth)
│   │   ├── pages/     # Login, Dashboard, ComposeEmail
│   │   ├── services/  # API service layer
│   │   ├── types/     # TypeScript types
│   │   ├── utils/     # Recipient parsing, send-time spacing
│   │   └── config.ts  # Runtime config from env
│   └── ...
├── backend/           # Express.js + TypeScript
│   ├── prisma/        # schema.prisma (database schema)
│   ├── src/
│   │   ├── config/    # Auth, Supabase, Redis, Mailer config
│   │   ├── controllers/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── queues/    # BullMQ email queue
│   │   ├── workers/   # Email worker processor
│   │   ├── loaders/   # Requeue on restart
│   │   ├── middlewares/
│   │   ├── server.ts  # API entry (runs the worker too unless RUN_WORKER=false)
│   │   └── worker.ts  # Standalone worker entry
│   ├── API_DOCS.md    # API reference
│   └── docker-compose.yml
└── README.md
```

---

## 🛠️ Tech Stack

### Frontend

- **React 19** - UI library
- **TypeScript** - Type safety
- **Vite** - Build tool
- **Tailwind CSS 4** - Styling
- **React Router 7** - Routing
- **@react-oauth/google** - Google authentication
- **Axios** - HTTP client

### Backend

- **Express.js** - Web framework
- **TypeScript** - Type safety
- **Supabase** - PostgreSQL database
- **BullMQ** - Job queue for email scheduling
- **Redis** - Queue storage & rate limiting
- **Nodemailer** - Email sending
- **google-auth-library** - Google ID token verification
- **JWT** - Authentication tokens

---

## ⚡ Quick Start

### Prerequisites

- Node.js 20+
- Redis server running on port 6379
- Supabase account with project created
- Google Cloud Console project for OAuth

### 1. Clone the Repository

```bash
git clone <repository-url>
cd email-scheduler
```

### 2. Setup Backend

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env` (see `backend/.env.example` for all options):

```env
# Server
PORT=5000
NODE_ENV=development

# Required: signs login tokens; the server refuses to start without it
JWT_SECRET=<output of: openssl rand -hex 32>

# Required: Google OAuth client ID (same value as the frontend's VITE_GOOGLE_CLIENT_ID)
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com

# Supabase (required)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Only used by the Prisma CLI (npm run prisma:push)
DATABASE_URL=postgresql://postgres:password@db.your-project.supabase.co:5432/postgres

# Redis
REDIS_URL=redis://localhost:6379

# SMTP (Ethereal for testing)
SMTP_HOST=smtp.ethereal.email
SMTP_PORT=587
ETHEREAL_USER=your-ethereal-user@ethereal.email
ETHEREAL_PASS=your-ethereal-password
```

Create the tables (once, on a fresh database):

```bash
npm run prisma:push
```

Start the backend:

```bash
npm run dev
```

### 3. Setup Frontend

```bash
cd frontend
npm install
```

Create `.env` file:

```env
VITE_API_BASE_URL=http://localhost:5000/api
VITE_GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
```

Start the frontend:

```bash
npm run dev
```

### 4. Access the Application

- **Frontend:** http://localhost:5173
- **Backend API:** http://localhost:5000
- **Health Check:** http://localhost:5000/health

---

## 📖 Documentation

- [Setup Guide](./SETUP_GUIDE.md) - Step-by-step setup and troubleshooting
- [Frontend README](./frontend/README.md) - Frontend setup and architecture
- [Backend README](./backend/README.md) - Backend setup and architecture
- [API Docs](./backend/API_DOCS.md) - API reference

---

## 🔐 Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Configure the OAuth consent screen
4. Go to Credentials → Create Credentials → OAuth Client ID
5. Application type: Web application
6. Add authorized JavaScript origins:
   - `http://localhost:5173`
7. Copy the Client ID to both `frontend/.env` (`VITE_GOOGLE_CLIENT_ID`) and `backend/.env` (`GOOGLE_CLIENT_ID`)

---

## 🏗️ Architecture Overview

### How Email Scheduling Works

1. **User Schedules Email** → The composer computes a send time for each recipient and sends one `POST /api/emails/schedule/bulk` request (up to 500 recipients)
2. **API Validation** → Server validates email format, scheduled time, and that the sender belongs to the user
3. **Database Persistence** → Each email saved to Supabase with status `SCHEDULED`
4. **Queue Job Creation** → BullMQ delayed job created; the job ID is the email ID, so an email can't be queued twice
5. **Worker Processing** → At the scheduled time, a worker picks up the job and re-reads the email (cancelled or already sent emails are skipped)
6. **Rate Limit Check** → Reserves a slot in the sender's hourly window; if full, the email waits for the next hour
7. **Email Sending** → Sends via Nodemailer, through the sender's own SMTP server if it has one, otherwise the server's SMTP account
8. **Status Update** → Status becomes `SENT`, `RETRYING` (will try again), or `FAILED` (after 3 attempts)
9. **Logging** → Creates an email log entry for the audit trail

```
┌─────────────┐      ┌──────────────┐      ┌─────────────┐      ┌──────────┐
│   Frontend  │ ───> │  Express API │ ───> │  Supabase   │      │  Redis   │
│   (React)   │      │  (Backend)   │      │  (Postgres) │      │ (BullMQ) │
└─────────────┘      └──────────────┘      └─────────────┘      └──────────┘
                            │                                          │
                            │                                          │
                            ▼                                          ▼
                     ┌──────────────┐                          ┌─────────────┐
                     │   BullMQ     │ <─────────────────────── │   Worker    │
                     │   Queue      │                          │  Processor  │
                     └──────────────┘                          └─────────────┘
                                                                      │
                                                                      ▼
                                                                ┌─────────────┐
                                                                │    SMTP     │
                                                                │   Server    │
                                                                └─────────────┘
```

The worker runs inside the API process by default. Set `RUN_WORKER=false` and run `npm run worker` (or `node dist/worker.js`) to run it as a separate process; `backend/docker-compose.yml` does this.

### Persistence on Restart

**Problem:** If Redis loses jobs (or they were never queued), scheduled emails would never be sent.

**Solution:**

1. On startup (API with worker, or standalone worker), `requeueOnRestart.ts` runs
2. Loads all unsent emails (`SCHEDULED` or `RETRYING`) from the database
3. Re-adds each one under its own job ID, so emails already in the queue are left alone
4. Emails whose time passed while the server was down are sent immediately

### Rate Limiting Implementation

**1. API Rate Limiting** (`apiRate.middleware.ts`)

- **Purpose:** Prevent API abuse
- **Limit:** `API_RATE_LIMIT_PER_15_MIN` requests per 15 minutes per signed-in user, or per IP without a valid token (default 600); sign-in allows 10 failed attempts per 15 minutes
- **Implementation:** express-rate-limit middleware
- **Behind a proxy:** set `TRUST_PROXY` so the real client IP is used

**2. Per-Sender Hourly Limit** (`rateLimit.service.ts`)

- **Purpose:** Prevent spam and SMTP server bans
- **Limit:** `MAX_EMAILS_PER_HOUR_PER_SENDER` (default 100)
- **Implementation:** Atomic Redis counter (Lua script) per sender and UTC hour window, key `rate_limit:{senderId}:{YYYY-MM-DD-HH}`
- **When full:** The email is set to `RETRYING` and delayed until the next hour, without using a retry attempt

**3. Global Gap Between Sends** (`emailWorker.ts`)

- `MIN_DELAY_BETWEEN_EMAILS_MS` (default 2000) is the minimum gap between any two sends across all workers, enforced by the BullMQ limiter in Redis

### Retries

Each job gets 3 attempts with exponential backoff. Between attempts the email is `RETRYING`; after the last one it is `FAILED`. Failed emails can be retried from the UI (`POST /api/emails/:emailId/retry`).

### Concurrency

- **Setting:** `WORKER_CONCURRENCY` (default 5) jobs per worker process
- **Safety:** The hourly limit and global send gap are enforced in Redis, so they hold across concurrent jobs and multiple worker processes. A per-email Redis lock prevents the same email being sent twice.

---

## ✨ Features Implemented

### Backend Features

| Feature                        | Implementation                          | Files                                            |
| ------------------------------ | --------------------------------------- | ------------------------------------------------ |
| **Email Scheduling**           | BullMQ delayed jobs (job ID = email ID) | `queues/emailQueue.ts`, `workers/emailWorker.ts` |
| **Bulk Scheduling**            | Up to 500 recipients per request        | `controllers/email.controller.ts`                |
| **Persistence on Restart**     | Requeue unsent emails from DB           | `loaders/requeueOnRestart.ts`                    |
| **Rate Limiting (API)**        | express-rate-limit middleware           | `middlewares/apiRate.middleware.ts`              |
| **Rate Limiting (Per-Sender)** | Atomic Redis counters, UTC hour windows | `services/rateLimit.service.ts`                  |
| **Global Send Gap**            | BullMQ limiter                          | `workers/emailWorker.ts`                         |
| **Concurrency Control**        | BullMQ worker concurrency               | `workers/emailWorker.ts`                         |
| **Standalone Worker**          | Separate worker process                 | `worker.ts`                                      |
| **Google Sign-In**             | Google ID token → app JWT               | `controllers/auth.controller.ts`                 |
| **Auth Config**                | Required JWT/Google settings            | `config/auth.ts`                                 |
| **Multi-Sender Support**       | Sender CRUD, optional own SMTP          | `services/sender.service.ts`                     |
| **Cancel & Retry**             | Cancel scheduled, retry failed          | `controllers/email.controller.ts`                |
| **Email Logging**              | Audit trail for all emails              | `services/emailLog.service.ts`                   |
| **Idempotency**                | Prevent duplicate schedules             | `email.service.ts` (idempotency_key)             |
| **SMTP Integration**           | Nodemailer with Ethereal                | `config/mailer.ts`                               |
| **Database**                   | Supabase PostgreSQL                     | `config/supabase.ts`                             |
| **Data Transformation**        | Snake_case to camelCase                 | `services/email.service.ts`                      |

### Frontend Features

| Feature                    | Implementation                          | Files                     |
| -------------------------- | --------------------------------------- | ------------------------- |
| **Google OAuth Login**     | @react-oauth/google                     | `auth/GoogleAuth.tsx`     |
| **Authentication Context** | React Context API                       | `auth/AuthContext.tsx`    |
| **Protected Routes**       | Route wrapper with auth check           | `auth/RequireAuth.tsx`    |
| **Dashboard**              | Stats, Scheduled and Sent tabs, details | `pages/Dashboard.tsx`     |
| **Cancel & Retry**         | Detail view actions                     | `pages/Dashboard.tsx`     |
| **Compose Email**          | Schedule email form, CSV/TXT upload     | `pages/ComposeEmail.tsx`  |
| **Send Spacing**           | Delay + hourly limit per send time      | `utils/schedule.ts`       |
| **API Service Layer**      | Centralized HTTP client                 | `services/api.service.ts` |
| **Runtime Config**         | API URL and Google client ID            | `config.ts`               |
| **Email Parsing**          | Parse comma/semicolon lists and CSV     | `utils/parseEmails.ts`    |

---

## 🚀 How to Run the Complete Application

### Step 1: Start Redis

**Windows:**

```powershell
# Download Redis from https://github.com/microsoftarchive/redis/releases
# Or use WSL
wsl
sudo service redis-server start
redis-cli ping  # Should return PONG
```

**macOS:**

```bash
brew services start redis
redis-cli ping  # Should return PONG
```

**Linux:**

```bash
sudo systemctl start redis
redis-cli ping  # Should return PONG
```

### Step 2: Setup Ethereal Email (for testing)

1. Go to https://ethereal.email/
2. Click **"Create Ethereal Account"**
3. Copy the credentials displayed:
   ```
   Host: smtp.ethereal.email
   Port: 587
   Username: your-generated-username@ethereal.email
   Password: your-generated-password
   ```
4. Use these in backend `.env`:
   ```env
   SMTP_HOST=smtp.ethereal.email
   SMTP_PORT=587
   ETHEREAL_USER=your-generated-username@ethereal.email
   ETHEREAL_PASS=your-generated-password
   ```

### Step 3: Setup Supabase Database

1. Go to https://supabase.com/ and create project
2. Go to **Settings → API**
3. Copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role secret** → `SUPABASE_SERVICE_ROLE_KEY`
4. Go to **Settings → Database** and copy the connection string → `DATABASE_URL`
5. Create the tables (`users`, `senders`, `emails`, `email_logs`) from `backend/prisma/schema.prisma`:
   ```bash
   cd backend
   npm run prisma:push
   ```

### Step 4: Run Backend

```bash
cd backend

# Install dependencies
npm install

# Create .env file (see Backend README for full config)
cp .env.example .env
# Edit .env with your credentials

# Start server (includes BullMQ worker)
npm run dev

# Server will start on http://localhost:5000
```

**What starts:**

- ✅ Express API server on port 5000
- ✅ BullMQ email worker (unless `RUN_WORKER=false`)
- ✅ Redis connection for queue storage
- ✅ SMTP connection check
- ✅ Restart recovery (requeues unsent emails)

To run the worker as its own process instead, set `RUN_WORKER=false` and run `npm run worker` in a second terminal.

**With Docker:** `cd backend && docker compose up --build` starts Redis, the API (`RUN_WORKER=false`), and a separate worker container, all reading `backend/.env`.

### Step 5: Run Frontend

```bash
cd frontend

# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Set:
# VITE_API_BASE_URL=http://localhost:5000/api
# VITE_GOOGLE_CLIENT_ID=your-google-client-id

# Start development server
npm run dev

# Frontend will start on http://localhost:5173
```

### Step 6: Test the Application

1. Open http://localhost:5173
2. Click **"Sign in with Google"**
3. Compose a new email
4. Schedule it for 1 minute from now
5. Watch the dashboard update when email is sent
6. Check Ethereal inbox: https://ethereal.email/messages

---

## 📝 License

MIT
