import pg from 'pg';

// BIGINT/int8 columns (users.id, devices.id, devices.owner_user_id) come
// back from `pg` as strings by default — JS numbers can't safely hold
// every 64-bit value — but this app uses those ids as WebSocket-registry
// Map keys (ws/registry.js) that get registered with real numbers
// (Number(jwt.sub)). A string "1" and a number 1 are different Map keys,
// which silently broke state-change broadcast routing until caught by
// live end-to-end testing. IDs here will never approach
// Number.MAX_SAFE_INTEGER, so parsing every BIGINT column as a plain
// number, globally, is safe and closes off the whole bug class at once.
pg.types.setTypeParser(20, (value) => parseInt(value, 10));

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// A client sitting idle in the pool can still emit an 'error' (e.g. the
// backend killed the connection). Without a listener here, that's an
// unhandled 'error' event, which crashes the whole process — this just
// logs it and lets the pool recycle the client.
pool.on('error', (err) => console.error('unexpected pg pool error', err));
