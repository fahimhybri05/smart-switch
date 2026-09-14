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
});
