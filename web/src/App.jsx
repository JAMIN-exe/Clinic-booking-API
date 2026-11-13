import { useEffect, useMemo, useRef, useState } from 'react';

const API = import.meta.env.VITE_API_URL;
const KEY = import.meta.env.VITE_API_KEY;

// One helper for every request: adds the API key and reads the JSON reply
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY, ...opts.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    err.retryAfter = res.headers.get('Retry-After');
    throw err;
  }
  return data;
}

const fmt = (iso) =>
  new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

export default function App() {
  const [slots, setSlots] = useState([]);
  const [provider, setProvider] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({ name: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [booking, setBooking] = useState(null);
  const idemKey = useRef(crypto.randomUUID());

  // Rate limit countdown
  const [retryUntil, setRetryUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const retryIn = Math.max(0, Math.ceil((retryUntil - now) / 1000));

  async function loadSlots() {
    try {
      setLoadError('');
      const data = await api('/slots');
      setSlots(data.slots);
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSlots();
  }, []);

  // Ticks only while there is a wait, then cleans itself up
  useEffect(() => {
    if (retryUntil <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [retryUntil]);

  const providers = useMemo(() => [...new Set(slots.map((s) => s.provider))], [slots]);
  const visible = slots.filter((s) => !provider || s.provider === provider);

  function pick(slot) {
    setSelected(slot);
    setError('');
    idemKey.current = crypto.randomUUID(); // different slot = new request
  }

  function onChange(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    idemKey.current = crypto.randomUUID(); // edited details = new request
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const b = await api('/bookings', {
        method: 'POST',
        headers: { 'Idempotency-Key': idemKey.current },
        body: JSON.stringify({ slot_id: selected.id, ...form }),
      });
      setBooking({ ...b, slot: selected });
      setSelected(null);
      loadSlots();
    } catch (err) {
      if (err.status === 429) {
        const secs = Number(err.retryAfter) || 60;
        setNow(Date.now());
        setRetryUntil(Date.now() + secs * 1000);
      } else if (err.status === 409) {
        setError('Sorry, that slot was just taken. Please pick another.');
        setSelected(null);
        loadSlots();
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancelBooking() {
    setBusy(true);
    setError('');
    try {
      const cancelled = await api(`/bookings/${booking.id}`, { method: 'DELETE' });
      setBooking({ ...cancelled, slot: booking.slot });
      loadSlots(); // the slot is free again
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function bookAnother() {
    setBooking(null);
    setSelected(null);
    setForm({ name: '', email: '' });
    setError('');
    idemKey.current = crypto.randomUUID();
    loadSlots();
  }

  // ---------- Confirmation card ----------
  if (booking) {
    const cancelled = booking.status === 'cancelled';
    return (
      <main className="mx-auto max-w-2xl p-4 sm:p-8">
        <section className="rounded-xl border p-5">
          <h1 className="text-xl font-bold">
            {cancelled ? 'Booking cancelled' : 'Booking confirmed ✅'}
          </h1>

          <dl className="mt-4 space-y-1 text-sm">
            <div>
              <dt className="inline font-medium">Reference: </dt>
              <dd className="inline font-mono">{booking.id}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Name: </dt>
              <dd className="inline">{booking.name}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Email: </dt>
              <dd className="inline">{booking.email}</dd>
            </div>
            {booking.slot && (
              <div>
                <dt className="inline font-medium">Appointment: </dt>
                <dd className="inline">
                  {booking.slot.provider}, {fmt(booking.slot.start)}
                </dd>
              </div>
            )}
                        <div>
              <dt className="inline font-medium">Booked on: </dt>
              <dd className="inline">
                {new Date(booking.created_at).toLocaleString('en-US', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                })}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">Status: </dt>
              <dd className="inline">{booking.status}</dd>
            </div>
          </dl>

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

          <div className="mt-5 flex gap-3">
            {!cancelled && (
              <button
                onClick={cancelBooking}
                disabled={busy}
                className="rounded-lg border border-red-500 px-4 py-2 text-red-600 disabled:opacity-50"
              >
                {busy ? 'Cancelling…' : 'Cancel booking'}
              </button>
            )}
            <button onClick={bookAnother} className="rounded-lg bg-black px-4 py-2 text-white">
              Book another
            </button>
          </div>
        </section>
      </main>
    );
  }

  // ---------- Slot list and booking form ----------
  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-8">
      <h1 className="text-2xl font-bold">Book an appointment</h1>

      <div className="mt-4">
        <label htmlFor="prov" className="text-sm font-medium">
          Provider
        </label>
        <select
          id="prov"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="ml-2 rounded border p-1"
        >
          <option value="">All</option>
          {providers.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </div>

      {loading && <p className="mt-6 text-gray-500">Loading slots…</p>}
      {loadError && <p className="mt-6 text-red-600">Couldn't load slots: {loadError}</p>}

      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {visible.map((s) => {
          const past = new Date(s.start) <= new Date();
          const disabled = !s.available || past;
          return (
            <li key={s.id}>
              <button
                disabled={disabled}
                onClick={() => pick(s)}
                className={`w-full rounded-lg border p-3 text-left ${
                  selected?.id === s.id ? 'border-black ring-2 ring-black' : ''
                } ${disabled ? 'cursor-not-allowed bg-gray-100 text-gray-400' : 'hover:bg-gray-50'}`}
              >
                <div className="font-medium">{s.provider}</div>
                <div className="text-sm">{fmt(s.start)}</div>
                <div className="text-xs">
                  {past ? 'Past' : s.available ? 'Available' : 'Booked'}
                </div>
              </button>
            </li>
          );
        })}
      </ul>

      {selected && (
        <form onSubmit={submit} className="mt-6 space-y-3 rounded-xl border p-5">
          <h2 className="font-semibold">
            Your details for {selected.provider}, {fmt(selected.start)}
          </h2>
          <input
            required
            placeholder="Full name"
            value={form.name}
            onChange={(e) => onChange('name', e.target.value)}
            className="w-full rounded border p-2"
          />
          <input
            required
            type="email"
            placeholder="Email"
            value={form.email}
            onChange={(e) => onChange('email', e.target.value)}
            className="w-full rounded border p-2"
          />
          {retryIn > 0 && (
            <p className="text-sm text-amber-700">
              Too many attempts. You can try again in {retryIn}s.
            </p>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            disabled={busy || retryIn > 0}
            className="rounded-lg bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {busy ? 'Booking…' : retryIn > 0 ? `Wait ${retryIn}s` : 'Confirm booking'}
          </button>
        </form>
      )}

      {!selected && error && <p className="mt-4 text-sm text-red-600">{error}</p>}
    </main>
  );
}