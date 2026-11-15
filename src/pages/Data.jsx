import { Link } from 'react-router-dom';
import { Page, Rows } from '../components/ui.jsx';
import { formatApr, formatUsd, formatWhen } from '../lib/format.js';
import { bookStats } from '../lib/health.js';
import { CLOCK } from '../lib/data.js';
import { useStore } from '../store.jsx';

export function Data() {
  const { state } = useStore();
  const stats = bookStats(state.loans);
  return (
    <Page
      kicker="Book"
      title="The book, counted."
      lede="These figures are the loans on this page, not balances on Base. Bad debt here is zero. The target is under 0.05% of originated principal a year."
    >
      <Rows items={[
        { label: 'Outstanding principal', value: formatUsd(stats.outstanding) },
        { label: 'Originated in this book', value: formatUsd(stats.originated) },
        { label: 'Live loans', value: String(stats.live) },
        { label: 'In margin call', value: String(stats.margin) },
        { label: 'In grace', value: String(stats.grace) },
        { label: 'In auction', value: String(stats.auction) },
        { label: 'Weighted average APR', value: formatApr(stats.averageBps) },
        { label: 'Bad debt', value: '$0.00' },
        { label: 'Yield on locked stock', value: 'Off unless both sides turn it on' },
        { label: 'Pooled vault', value: 'Not deployed' },
        { label: 'Preview clock', value: formatWhen(CLOCK) },
      ]} />
      <p className="block hint">
        The safety reserve is a share of fees set aside for shortfalls after governance approval. It is not insurance. Parameters live on the <Link to="/risk">risk page</Link>.
      </p>
    </Page>
  );
}
