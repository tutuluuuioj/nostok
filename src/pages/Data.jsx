import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Page, Rows } from '../components/ui.jsx';
import {
  buildDataMetricRows,
  fetchMarketsAndLiveContracts,
} from '../lib/marketsApi.js';
import { useStore } from '../store.jsx';

export function Data() {
  const { web3 } = useStore();
  const [snapshot, setSnapshot] = useState({ loading: true, data: null, onChain: null, discrepancies: [] });
  const reqSeqRef = useRef(0);

  const loadBook = useCallback(async () => {
    const reqId = ++reqSeqRef.current;
    setSnapshot((prev) => ({
      loading: true,
      data: prev.data,
      onChain: prev.onChain,
      discrepancies: prev.discrepancies,
    }));
    const next = await fetchMarketsAndLiveContracts({
      cfg: web3?.config,
      requestId: reqId,
      includeLoans: true,
      includeAuctions: true,
    });
    if (reqId !== reqSeqRef.current) return;
    setSnapshot({
      loading: false,
      data: next.market,
      onChain: next.onChain,
      discrepancies: next.discrepancies,
    });
  }, [web3?.config]);

  useEffect(() => {
    void loadBook();
  }, [loadBook]);

  const data = snapshot.data;
  const onChain = snapshot.onChain;
  const discrepancies = snapshot.discrepancies ?? [];
  const summary = data?.bookSummary;
  const health = data?.health;

  return (
    <Page
      kicker="Book"
      title="Live protocol book metrics."
      lede="Figures below combine direct Base contract readings (LoanCore, CollateralEscrow, AssetRegistry, OracleRouter) with indexed loan, order, and auction breakdowns from api/ using exact USDC 6-decimal accounting."
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

      {snapshot.loading && !data && !onChain ? (
        <p className="hint block">Loading live protocol book metrics from Base contracts &amp; api/…</p>
      ) : null}

      {onChain && !onChain.ok ? (
        <p className="err block" role="alert">
          Direct Base RPC contract read unavailable — {onChain.error}
        </p>
      ) : null}

      {onChain?.discoveryWarning ? (
        <p className="hint block" role="status">
          Asset discovery notice: {onChain.discoveryWarning}
        </p>
      ) : null}

      {data && (data.stale || data.degraded || data.error) ? (
        <p className={onChain?.ok ? 'hint block' : 'err block'} role="alert">
          {onChain?.ok
            ? `Indexer api/ degraded or unavailable (${data.error || 'Indexer health degraded.'}) — live LoanCore caps, principal, loan counter, and CollateralEscrow totals are read directly from Base RPC.`
            : `Live book telemetry degraded or unavailable — ${data.error || 'Indexer health degraded.'}`}
        </p>
      ) : null}

      {discrepancies.length > 0 ? (
        <p className="err block" role="alert">
          Contract vs api/ mismatch detected (Base RPC values shown): {discrepancies.join(' · ')}
        </p>
      ) : null}

      <Rows items={buildDataMetricRows(summary, data, health, onChain)} />
      <p className="block hint">
        Collateral remains isolated per loan in CollateralEscrow. Live asset configurations and oracle states are published on <Link to="/risk">risk parameters</Link> and <Link to="/markets">live markets</Link>.
      </p>
    </Page>
  );
}
