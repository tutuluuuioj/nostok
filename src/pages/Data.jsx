import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Page, Rows } from '../components/ui.jsx';
import {
  buildDataMetricRows,
  fetchMarketSnapshot,
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

      <Rows items={buildDataMetricRows(summary, data, health)} />
      <p className="block hint">
        Collateral remains isolated per loan in CollateralEscrow. Live asset configurations and oracle states are published on <Link to="/risk">risk parameters</Link> and <Link to="/markets">live markets</Link>.
      </p>
    </Page>
  );
}
