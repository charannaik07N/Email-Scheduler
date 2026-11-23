# 🚀 Email Scheduler - Complete Setup & Execution Guide

This guide will help you set up and run the Email Scheduler application step-by-step.

---

## 📋 Prerequisites Checklist

Before starting, make sure you have:

- ✅ Node.js 20+ installed
- ✅ Redis installed (or cloud Redis URL)
- ✅ Supabase account
- ✅ Google Cloud project with an OAuth Client ID (sign-in is Google only)
- ✅ SMTP credentials (Ethereal Email for testing)

---

## ⚡ Quick Start

### Step 1: Install Dependencies

```bash
# Navigate to project root
cd email-scheduler

# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

### Step 2: Create a Google OAuth Client ID

1. Go to https://console.cloud.google.com/ → **APIs & Services → Credentials**
2. **Create Credentials → OAuth Client ID**, type **Web application**
3. Add `http://localhost:5173` to **Authorized JavaScript origins**
4. Copy the Client ID; it goes in both `.env` files below

### Step 3: Get Ethereal Email Credentials

1. Go to https://ethereal.email/create
2. Click "Create Ethereal Account"
3. Copy the username and password

Ethereal catches emails instead of delivering them; view them at https://ethereal.email/messages.

### Step 4: Configure Environment Variables

#### Backend (.env file)

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env`:

```env
# Server Configuration
PORT=5000
NODE_ENV=development
LOG_LEVEL=info

# Required. Signs login tokens; the server refuses to start without it.
# Generate one with: openssl rand -hex 32
JWT_SECRET=

# Required. Same value as the frontend's VITE_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com

# Supabase Configuration (Settings → API)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Only used by the Prisma CLI (Settings → Database → connection string)
DATABASE_URL=postgresql://postgres:password@db.your-project.supabase.co:5432/postgres

# Redis Configuration (local)
REDIS_URL=redis://localhost:6379

# SMTP Configuration (Ethereal Email for testing)
SMTP_HOST=smtp.ethereal.email
SMTP_PORT=587
ETHEREAL_USER=your-ethereal-username@ethereal.email
ETHEREAL_PASS=your-ethereal-password
```

Optional settings (defaults shown in `backend/.env.example`): `RUN_WORKER`, `WORKER_CONCURRENCY`, `MIN_DELAY_BETWEEN_EMAILS_MS`, `MAX_EMAILS_PER_HOUR_PER_SENDER`, `CORS_ORIGIN`, `API_RATE_LIMIT_PER_15_MIN`, `TRUST_PROXY`.

#### Frontend (.env file)

Create `frontend/.env`:

```env
# API Base URL (including /api)
VITE_API_BASE_URL=http://localhost:5000/api

# Google OAuth Client ID (same as the backend's GOOGLE_CLIENT_ID)
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

### Step 5: Setup Supabase Database

Create the tables (`users`, `senders`, `emails`, `email_logs`) from `backend/prisma/schema.prisma`:

```bash
cd backend
npm run prisma:push
```

This needs `DATABASE_URL`. On an existing database, compare it with the schema before pushing.

You don't need to create users or senders by hand: signing in with Google creates your user and a default sender with your Google email.

### Step 6: Start Redis

**Windows (using Memurai):**

```bash
# Download from https://www.memurai.com/
# Install and start Memurai service
# Or start Redis from command line:
redis-server
```

**macOS:** `brew services start redis`

**Verify Redis is running:**

```bash
redis-cli ping
# Should return: PONG
```

**Alternative: Use Cloud Redis**

- Sign up at https://upstash.com/ (free tier)
- Create a Redis database
- Copy the Redis URL
- Update `backend/.env`:
  ```env
  REDIS_URL=redis://default:your-password@your-redis-url.upstash.io:6379
  ```

### Step 7: Start the Application

**Terminal 1 - Backend:**

```bash
cd backend
npm run dev
```

**Expected output:**

```
🚀 Starting Email Scheduler Server...
✅ Redis ping successful
🚀 Email worker started (concurrency 5)
✅ Server is running on port 5000 (worker on)
✅ SMTP connection verified successfully
```

If it exits with `Missing required environment variable JWT_SECRET` (or `GOOGLE_CLIENT_ID`, or a Supabase error), fill in that value in `backend/.env`.

To run the worker as a separate process, set `RUN_WORKER=false` and run `npm run worker` in another terminal.

**Terminal 2 - Frontend:**

```bash
cd frontend
npm run dev
```

**Expected output:**

```
  VITE v7.x.x  ready in xxx ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

### Step 8: Sign In

1. Open `http://localhost:5173`
2. Click **"Sign in with Google"**
3. You land on the Dashboard

---

## ✅ Testing the Compose Feature

### Test 1: Verify Senders Are Loading

1. Open browser DevTools (F12) → Network tab
2. Click "Compose" button
3. Check for `/api/emails/senders` request
4. Should return 200 OK with your default sender

### Test 2: Send a Test Email

1. **Click "Compose"**
2. **From**: Select your sender
3. **To**: Enter `recipient@test.com` (or upload a CSV/TXT list)
4. **Subject**: "Test Email"
5. **Body**: "Hello, this is a test!"
6. Optionally set **Delay between 2 emails (seconds)** and **Hourly Limit**; with several recipients these space out the send times
7. **Click "Send Later"**
8. **Pick a time** (or "Tomorrow, 11:00 AM")
9. **Click "Schedule"**

**Expected:**

- Success message: "✅ 1 email(s) scheduled successfully!"
- Compose window closes
- Email appears in "Scheduled" tab

### Test 3: View, Cancel, and Retry

1. Go to the **Scheduled** tab
2. Click your email to view details and its log
3. **Cancel email** removes a scheduled email (it is deleted)
4. A failed email in the **Sent** tab shows **Retry now**

---

## 🔧 Troubleshooting

### Problem: Backend exits on startup

- `Missing required environment variable ...`: set `JWT_SECRET` and `GOOGLE_CLIENT_ID` in `backend/.env`
- `Missing Supabase configuration`: set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`

### Problem: Google sign-in fails

- `VITE_GOOGLE_CLIENT_ID` (frontend) and `GOOGLE_CLIENT_ID` (backend) must be the same Client ID
- `http://localhost:5173` must be an authorized JavaScript origin for that Client ID
- Check the backend terminal for "Rejected Google token"

### Problem: "500 Internal Server Error" on `/api/emails/senders`

1. **Check backend logs** - Look for error messages in the terminal
2. **Check the tables exist** - run `npm run prisma:push` (see Step 5)
3. **Check Supabase connection** - verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`

### Problem: Can't create a sender

Without its own SMTP settings, a sender's email must be your account (Google) email. To send from another address, give the sender its own `smtpHost`, `smtpUser`, and `smtpPass` (see `backend/API_DOCS.md`).

### Problem: Redis connection error

**Solutions:**

- Make sure Redis is running: `redis-cli ping`
- Check `REDIS_URL` in `backend/.env` (default `redis://localhost:6379`)

### Problem: Emails not sending

**Check:**

1. **A worker is running** - Look for "Email worker started" in the backend (or worker) terminal. With `RUN_WORKER=false` you must run `npm run worker` separately.
2. **SMTP credentials are correct** - Check `ETHEREAL_USER` / `ETHEREAL_PASS`
3. **Hourly limit** - Emails over `MAX_EMAILS_PER_HOUR_PER_SENDER` show `RETRYING` and wait for the next hour
4. **Check the email's log** in the detail view, or the `email_logs` table in Supabase

### Problem: Frontend can't connect to backend

**Solutions:**

- Verify backend is running on port 5000
- Check `VITE_API_BASE_URL` in `frontend/.env`
- Check `CORS_ORIGIN` in `backend/.env` (should include `http://localhost:5173`)

---

## 📊 Verify Everything is Working

### Backend Health Check

```bash
curl http://localhost:5000/health
```

**Expected**: `{"status":"healthy",...}`

### Database Check

**Supabase SQL Editor:**

```sql
SELECT * FROM users;
SELECT * FROM senders;
SELECT * FROM emails ORDER BY created_at DESC LIMIT 10;
SELECT * FROM email_logs ORDER BY created_at DESC LIMIT 10;
```

### Redis Check

```bash
redis-cli
> KEYS *
> EXIT
```

---

## 🎯 Complete Workflow Test

1. ✅ Start backend → See startup messages
2. ✅ Start frontend → Open in browser
3. ✅ Sign in with Google
4. ✅ Click Compose → No errors
5. ✅ See sender in dropdown
6. ✅ Add recipient
7. ✅ Fill subject and body
8. ✅ Schedule email
9. ✅ See success message
10. ✅ Check Scheduled tab → Email appears
11. ✅ Check Supabase → Email in database with status "SCHEDULED"

---

## 📝 Common Commands

```bash
# Backend
cd backend
npm run dev          # Start development server (API + worker)
npm run worker       # Start a standalone worker (use with RUN_WORKER=false)
npm run build        # Build for production
npm run typecheck    # Type-check without building
npm start            # Start production server
npm run start:worker # Start production standalone worker
npm run prisma:push  # Create/update database tables
npm run prisma:studio # Browse the database

# Frontend
cd frontend
npm run dev          # Start development server
npm run build        # Build for production
npm run preview      # Preview production build

# Redis
redis-cli ping       # Check if Redis is running
redis-cli            # Open Redis CLI
redis-cli FLUSHALL   # Clear all Redis data (use carefully!)
```

---

## 🐛 Enable Debug Mode

Add to `backend/.env`:

```env
LOG_LEVEL=debug
```

This will show detailed logs in the backend terminal.

---

## 📞 Still Having Issues?

1. **Check backend terminal** for error messages
2. **Check browser console** (F12) for frontend errors
3. **Check Supabase logs** in the dashboard
4. **Verify all environment variables** are set correctly
5. **Make sure all services are running**:
   - ✅ Redis
   - ✅ Backend on port 5000 (and the worker)
   - ✅ Frontend on port 5173

---

## 🎉 Success!

If you can compose and schedule an email successfully, everything is working!

Next steps:

- Add more senders
- Schedule bulk emails
- Upload CSV recipient lists
- Check email logs
- Monitor sent emails

---

**Need help?** Check the main README.md for more detailed information.
