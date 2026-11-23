import { supabaseServiceClient } from '../config/supabase';
import { logger } from '../utils/logger';

// Database row (snake_case, matches the Supabase `users` table)
interface UserRow {
  id: string;
  email: string;
  name?: string | null;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  email: string;
  name?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserData {
  email: string;
  name?: string;
}

export interface UpdateUserData {
  name?: string;
}

const NO_ROWS = 'PGRST116';

const transformUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Get the user with this email, creating it on first sign-in. Safe when two
 * sign-ins race: the loser of the insert hits the unique email index and
 * reads the row the winner created.
 */
export const findOrCreateUser = async (data: CreateUserData): Promise<{ user: User; created: boolean }> => {
  const existing = await getUserByEmail(data.email);
  if (existing) return { user: existing, created: false };

  // New accounts store the address in lower case, so the unique index also
  // stops two sign-ins that differ only in case from making two accounts.
  const { data: row, error } = await supabaseServiceClient
    .from('users')
    .insert([{ email: data.email.trim().toLowerCase(), name: data.name || null }])
    .select()
    .single();
  if (!error) return { user: transformUser(row as UserRow), created: true };

  if (error.code === '23505') {
    const winner = await getUserByEmail(data.email);
    if (winner) return { user: winner, created: false };
  }
  logger.error('❌ Create user error:', error);
  throw error;
};

/** Escape LIKE wildcards, so an address is matched literally ("_" is common in addresses). */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * Find a user by email, ignoring case: accounts from the old sign-up form kept
 * the address as typed ("Alice@Example.com"), while Google reports it in lower
 * case. If several accounts differ only in case, the one spelled exactly as
 * given wins, otherwise the oldest.
 */
export const getUserByEmail = async (email: string): Promise<User | null> => {
  const wanted = email.trim();
  const { data: rows, error } = await supabaseServiceClient
    .from('users')
    .select('*')
    .ilike('email', escapeLike(wanted))
    .order('created_at', { ascending: true })
    .limit(10);

  if (error) {
    logger.error('❌ Get user by email error:', error);
    throw error;
  }
  const matches = (rows ?? []) as UserRow[];
  const match = matches.find((row) => row.email === wanted) ?? matches[0];
  return match ? transformUser(match) : null;
};

export const getUserById = async (id: string): Promise<User | null> => {
  const { data: user, error } = await supabaseServiceClient
    .from('users')
    .select('*')
    .eq('id', id)
    .single();

  if (error && error.code !== NO_ROWS) {
    logger.error('❌ Get user by ID error:', error);
    throw error;
  }
  return user ? transformUser(user as UserRow) : null;
};

export const updateUser = async (id: string, data: UpdateUserData): Promise<User> => {
  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (data.name !== undefined) updateData.name = data.name;

  const { data: user, error } = await supabaseServiceClient
    .from('users')
    .update(updateData)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    logger.error('❌ Update user error:', error);
    throw error;
  }
  return transformUser(user as UserRow);
};
