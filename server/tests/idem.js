const BASE = process.env.BASE || 'http://localhost:3000';
const headers = {
  'Content-Type': 'application/json',
  'X-API-Key': process.env.API_KEY,
  'Idempotency-Key': 'race-key-1',
};

const results = await Promise.all(
  Array.from({ length: 10 }, () =>
    fetch(`${BASE}/bookings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ slot_id: 's2', name: 'Same Person', email: 'same@example.com' }),
    }).then(async (r) => `${r.status} ${(await r.json()).id}`)
  )
);

console.log([...new Set(results)]);
