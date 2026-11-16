import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Page, Rows } from '../components/ui.jsx';
import {
  fetchMarketSnapshot,
  formatApiAmount,
  formatBpsPercent,
} from '../lib/marketsApi.js';
import { useStore } from '../store.jsx';

export function Data() {
  const { web3 } = useStore();
  const [snapshot, setSnapshot] = useState({ loading: true, data: null });
  const reqSeqRef = useRef(0);

  const loadBook = useCallback(async () => {
    const reqId = ++reqSeqRef.current;
    setSnapshot((prev) => ({ loading: true, data: prev.data }));
    const next = await fetchMarketSnapshot({
      cfg: web3?.config,
      requestId: reqId,
      includeLoans: true,
      includeAuctions: true,
    });
    if (reqId !== reqSeqRef.current) return;
    setSnapshot({ loading: false, data: next });
  }, [web3?.config]);

  useEffect(() => {
    void loadBook();
  }, [loadBook]);

  const data = snapshot.data;
  const summary = data?.bookSummary;
  const health = data?.health;
  const unavailable = !summary || Boolean(data?.error && !health);

  return (
    <Page
      kicker="Book"
      title="Live protocol book metrics."
      lede="Figures below come strictly from the Base indexer API (/health, /assets, /orders, /loans, /auctions) using exact USDC 6-decimal accounting."
    >
      <div className="actions">
        <button
          className="btn secondary"
          type="button"
          onClick={() => void loadBook()}
          disabled={snapshot.loading}
        >
          {snapshot.loading ? 'Refreshing book…' : 'Refresh book metrics'}
        </button>
      </div>

      {snapshot.loading && !data ? (
        <p className="hint block">Loading live protocol book metrics from api/…</p>
      ) : null}

      {data && (data.stale || data.degraded || data.error) ? (
        <p className="err block" role="alert">
          Live book telemetry degraded or unavailable — {data.error || 'Indexer health degraded.'}
        </p>
      ) : null}

      <Rows
        items={[
          {
            label: 'Outstanding principal',
            value: unavailable
              ? 'Unavailable'
              : formatApiAmount(summary.totalOutstandingUsdc, { prefixUsd: true, showSymbol: true }),
          },
          {
            label: 'Global USDC cap / remaining',
            value: unavailable || !summary.globalCapUsdc
              ? 'Unavailable'
              : `${formatApiAmount(summary.globalCapUsdc, { prefixUsd: true })} / ${formatApiAmount(summary.globalRemainingUsdc, { prefixUsd: true })}`,
          },
          {
            label: 'Total originated (indexed)',
            value: unavailable
              ? 'Unavailable'
              : `${formatApiAmount(summary.totalOriginatedUsdc, { prefixUsd: true, showSymbol: true })}${summary.loansTruncated ? '+' : ''}`,
          },
          {
            label: 'Active loans (status 0)',
            value: unavailable ? 'Unavailable' : String(summary.activeLoansCount),
          },
          {
            label: 'Loans in grace (status 1)',
            value: unavailable ? 'Unavailable' : String(summary.graceLoansCount),
          },
          {
            label: 'Loans in auction (status 2)',
            value: unavailable ? 'Unavailable' : String(summary.auctionLoansCount),
          },
          {
            label: 'Repaid / defaulted / liquidated',
            value: unavailable
              ? 'Unavailable'
              : `${summary.repaidLoansCount} / ${summary.settledDefaultCount} / ${summary.settledLiquidatedCount}`,
          },
          {
            label: 'Active liquidation auctions',
            value: unavailable ? 'Unavailable' : String(summary.activeAuctionsCount),
          },
          {
            label: 'Indexed orders (active / total)',
            value: unavailable
              ? 'Unavailable'
              : `${summary.activeOrdersCount} / ${data.orders.length}`,
          },
          {
            label: 'Weighted average APR (open book)',
            value: unavailable ? 'Unavailable' : formatBpsPercent(summary.weightedAverageAprBps),
          },
          {
            label: 'Realized bad debt shortfall',
            value: unavailable
              ? 'Unavailable'
              : formatApiAmount(summary.badDebtUsdc, { prefixUsd: true, showSymbol: true }),
          },
          {
            label: 'Indexed block / chain head',
            value: health
              ? `#${health.last_indexed_block ?? '—'} / #${health.chain_head_block ?? '—'} (lag ${health.lag_blocks ?? '—'})`
              : 'Unavailable',
          },
          {
            label: 'Snapshot timestamp',
            value: health?.freshness_timestamp ?? data?.fetchedAt ?? 'Unavailable',
          },
        ]}
      />
      <p className="block hint">
        Collateral remains isolated per loan in CollateralEscrow. Live asset configurations and oracle states are published on <Link to="/risk">risk parameters</Link> and <Link to="/markets">live markets</Link>.
      </p>
    </Page>
  );
}
