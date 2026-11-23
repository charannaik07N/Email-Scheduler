const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. See backend/.env.example.`);
  }
  return value;
};

export const JWT_SECRET = requireEnv('JWT_SECRET');
export const JWT_EXPIRES_IN = '7d';

// Comma-separated list, so web and other clients can share one backend.
export const GOOGLE_CLIENT_IDS = requireEnv('GOOGLE_CLIENT_ID')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
