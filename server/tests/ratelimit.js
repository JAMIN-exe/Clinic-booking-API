const BASE = process.env.BASE || 'http://localhost:3000';
const headers = { 'Content-Type': 'application/json', 'X-API-Key': process.env.API_KEY };

const send = async (email) => {
  const r = await fetch(`${BASE}/bookings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ slot_id: 'nope', name: 'Spammer', email }),
  });
  return { status: r.status, retryAfter: r.headers.get('Retry-After') };
};

await fetch(`${BASE}/reset`, { method: 'POST', headers, body: JSON.stringify({ slots: [] }) });

console.log('--- one email, 7 attempts one after another ---');
for (let i = 1; i <= 7; i++) {
  const { status, retryAfter } = await send('spam@example.com');
  console.log(`attempt ${i}: ${status}${retryAfter ? `  Retry-After: ${retryAfter}` : ''}`);
}

console.log('--- a different email is not affected ---');
console.log('other email:', (await send('calm@example.com')).status);

await fetch(`${BASE}/reset`, { method: 'POST', headers, body: JSON.stringify({ slots: [] }) });

console.log('--- 10 attempts at the same moment, one email ---');
const results = await Promise.all(Array.from({ length: 10 }, () => send('burst@example.com')));
const counts = {};
for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
console.log(counts);