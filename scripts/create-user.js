// Create or update a login. Run with:
//   node scripts/create-user.js <username> <password> <admin|editor|viewer>
// Re-running with the same username upserts (password/role), so this also
// doubles as the password-reset / role-change tool.
const { createUser, hashPassword } = require('../lib/auth');

const [username, password, role] = process.argv.slice(2);
if (!username || !password || !['admin', 'editor', 'viewer'].includes(role)) {
  console.error('Usage: node scripts/create-user.js <username> <password> <admin|editor|viewer>');
  process.exit(1);
}

createUser(username, hashPassword(password), role);
console.log(`Created user "${username}" with role "${role}".`);
