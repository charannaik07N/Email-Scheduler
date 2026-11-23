/**
 * Runtime configuration, read once from Vite env variables.
 * Set them in frontend/.env (see .env.example).
 */

const env = import.meta.env;

// VITE_API_URL is accepted too because older docs used that name.
export const API_BASE_URL: string =
  env.VITE_API_BASE_URL ||
  env.VITE_API_URL ||
  (env.DEV ? 'http://localhost:5000/api' : 'https://email-scheduler-azure.vercel.app/api');

// A Google OAuth client ID is public, so a default is safe to ship. The backend's
// GOOGLE_CLIENT_ID must be the same value.
export const GOOGLE_CLIENT_ID: string =
  env.VITE_GOOGLE_CLIENT_ID ||
  '1033556695079-osn1ufaqhamij1uf30gfbairbbolb7l0.apps.googleusercontent.com';
