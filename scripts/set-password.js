'use strict';

/**
 * Rotate an administrator/observer password without editing the database by hand.
 * Usage: npm run set-password -- admin "A-new-strong-password"
 */

const db = require('../src/db');
const { hashPassword } = require('../src/security');

async function main() {
  const [username, password] = process.argv.slice(2);

  if (!username || !password) {
    console.error('Usage: npm run set-password -- <username> "<new-password>"');
    process.exitCode = 1;
    return;
  }
  if (password.length < 12) {
    console.error('Refusing to set a password shorter than 12 characters.');
    process.exitCode = 1;
    return;
  }

  await db.init();
  const account = await db.get('SELECT id, username FROM admins WHERE username = ? COLLATE NOCASE', [username]);
  if (!account) {
    console.error(`No account found with username "${username}".`);
    process.exitCode = 1;
    return;
  }

  const { hash, salt } = await hashPassword(password);
  await db.run('UPDATE admins SET password_hash = ?, password_salt = ? WHERE id = ?', [hash, salt, account.id]);
  const revoked = await db.run('DELETE FROM sessions WHERE admin_id = ?', [account.id]);
  await db.writeAudit({
    actor: 'SYSTEM',
    role: 'system',
    category: 'SECURITY',
    action: 'PASSWORD_ROTATED',
    outcome: 'SUCCESS',
    detail: `Password rotated for ${account.username}; ${revoked.changes} active session(s) revoked`,
  });

  console.log(`[SECURITY] Password updated for "${account.username}". Active sessions revoked: ${revoked.changes}.`);
}

main()
  .catch((err) => {
    console.error('[SECURITY] Password rotation failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.close();
    } catch {
      /* already closed */
    }
  });
