# Email Scheduler API Documentation

## Base URL

```
http://localhost:5000/api
```

`GET /health` (outside `/api`) returns the server status.

## Authentication

Sign-in is with Google only. Exchange a Google ID token for an app token with `POST /auth/google-login`, then send the app token on every other request:

```
Authorization: Bearer <token>
```

Tokens expire after 7 days. A missing, invalid or expired token, or one whose account no longer exists, gets `401`.

## Response format

```json
{ "success": true, "data": { ... }, "message": "..." }
{ "success": false, "error": "..." }
```

Validation errors return `400` with `"error": "Validation error"` and a `details` array. The auth endpoints return `user` (and `token`) at the top level instead of under `data`.

## Rate limits

- All `/api` routes: `API_RATE_LIMIT_PER_15_MIN` requests per 15 minutes per signed-in user, or per client IP without a valid token (default 600).
- `POST /auth/google-login`: 10 failed attempts per 15 minutes per IP.

Exceeding a limit returns `429`.

---

## Auth

### POST /auth/google-login

Public. Verifies the Google ID token (the `credential` from Google Identity Services) with `google-auth-library` against `GOOGLE_CLIENT_ID`. Creates the user on first sign-in, along with a default sender using the account's email.

**Request:**

```json
{ "googleToken": "<Google ID token>" }
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
    "createdAt": "2026-01-30T10:00:00.000Z",
    "picture": "https://..."
  },
  "token": "<app JWT>"
}
```

`401` if the token is invalid or the Google email is not verified.

### GET /auth/profile

**Response (200):** `{ "success": true, "user": { "id", "email", "name", "createdAt" } }`

### PUT /auth/profile

Only `name` can be changed (the email is the Google identity).

**Request:** `{ "name": "New Name" }`

**Response (200):** `{ "success": true, "message": "Profile updated successfully", "user": { ... } }`

---

## Emails

All `/emails` routes require a Bearer token. Users only see emails of their own senders.

### Email statuses

| Status      | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `SCHEDULED` | Waiting in the queue                                                    |
| `RETRYING`  | An attempt failed, or the sender's hourly limit was hit; will try again |
| `SENT`      | Delivered to the SMTP server                                            |
| `FAILED`    | Gave up after all attempts                                              |

Cancelled emails are deleted, so there is no cancelled status.

### Email object

```json
{
  "id": "uuid",
  "senderId": "uuid",
  "recipientEmail": "recipient@example.com",
  "recipientName": "Recipient",
  "subject": "Hello",
  "body": "Plain text body",
  "htmlBody": "<p>Optional HTML body</p>",
  "scheduledAt": "2026-01-31T10:00:00.000Z",
  "sentAt": null,
  "status": "SCHEDULED",
  "attemptCount": 0,
  "errorMessage": null,
  "createdAt": "...",
  "updatedAt": "..."
}
```

### POST /emails/schedule

Schedule one email.

**Request:**

```json
{
  "senderId": "uuid",
  "recipientEmail": "recipient@example.com",
  "recipientName": "Recipient",
  "subject": "Hello",
  "body": "Plain text body",
  "htmlBody": "<p>optional</p>",
  "scheduledAt": "2026-01-31T10:00:00Z",
  "idempotencyKey": "optional-client-key"
}
```

- `scheduledAt`: ISO 8601 with offset; not in the past (2 minutes tolerance) and at most one year ahead.
- `idempotencyKey`: optional, unique per user. Reusing it returns the existing email (and re-queues it if it is unsent but missing from the queue).

**Response:** `201` with `data.email` when created, `200` with `"message": "Email already scheduled"` when the key was already used. `404` if the sender isn't yours, `503` if the queue is unavailable (nothing is saved).

### POST /emails/schedule/bulk

Schedule the same message to up to 500 recipients. Each recipient has its own `scheduledAt` (so the client controls spacing) and an optional `idempotencyKey`.

**Request:**

```json
{
  "senderId": "uuid",
  "subject": "Hello",
  "body": "Plain text body",
  "htmlBody": "<p>optional</p>",
  "recipients": [
    { "recipientEmail": "a@example.com", "recipientName": "A", "scheduledAt": "2026-01-31T10:00:00Z", "idempotencyKey": "draft-1:a@example.com" },
    { "recipientEmail": "b@example.com", "scheduledAt": "2026-01-31T10:00:30Z" }
  ]
}
```

**Response:**

```json
{
  "success": false,
  "message": "1 of 2 emails scheduled",
  "error": "1 emails could not be scheduled",
  "data": {
    "scheduled": [ { "...email": "..." } ],
    "failed": [ { "recipientEmail": "b@example.com", "error": "Email queue is unavailable" } ]
  }
}
```

| Status | When                                       |
| ------ | ------------------------------------------ |
| `201`  | All recipients scheduled                   |
| `207`  | Some scheduled, some failed                |
| `503`  | None scheduled because the queue is down   |
| `400`  | None scheduled: every recipient was invalid or conflicted |
| `500`  | None scheduled because of a server error   |

Failed recipients can be sent again with the same idempotency keys; already scheduled ones are not duplicated.

### GET /emails

List emails by `scheduledAt`, latest first unless `order=asc`.

| Query      | Description                                                        |
| ---------- | ------------------------------------------------------------------ |
| `status`   | Comma-separated list of `SCHEDULED`, `RETRYING`, `SENT`, `FAILED`  |
| `senderId` | Only this sender's emails                                          |
| `page`     | Page number, default 1                                             |
| `limit`    | Page size 1-100, default 50                                        |
| `order`    | `desc` (latest first, default) or `asc` (soonest first)            |

Example: `GET /emails?status=SCHEDULED,RETRYING&page=1&limit=50&order=asc`

**Response (200):**

```json
{
  "success": true,
  "data": { "data": [ { "...email": "..." } ], "total": 120, "page": 1, "pageSize": 50, "totalPages": 3 }
}
```

### GET /emails/stats

| Query      | Description                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------- |
| `tzOffset` | The browser's `new Date().getTimezoneOffset()` in minutes, so "today" is the user's today. Default 0 (UTC) |

**Response (200):**

```json
{ "success": true, "data": { "totalScheduled": 4, "totalSent": 10, "totalFailed": 1, "pendingToday": 2 } }
```

`totalScheduled` and `pendingToday` count `SCHEDULED` and `RETRYING` emails.

### GET /emails/:emailId

**Response (200):** `{ "success": true, "data": { "email": { ... }, "logs": [ { "id", "emailId", "status", "message", "createdAt" } ] } }`

### DELETE /emails/:emailId

Cancel an unsent email: its queued job is removed and the email is deleted.

- Only `SCHEDULED` or `RETRYING` emails; others get `409`.
- `409` if a worker is sending it right now.
- `503` if the queue can't be reached.

**Response (200):** `{ "success": true, "message": "Email cancelled successfully" }`

### POST /emails/:emailId/retry

Send a `FAILED` email again, now. Resets the attempt count. Other statuses get `409`, as does a retry while the last attempt is still finishing. `503` if the queue is unavailable.

**Response (200):** `{ "success": true, "message": "Email queued for retry", "data": { "email": { ... } } }`

---

## Senders

A sender is the "From" identity. Every user gets a default sender with their account email.

- **Without its own SMTP settings** a sender uses the server's SMTP account, and its `email` must equal the account email (`400` otherwise).
- **With its own SMTP settings** (`smtpHost`, plus `smtpUser` and `smtpPass`, optional `smtpPort`, default 587) it sends through that server and may use any address the server accepts.
- SMTP passwords are never returned; responses include `hasSmtpPassword: true|false` instead.

### Sender object

```json
{
  "id": "uuid",
  "userId": "uuid",
  "name": "Jane Doe",
  "email": "user@example.com",
  "smtpHost": null,
  "smtpPort": null,
  "smtpUser": null,
  "hasSmtpPassword": false,
  "createdAt": "...",
  "updatedAt": "..."
}
```

### GET /emails/senders

Lists your senders, creating the default sender if it is missing.

**Response (200):** `{ "success": true, "data": { "senders": [ ... ], "count": 1 } }`

### POST /emails/senders

**Request:**

```json
{
  "name": "Marketing",
  "email": "marketing@example.com",
  "smtpHost": "smtp.example.com",
  "smtpPort": 587,
  "smtpUser": "smtp-user",
  "smtpPass": "smtp-password"
}
```

**Response (201):** `{ "success": true, "message": "Sender created successfully", "data": { "sender": { ... } } }`

### PUT /emails/senders/:senderId

Any of the fields above; the same rules apply to the resulting sender.

**Response (200):** `{ "success": true, "message": "Sender updated successfully", "data": { "sender": { ... } } }`

### DELETE /emails/senders/:senderId

Refused with `409` while the sender still has unsent (`SCHEDULED` or `RETRYING`) emails; cancel them first.

**Response (200):** `{ "success": true, "message": "Sender deleted successfully" }`

---

## Example

```bash
TOKEN="<app token from /auth/google-login>"

curl -X POST http://localhost:5000/api/emails/schedule \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"senderId":"<sender-id>","recipientEmail":"recipient@example.com","subject":"Hello","body":"Hi there","scheduledAt":"2026-12-01T10:00:00Z"}'
```
