const BASE = 'http://localhost:3000';
const headers = { 'Content-Type': 'application/json', 'X-API-Key': process.env.API_KEY };

const results = await Promise.all(
  Array.from({ length: 20 }, (_, i) =>
    fetch(`${BASE}/bookings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ slot_id: 's1', name: `Tester ${i}`, email: `tester${i}@example.com` }),
    }).then((r) => r.status)
  )
);

const counts = {};
for (const s of results) counts[s] = (counts[s] || 0) + 1;
console.log(counts);