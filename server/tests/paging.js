const BASE = 'http://localhost:3000';
const headers = { 'Content-Type': 'application/json', 'X-API-Key': process.env.API_KEY };
const call = (path, opts = {}) =>
  fetch(BASE + path, { ...opts, headers: { ...headers, ...opts.headers } })
    .then(async (r) => ({ status: r.status, data: await r.json() }));

// 6 future slots
const slots = Array.from({ length: 6 }, (_, i) => ({
  id: `p${i + 1}`,
  provider: 'Dr Ade',
  start: `2030-01-0${i + 1}T09:00:00Z`,
  end: `2030-01-0${i + 1}T09:30:00Z`,
}));
await call('/reset', { method: 'POST', body: JSON.stringify({ slots }) });

// 5 bookings for one person (mixed case), 1 for someone else, one at a time
for (let i = 1; i <= 5; i++) {
  await call('/bookings', {
    method: 'POST',
    body: JSON.stringify({ slot_id: `p${i}`, name: 'Pager', email: 'Pager@Example.com' }),
  });
}
await call('/bookings', {
  method: 'POST',
  body: JSON.stringify({ slot_id: 'p6', name: 'Other', email: 'other@example.com' }),
});

// Walk through the pages, looking the person up with different capital letters
let cursor = null;
let page = 1;
do {
  const q = `/bookings?email=${encodeURIComponent('PAGER@example.COM')}&limit=2` +
    (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
  const { status, data } = await call(q);
  console.log(`Page ${page}: status ${status}, slots ${data.bookings.map((b) => b.slot_id)}, next_cursor ${data.next_cursor ? 'yes' : 'null'}`);
  cursor = data.next_cursor;
  page++;
} while (cursor);

// Things that must be refused with 400
for (const bad of ['limit=0', 'limit=51', 'limit=abc', 'limit=2.5', 'cursor=!!!']) {
  const { status } = await call(`/bookings?email=pager@example.com&${bad}`);
  console.log(`${bad} -> ${status}`);
}
const noEmail = await call('/bookings');
console.log(`no email -> ${noEmail.status}`);