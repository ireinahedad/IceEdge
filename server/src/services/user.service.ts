import bcrypt from 'bcryptjs';
import { pool } from '../db/connection';
import { toPublicUser } from './auth.service';
import {
  UserRow,
  UserPublic,
  UpdateUserBody,
  UpdatePasswordBody,
} from '../types/user.type';

const SALT_ROUNDS = 12;

// -------------------------------------------------------
//  Get all users (admin)
// -------------------------------------------------------

export async function getAllUsers(): Promise<UserPublic[]> {
  const { rows } = await pool.query<UserRow>(
    `SELECT * FROM users ORDER BY created_at DESC`,
  );
  return rows.map(toPublicUser);
}

// -------------------------------------------------------
//  Get single user by ID
// -------------------------------------------------------

export async function getUserById(id: string): Promise<UserPublic> {
  const { rows } = await pool.query<UserRow>(
    'SELECT * FROM users WHERE id = $1',
    [id],
  );

  if (!rows[0]) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }

  return toPublicUser(rows[0]);
}

// -------------------------------------------------------
//  Update user profile
// -------------------------------------------------------

export async function updateUser(id: string, body: UpdateUserBody): Promise<UserPublic> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (body.email !== undefined) {
    fields.push(`email = $${idx++}`);
    values.push(body.email.toLowerCase());
  }
  if (body.username !== undefined) {
    fields.push(`username = $${idx++}`);
    values.push(body.username.toLowerCase());
  }
  if (body.first_name !== undefined) {
    fields.push(`first_name = $${idx++}`);
    values.push(body.first_name);
  }
  if (body.last_name !== undefined) {
    fields.push(`last_name = $${idx++}`);
    values.push(body.last_name);
  }
  if (body.is_active !== undefined) {
    fields.push(`is_active = $${idx++}`);
    values.push(body.is_active);
  }

  if (fields.length === 0) {
    throw Object.assign(new Error('No fields to update'), { status: 400 });
  }

  values.push(id); // last param = WHERE id = $N

  const { rows } = await pool.query<UserRow>(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values,
  );

  if (!rows[0]) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }

  return toPublicUser(rows[0]);
}

// -------------------------------------------------------
//  Update password
// -------------------------------------------------------

export async function updatePassword(id: string, body: UpdatePasswordBody): Promise<void> {
  const { rows } = await pool.query<UserRow>(
    'SELECT * FROM users WHERE id = $1',
    [id],
  );

  const user = rows[0];
  if (!user) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }

  const valid = await bcrypt.compare(body.current_password, user.password_hash);
  if (!valid) {
    throw Object.assign(new Error('Current password is incorrect'), { status: 400 });
  }

  const newHash = await bcrypt.hash(body.new_password, SALT_ROUNDS);

  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, id]);
}

// -------------------------------------------------------
//  Delete user
// -------------------------------------------------------

export async function deleteUser(id: string): Promise<void> {
  const { rowCount } = await pool.query(
    'DELETE FROM users WHERE id = $1',
    [id],
  );

  if (!rowCount) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }
}