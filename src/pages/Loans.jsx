import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getAddress } from 'viem';
import { Choice, Field, Page, TextInput } from '../components/ui.jsx';
import { USDC_DECIMALS, getFrontendConfig } from '../lib/contracts.js';
import { formatBpsPercent, formatRawUsdc } from '../lib/marketsApi.js';
import {
  LOAN_CORE_GRACE_PERIOD_SECS,
  fetchPaginatedApiRows,
  formatWeb3Error,
  shortAddress,
} from '../lib/web3.js';
import { useStore } from '../store.jsx';

function computeRemainingPrincipalRaw(loan) {
  try {
    const p = BigInt(loan?.principal?.raw ?? 0n);
    const r = BigInt(loan?.principal_repaid?.raw ?? 0n);
    return p > r ? (p - r).toString() : '0';
  } catch {
    return '0';
  }
}

function getEffectiveIndexedStatusLabel(loan, nowSec) {
  const st = Number(loan?.status ?? 0);
  const maturitySec = Number(loan?.maturity ?? 0);
  if (st <= 1 && Number.isFinite(maturitySec) && maturitySec > 0 && nowSec > maturitySec) {
    if (nowSec > maturitySec + Number(LOAN_CORE_GRACE_PERIOD_SECS)) {
      return 'Overdue - default pending';
    }
    return 'Grace';
  }
  return loan?.status_name ?? `Status_${st}`;
}

function LoanSummaryRow({ loan, nowSec, roleBadge = null, auctionLocked = false }) {
  const remainingRaw = computeRemainingPrincipalRaw(loan);
  const statusLabel = getEffectiveIndexedStatusLabel(loan, nowSec);
  return (
    <Link className="loan-row" to={`/loans/${loan.loan_id}`}>
      <span className="numline">#{loan.loan_id}</span>
      <span>
        <strong>
          {loan.collateral_amount?.symbol || shortAddress(loan.collateral_token)} · {statusLabel}
          {roleBadge ? ` (${roleBadge})` : ''}
        </strong>
        <span className="quiet">
          APR {formatBpsPercent(loan.rate_bps)} · Borrower {shortAddress(loan.borrower)}
          {loan.lender ? ` · Holder ${shortAddress(loan.lender)}` : ''}
          {auctionLocked ? ' · NFT auction locked' : ''}
        </span>
      </span>
      <span className="numline">{formatRawUsdc(remainingRaw)}</span>
      <span className="quiet">Manage</span>
    </Link>
  );
}

export function Loans() {
  const { web3 } = useStore();
  const navigate = useNavigate();
  const reqSeqRef = useRef(0);

  const [lookupId, setLookupId] = useState('');
  const [lookupErr, setLookupErr] = useState('');
  const [includeSettled, setIncludeSettled] = useState(false);
  const [deskState, setDeskState] = useState({
    loading: true,
    error: '',
    loans: [],
    myBorrowLoans: [],
    myPositions: [],
    loansTruncated: false,
    fetchedAt: null,
  });

  const walletChecksum = useMemo(() => {
    try {
      return web3?.address ? getAddress(web3.address) : null;
    } catch {
      return null;
    }
  }, [web3?.address]);

  const loadLoans = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    const cfg = getFrontendConfig();
    if (!cfg?.apiUrl) {
      if (seq === reqSeqRef.current) {
        setDeskState({
          loading: false,
          error: 'VITE_API_URL is not configured.',
          loans: [],
          myBorrowLoans: [],
          myPositions: [],
          loansTruncated: false,
          fetchedAt: null,
        });
      }
      return;
    }

    setDeskState((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const [allLoansRes, myBorrowRes, myPosRes] = await Promise.all([
        fetchPaginatedApiRows(`${cfg.apiUrl}/loans`, { limit: 100, maxPages: 10, cfg }),
        walletChecksum
          ? fetchPaginatedApiRows(`${cfg.apiUrl}/loans?borrower=${walletChecksum}`, {
              limit: 100,
              maxPages: 10,
              cfg,
            })
          : Promise.resolve({ rows: [], truncated: false }),
        walletChecksum
          ? fetchPaginatedApiRows(`${cfg.apiUrl}/positions?owner=${walletChecksum}&burned=false`, {
              limit: 100,
              maxPages: 10,
              cfg,
            })
          : Promise.resolve({ rows: [], truncated: false }),
      ]);
      if (seq !== reqSeqRef.current) return;
      setDeskState({
        loading: false,
        error: '',
        loans: allLoansRes.rows ?? [],
        myBorrowLoans: myBorrowRes.rows ?? [],
        myPositions: myPosRes.rows ?? [],
        loansTruncated: Boolean(allLoansRes.truncated || myBorrowRes.truncated || myPosRes.truncated),
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (seq !== reqSeqRef.current) return;
      setDeskState((prev) => ({
        ...prev,
        loading: false,
        error: formatWeb3Error(err),
      }));
    }
  }, [walletChecksum]);

  useEffect(() => {
    void loadLoans();
  }, [loadLoans]);

  function handleInspectLoan(event) {
    event.preventDefault();
    const clean = lookupId.trim().replace(/^#/, '');
    if (!/^[1-9]\d*$/.test(clean)) {
      setLookupErr('Enter a positive integer on-chain Loan ID (e.g. 1).');
      return;
    }
    setLookupErr('');
    navigate(`/loans/${clean}`);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const loanById = useMemo(() => {
    const map = new Map();
    for (const loan of deskState.loans) {
      map.set(String(loan.loan_id), loan);
    }
    return map;
  }, [deskState.loans]);

  const myLenderRows = useMemo(() => {
    if (!walletChecksum) return [];
    const seen = new Set();
    const out = [];
    for (const pos of deskState.myPositions) {
      const idStr = String(pos.loan_id);
      seen.add(idStr);
      const indexed = loanById.get(idStr);
      if (indexed) {
        out.push({ loan: indexed, auctionLocked: Boolean(pos.auction_locked) });
      } else {
        out.push({
          loan: {
            loan_id: idStr,
            borrower: '0x0000000000000000000000000000000000000000',
            lender: walletChecksum,
            collateral_token: pos.collateral_token,
            collateral_amount: {
              raw: '0',
              decimals: 18,
              symbol: pos.collateral_symbol ?? 'B20',
            },
            principal: pos.principal ?? { raw: '0', decimals: USDC_DECIMALS, symbol: 'USDC' },
            principal_repaid: { raw: '0', decimals: USDC_DECIMALS, symbol: 'USDC' },
            maturity: '0',
            rate_bps: 0,
            status: pos.loan_status ?? 0,
            status_name: pos.loan_status_name ?? 'Active',
          },
          auctionLocked: Boolean(pos.auction_locked),
        });
      }
    }
    for (const loan of deskState.loans) {
      if (seen.has(String(loan.loan_id))) continue;
      if (loan.lender && loan.lender.toLowerCase() === walletChecksum.toLowerCase() && Number(loan.status) < 3) {
        out.push({ loan, auctionLocked: false });
      }
    }
    return out;
  }, [deskState.loans, deskState.myPositions, loanById, walletChecksum]);

  const filterVisible = useCallback(
    (loan) => includeSettled || Number(loan.status) < 3,
    [includeSettled]
  );

  const visibleBorrow = deskState.myBorrowLoans.filter(filterVisible);
  const visibleLend = myLenderRows.filter((item) => filterVisible(item.loan));
  const visibleAll = deskState.loans.filter(filterVisible);

  return (
    <Page
      kicker="Loans · Live Desk"
      title="Active loans & obligations."
      lede="Live loans from api/ indexed from LoanCore and PositionNFT on Base. Open any loan to repay, partial-repay, top up collateral, or co-sign an extension."
    >
      <div className="block">
        <form className="actions" onSubmit={handleInspectLoan} style={{ alignItems: 'flex-end' }}>
          <div style={{ minWidth: 240, flex: '0 1 280px' }}>
            <Field
              id="lookup-loan-id"
              label="Inspect any on-chain Loan ID directly"
              error={lookupErr}
            >
              {({ describedBy, invalid }) => (
                <TextInput
                  id="lookup-loan-id"
                  inputMode="numeric"
                  value={lookupId}
                  onChange={(v) => {
                    setLookupId(v);
                    setLookupErr('');
                  }}
                  describedBy={describedBy}
                  invalid={invalid}
                />
              )}
            </Field>
          </div>
          <button className="btn" type="submit">
            Inspect Loan
          </button>
          <button
            className="btn secondary"
            type="button"
            onClick={() => void loadLoans()}
            disabled={deskState.loading}
          >
            {deskState.loading ? 'Refreshing…' : 'Refresh loans'}
          </button>
        </form>

        <div style={{ marginTop: 12 }}>
          <Choice
            id="include-settled-loans"
            checked={includeSettled}
            onChange={setIncludeSettled}
          >
            Include repaid &amp; settled historical loans
          </Choice>
        </div>

        {deskState.error ? (
          <p className="err" role="alert" style={{ marginTop: 12 }}>
            Failed to load indexed loans from api/: {deskState.error}. You can still open any Loan ID directly above via RPC.
          </p>
        ) : null}
        {deskState.loansTruncated ? (
          <p className="err" role="note" style={{ marginTop: 12 }}>
            Warning: Indexed loans list hit pagination limit (&gt; 1,000 rows); older entries may be omitted. Use direct Loan ID inspection above if needed.
          </p>
        ) : null}
      </div>

      {walletChecksum ? (
        <>
          <section className="block">
            <h2>Your borrower loans ({visibleBorrow.length})</h2>
            {visibleBorrow.length === 0 ? (
              <p className="lede">
                No {includeSettled ? '' : 'open '}borrower loans found for {shortAddress(walletChecksum)}. Visit{' '}
                <Link to="/borrow">Borrow</Link> to open a loan.
              </p>
            ) : (
              visibleBorrow.map((loan) => (
                <LoanSummaryRow key={loan.loan_id} loan={loan} nowSec={nowSec} roleBadge="Borrower" />
              ))
            )}
          </section>

          <section className="block">
            <h2>Your lender claims / PositionNFTs ({visibleLend.length})</h2>
            {visibleLend.length === 0 ? (
              <p className="lede">
                No {includeSettled ? '' : 'active '}PositionNFT claims held by {shortAddress(walletChecksum)}. Visit{' '}
                <Link to="/lend">Lend</Link> to fund a loan.
              </p>
            ) : (
              visibleLend.map(({ loan, auctionLocked }) => (
                <LoanSummaryRow
                  key={loan.loan_id}
                  loan={loan}
                  nowSec={nowSec}
                  roleBadge="NFT Holder"
                  auctionLocked={auctionLocked}
                />
              ))
            )}
          </section>
        </>
      ) : (
        <div className="block">
          <p className="lede">
            <Link to="/wallet">Connect your wallet</Link> to filter loans where you are the borrower or PositionNFT lender holder.
          </p>
        </div>
      )}

      <section className="block">
        <h2>Indexed protocol loans ({visibleAll.length})</h2>
        {deskState.loading && visibleAll.length === 0 ? (
          <p className="lede">Loading live loans from api/…</p>
        ) : visibleAll.length === 0 ? (
          <p className="lede">No matching loans indexed yet.</p>
        ) : (
          visibleAll.map((loan) => (
            <LoanSummaryRow key={loan.loan_id} loan={loan} nowSec={nowSec} />
          ))
        )}
        {deskState.fetchedAt ? (
          <p className="hint" style={{ marginTop: 10 }}>
            Snapshot fetched at {deskState.fetchedAt}. Clicking any row queries live LoanCore &amp; PositionNFT state on-chain.
          </p>
        ) : null}
      </section>
    </Page>
  );
}
