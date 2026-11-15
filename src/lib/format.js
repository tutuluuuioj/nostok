export function formatUsd(cents) {
  const neg = cents < 0;
  const v = Math.abs(Math.round(cents));
  const c = v % 100;
  const dollars = String(Math.floor(v / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${dollars}.${String(c).padStart(2, '0')}`;
}

export function formatApr(bps) {
  const neg = bps < 0;
  const v = Math.abs(bps);
  return `${neg ? '-' : ''}${Math.floor(v / 100)}.${String(v % 100).padStart(2, '0')}%`;
}

export function formatHundredths(hundredths) {
  if (hundredths == null) return '—';
  const neg = hundredths < 0;
  const v = Math.abs(hundredths);
  return `${neg ? '-' : ''}${Math.floor(v / 100)}.${String(v % 100).padStart(2, '0')}%`;
}

export function formatTokens(micro) {
  const neg = micro < 0;
  const v = Math.abs(Math.round(micro));
  const whole = Math.floor(v / 1000000);
  const frac = String(v % 1000000).padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function formatLeft(ms) {
  if (ms <= 0) return 'past due';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) {
    const m = Math.max(1, minutes);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const hours = Math.floor(ms / 3600000);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(ms / 86400000);
  return `${days} days`;
}

export function formatWhen(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(ms);
}

export function parseDollars(input) {
  const s = String(input ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  if (w.length > 9) return null;
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
}

export function parseTokens(input) {
  const s = String(input ?? '').trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  if (w.length > 12) return null;
  return Number(w) * 1000000 + Number((f + '000000').slice(0, 6));
}

export function parsePercent(input) {
  const s = String(input ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  if (w.length > 3) return null;
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
}

export function parseDays(input) {
  const s = String(input ?? '').trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  return Number(s);
}

export function ltvHundredths(debtCents, valueAmount) {
  if (valueAmount <= 0) return null;
  return Math.round((debtCents * 10000) / valueAmount);
}
