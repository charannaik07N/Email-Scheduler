# 📧 Email Scheduler - Frontend

React + TypeScript + Vite frontend for the Email Scheduler application.

---

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- Backend server running on port 5000

### Installation

```bash
# Navigate to frontend directory
cd frontend

# Install dependencies
npm install

# Create environment file
cp .env.example .env
```

### Environment Variables

Create a `.env` file in the frontend directory:

```env
# Backend API base URL, including /api
VITE_API_BASE_URL=http://localhost:5000/api

# Google OAuth Client ID (the backend's GOOGLE_CLIENT_ID must match)
VITE_GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
```

### Running the Application

```bash
# Development mode (with hot reload)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Lint code
npm run lint
```

The app will be available at **http://localhost:5173**

---

## 📁 Project Structure

```
frontend/
├── public/                 # Static assets
├── src/
│   ├── auth/              # Authentication
│   │   ├── AuthContext.tsx    # Auth state, Google login, logout
│   │   ├── GoogleAuth.tsx     # Google sign-in button
│   │   ├── RequireAuth.tsx    # Protected route wrapper
│   │   └── index.ts           # Exports
│   ├── pages/             # Application pages
│   │   ├── Dashboard.tsx      # Stats, Scheduled/Sent tabs, detail view
│   │   ├── Login.tsx          # Login page
│   │   └── ComposeEmail.tsx   # Compose and schedule emails
│   ├── services/          # API services
│   │   ├── api.service.ts     # Axios client (token, 401 handling)
│   │   └── email.service.ts   # Email API calls
│   ├── types/             # TypeScript types
│   │   ├── email.types.ts     # Email, sender, API types
│   │   └── index.ts           # Type exports
│   ├── utils/             # Utility functions
│   │   ├── parseEmails.ts     # Recipient parsing (text, CSV/TXT)
│   │   └── schedule.ts        # Send-time spacing, datetime helpers
│   ├── config.ts          # API URL and Google client ID from env
│   ├── App.tsx            # Routes
│   ├── main.tsx           # Entry point (GoogleOAuthProvider)
│   └── index.css          # Global styles (Tailwind)
├── .env.example           # Environment template
├── index.html             # HTML template
├── package.json           # Dependencies
├── tsconfig.json          # TypeScript config
└── vite.config.ts         # Vite config (React + Tailwind plugins)
```

---

## 🔐 Authentication Flow

### Google OAuth Login

Sign-in is Google only.

1. User clicks "Sign in with Google" button
2. Google OAuth popup opens
3. User grants permission
4. Frontend receives the Google ID token (`credential`)
5. Frontend sends it to the backend: `POST /api/auth/google-login` with `{ googleToken }`
6. Backend verifies the token and returns an app JWT and the user
7. JWT stored in localStorage (`authToken`), user in localStorage (`user`)
8. User redirected to the Dashboard

### Protected Routes

Routes are defined in `App.tsx`:

```tsx
<Route path="/login" element={<Login />} />
<Route
  path="/dashboard"
  element={
    <RequireAuth>
      <Dashboard />
    </RequireAuth>
  }
/>
<Route path="*" element={<Navigate to="/login" replace />} />
```

Compose and the email detail view are views inside the Dashboard, not separate routes.

---

## 📡 API Services

### Auth (`auth/AuthContext.tsx`)

```typescript
const { user, loginWithGoogle, logout } = useAuth();

// Exchange the Google credential for an app token
loginWithGoogle(credential: string): Promise<void>
```

### Email Service (`services/email.service.ts`)

```typescript
// SCHEDULED + RETRYING emails, paginated
emailService.getScheduledEmails(page?, signal?)

// SENT + FAILED emails, paginated
emailService.getSentEmails(page?, signal?)

// Counts; sends the browser's timezone offset
emailService.getEmailStats(signal?)

emailService.getSenders()

// POST /emails/schedule/bulk
emailService.scheduleBulk(request: BulkScheduleRequest)

// DELETE /emails/:id
emailService.cancelScheduledEmail(emailId: string)

// POST /emails/:id/retry
emailService.retryFailedEmail(emailId: string)
```

All methods return `ApiResponse<T>` (`{ success, data?, message?, error? }`) instead of throwing.

---

## 🛠️ Tech Stack

| Technology          | Version | Purpose      |
| ------------------- | ------- | ------------ |
| React               | 19.x    | UI library   |
| TypeScript          | 5.x     | Type safety  |
| Vite                | 7.x     | Build tool   |
| Tailwind CSS        | 4.x     | Styling      |
| React Router        | 7.x     | Routing      |
| Axios               | 1.x     | HTTP client  |
| @react-oauth/google | 0.13.x  | Google OAuth |
| jwt-decode          | 4.x     | JWT decoding |

---

## 🔧 Available Scripts

| Command           | Description              |
| ----------------- | ------------------------ |
| `npm run dev`     | Start development server |
| `npm run build`   | Build for production     |
| `npm run preview` | Preview production build |
| `npm run lint`    | Run ESLint               |

---

## 🌐 Environment Variables

| Variable                | Required | Description                                                                   |
| ----------------------- | -------- | ----------------------------------------------------------------------------- |
| `VITE_API_BASE_URL`     | Yes      | Backend API URL including `/api` (`VITE_API_URL` is still accepted as a fallback) |
| `VITE_GOOGLE_CLIENT_ID` | Yes      | Google OAuth Client ID; must match the backend's `GOOGLE_CLIENT_ID`           |

In development, if `VITE_API_BASE_URL` is unset, `config.ts` falls back to `http://localhost:5000/api`.

---

## 📝 Notes

- All API requests include the JWT in the `Authorization: Bearer` header
- Token is stored in localStorage under `authToken`; the user under `user`
- Axios interceptor automatically attaches the token to requests
- 401 responses sign the user out; an expired stored token is discarded on load

---

## 🏗️ Implementation Guide

### How Frontend Features Are Implemented

#### 1. Google OAuth Authentication

**Files:** `main.tsx`, `auth/GoogleAuth.tsx`, `auth/AuthContext.tsx`

**Flow:**

1. `main.tsx` wraps the app in `GoogleOAuthProvider` with `GOOGLE_CLIENT_ID` from `config.ts`
2. `GoogleAuth.tsx` renders `GoogleLogin`
3. On success, the credential goes to `loginWithGoogle`
4. `AuthContext` posts `{ googleToken: credential }` to `/auth/google-login`
5. Token and user are saved to localStorage and React state
6. `Login.tsx` redirects to `/dashboard`

**Code:**

```tsx
// auth/GoogleAuth.tsx
<GoogleLogin
  onSuccess={(credentialResponse) => {
    loginWithGoogle(credentialResponse.credential);
  }}
/>
```

#### 2. Protected Routes

**File:** `auth/RequireAuth.tsx`

**Implementation:**

```tsx
export const RequireAuth = ({ children }) => {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return null;
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
};
```

#### 3. Dashboard

**File:** `pages/Dashboard.tsx`

**Features:**

- Stats from `GET /emails/stats` (scheduled, sent, failed, pending today)
- **Scheduled** tab (`SCHEDULED`, `RETRYING`) and **Sent** tab (`SENT`, `FAILED`), 50 per page with "load more"
- Search
- Refreshes every 30 seconds while the list is shown
- **Detail view** for an email, with **Cancel email** (scheduled/retrying) and **Retry now** (failed)

#### 4. Compose Email Form

**File:** `pages/ComposeEmail.tsx`

**Features:**

- Sender selection dropdown
- Recipients typed, pasted, or uploaded from a CSV/TXT file (deduplicated)
- Subject and rich-text body
- **Send Later**: date/time picker or quick picks ("Tomorrow, 11:00 AM", ...)
- **Delay between 2 emails (seconds)** and **Hourly Limit (0 = none)**

**Send spacing:** The delay and hourly limit are applied in the browser. `utils/schedule.ts` (`buildSendTimes`) gives each recipient its own send time: each email is at least the delay after the previous one, and email *i* is never earlier than `start + floor(i / hourlyLimit)` hours.

**Submit:** Recipients are sent with `POST /emails/schedule/bulk` in chunks of 500, each with its `scheduledAt` and an idempotency key (`<draftId>:<email>`). On a partial failure, only the unscheduled recipients stay in the form, so trying again doesn't create duplicates.

```tsx
const sendTimes = buildSendTimes(start, recipients.length, delayBetweenEmails, hourlyLimit);
const items = recipients.map((recipient, i) => ({
  recipientEmail: recipient.email,
  recipientName: recipient.name || undefined,
  scheduledAt: sendTimes[i].toISOString(),
  idempotencyKey: `${draftId.current}:${recipient.email}`,
}));

await emailService.scheduleBulk({ senderId, subject, body, htmlBody, recipients: chunk });
```

#### 5. API Service Layer

**File:** `services/api.service.ts`

**Features:**

- Centralized Axios instance with `baseURL` = `API_BASE_URL` from `config.ts`
- Automatic JWT token attachment
- 401 handler that signs the user out through `AuthContext`
- Errors (including partial bulk results) returned as `ApiResponse` instead of thrown

**Implementation:**

```tsx
this.client = axios.create({ baseURL: API_BASE_URL });

// Request interceptor - add token
this.client.interceptors.request.use((config) => {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Response interceptor - handle 401
this.client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) this.onUnauthorized?.();
    return Promise.reject(error);
  },
);
```

#### 6. Email Parsing Utility

**File:** `utils/parseEmails.ts`

- `parseEmails(text)` - extract every email address from typed or pasted text
- `parseRecipientsText(text)` / `parseCSV(file)` - one recipient per line, with an optional name column (comma, semicolon, or tab separated)
- `dedupeRecipients(list)` - remove duplicates

#### 7. Status Badges

**File:** `pages/Dashboard.tsx` (`STATUS_BADGE`)

- `SENT` (green)
- `SCHEDULED` (orange)
- `RETRYING` (yellow)
- `FAILED` (red)

---

## 🎨 UI/UX Implementation Details

### Styling

Tailwind CSS 4 utility classes (via `@tailwindcss/vite`), with green accents and gray text.

### State Management

**Global State:**

- Auth: `AuthContext.tsx` (React Context)
- Token and user info stored in localStorage

**Local State:**

- Component state with `useState`
- Form state with controlled inputs
- Loading states for async operations

### Error Handling

**API Errors:** Service calls return `{ success, error }`, so components check the result instead of catching:

```tsx
const response = await emailService.cancelScheduledEmail(email.id);
if (!response.success) {
  setActionError(response.error || 'Failed to cancel the email');
}
```

**Form Validation:**

- Email format validation
- Required field checks
- Schedule time must not be in the past
- Delay and hourly limit cannot be negative

---

## 🚀 Running Frontend in Different Modes

### Development Mode

```bash
npm run dev
# - Hot module replacement
# - Source maps enabled
# - Dev server on port 5173
```

### Production Build

```bash
npm run build
# - TypeScript compilation
# - Vite optimization
# - Output to dist/
```

### Preview Production Build

```bash
npm run preview
# - Serves dist/ folder
# - Test production build locally
```

### Linting

```bash
npm run lint
# - ESLint checks
```

---

## 🔧 Customization Guide

### Add New Route

1. Create page in `pages/`
2. Add route in `App.tsx`:

```tsx
<Route path="/new-page" element={<RequireAuth><NewPage /></RequireAuth>} />
```

### Add New API Endpoint

1. Add a method in `services/email.service.ts`:

```tsx
newEndpoint(): Promise<ApiResponse<Result>> {
  return apiClient.get('/emails/new-endpoint');
},
```

2. Use in component:

```tsx
const result = await emailService.newEndpoint();
```

---

## 📚 Key Dependencies Explained

| Package               | Purpose                  | Used In                             |
| --------------------- | ------------------------ | ----------------------------------- |
| `@react-oauth/google` | Google OAuth integration | `main.tsx`, `auth/GoogleAuth.tsx`   |
| `react-router-dom`    | Client-side routing      | `App.tsx`, navigation               |
| `axios`               | HTTP client              | `services/api.service.ts`, `auth/AuthContext.tsx` |
| `jwt-decode`          | Read token expiry        | `auth/AuthContext.tsx`              |
| `tailwindcss`         | Utility-first CSS        | All components                      |
| `vite`                | Build tool & dev server  | Build process                       |

---

## 🐛 Debugging Tips

### Check API Calls

Open Browser DevTools → Network tab:

- See all API requests
- Check request/response data
- Verify JWT token in headers

### Check localStorage

Console:

```javascript
localStorage.getItem("authToken");
JSON.parse(localStorage.getItem("user"));
```

### React DevTools

Install React DevTools extension:

- Inspect component tree
- Check props and state
- Track re-renders

### Common Issues

**Issue: "401 Unauthorized"**

- Sign in again (tokens expire after 7 days)
- Verify backend is running
- Check CORS settings (`CORS_ORIGIN` in the backend)

**Issue: "Network Error"**

- Verify `VITE_API_BASE_URL` in `.env`
- Check backend is running on port 5000

**Issue: Google OAuth not working**

- Verify `VITE_GOOGLE_CLIENT_ID` in `.env` matches the backend's `GOOGLE_CLIENT_ID`
- Check authorized JavaScript origins in Google Console (e.g. `http://localhost:5173`)
- Clear browser cache

---
