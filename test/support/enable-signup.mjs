/**
 * Test-harness helper. Self-service sign-up is OFF by default (pilot safety), but most live suites onboard restaurants through the public
 * /auth/onboard route. Run this once after the API has booted on the THROWAWAY test database:
 *   DATABASE_URL=... node test/support/enable-signup.mjs
 * It writes the setting the same way the Super Admin console does and waits until the running API reports it. Never run against production.
 */
import pg from 'pg';

const API = process.env.UAT_API || 'http://localhost:4000/api/v1';
const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required');
if (/neon\.tech|amazonaws|render\.com|supabase|railway/i.test(DB)) throw new Error('Refusing to run against a hosted database');
const db = new pg.Client({ connectionString: DB });
await db.connect();
await db.query(`INSERT INTO platform_settings (key, value, is_secret, updated_by, updated_at) VALUES ('general.selfSignupEnabled', 'true'::jsonb, false, 'test-harness', now())
                ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb`);
await db.end();
for (let i = 0; i < 40; i++) {
  const r = await fetch(`${API}/platform/config`).then((x) => x.json()).catch(() => null);
  if (r?.data?.selfSignupEnabled === true) { console.log('self sign-up enabled for tests'); process.exit(0); }
  await new Promise((r2) => setTimeout(r2, 1000));
}
throw new Error('API did not pick up the setting within 40s');
