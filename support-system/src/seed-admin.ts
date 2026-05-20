import { seedAgent } from './auth';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const username = process.env.SUPPORT_ADMIN_USERNAME || 'admin';
const password = process.env.SUPPORT_ADMIN_PASSWORD || crypto.randomBytes(12).toString('hex');
const name = process.env.SUPPORT_ADMIN_DISPLAY_NAME || 'Admin';

seedAgent({
  username,
  name,
  password,
  role: 'admin',
}).then(() => {
  if (!process.env.SUPPORT_ADMIN_PASSWORD) {
    console.log(`============================================================`);
    console.log(`  Admin account seeded.`);
    console.log(`  Username: ${username}`);
    console.log(`  Password: ${password}  (auto-generated, save it!)`);
    console.log(`============================================================`);
  } else {
    console.log(`Admin agent seeded: ${username} / ***`);
  }
  process.exit(0);
}).catch((e) => {
  console.error('Seed failed:', e.message);
  process.exit(1);
});
