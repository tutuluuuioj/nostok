import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getAddress, isAddress, zeroAddress } from 'viem';
import { Choice, Field, Page, Rows, Sheet, TextInput } from '../components/ui.jsx';
import { getFrontendConfig } from '../lib/contracts.js';
import { formatBpsPercent } from '../lib/marketsApi.js';
import {
  executeLoanClaim,
  fetchWalletPositionsAndClaimable,
  formatWeb3Error,
  getInjectedProvider,
  shortAddress,
} from '../lib/web3.js';
import { useStore } from '../store.jsx';

function formatMaturityIso(secStr) {
  if (!secStr || secStr === '0') return '—';
  const ms = Number(secStr) * 1000;
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : secStr;
}

export function Positions() {
  const { web3 } = useStore();
  const navigate = useNavigate();
  const reqSeqRef = useRef(0);

  const [includeBurned, setIncludeBurned] = useState(false);
  const [recipientInput, setRecipientInput] = useState('');
  const [confirmAlternateRecipient, setConfirmAlternateRecipient] = useState(false);
  const [lookupId, setLookupId] = useState('');
  const [lookupErr, setLookupErr] = useState('');

  const [posState, setPosState] = useState({
    loading: false,
    data: null,
    error: '',
  });
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState('');
  const [claimResult, setClaimResult] = useState(null);

  const walletOnBase = Boolean(web3?.connected && web3?.address && !web3?.wrongNetwork);
  const connectedAddr = web3?.address && isAddress(web3.address) ? getAddress(web3.address) : null;
  const trimmedRecipient = recipientInput.trim();
  const recipientValid =
    trimmedRecipient === '' || (isAddress(trimmedRecipient) && getAddress(trimmedRecipient) !== zeroAddress);
  const resolvedRecipient =
    trimmedRecipient === ''
      ? connectedAddr
      : recipientValid
        ? getAddress(trimmedRecipient)
        : null;
  const isAlternateRecipient = Boolean(
    connectedAddr && resolvedRecipient && resolvedRecipient.toLowerCase() !== connectedAddr.toLowerCase()
  );

  useEffect(() => {
    setRecipientInput(web3?.address || '');
    setConfirmAlternateRecipient(false);
    setClaimError('');
    setClaimResult(null);
  }, [web3?.address]);

  const loadPositions = useCallback(async () => {
    if (!web3?.address) {
      setPosState({ loading: false, data: null, error: '' });
      return;
    }
    const seq = ++reqSeqRef.current;
    setPosState((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const data = await fetchWalletPositionsAndClaimable({
        address: web3.address,
        includeBurned,
        cfg: web3?.config ?? getFrontendConfig(),
      });
      if (seq !== reqSeqRef.current) return;
      setPosState({ loading: false, data, error: '' });
    } catch (err) {
      if (seq !== reqSeqRef.current) return;
      setPosState({ loading: false, data: null, error: formatWeb3Error(err) });
    }
  }, [includeBurned, web3?.address, web3?.config]);

  useEffect(() => {
    void loadPositions();
  }, [loadPositions]);

  async function handleClaim(event) {
    event.preventDefault();
    if (!walletOnBase) return;
    if (!recipientValid) {
      setClaimError('Enter a valid non-zero payout address.');
      return;
    }
    if (isAlternateRecipient && !confirmAlternateRecipient) {
      setClaimError('Confirm the alternate payout recipient address before claiming.');
      return;
    }
    setClaimError('');
    setClaimResult(null);
    setClaimBusy(true);
    try {
      const res = await executeLoanClaim({
        address: web3.address,
        recipient: trimmedRecipient || web3.address,
        allowAlternateRecipient: !isAlternateRecipient || confirmAlternateRecipient,
        provider: getInjectedProvider(),
        cfg: web3?.config ?? getFrontendConfig(),
      });
      setClaimResult(res);
      await Promise.all([loadPositions(), web3?.refresh?.()]);
    } catch (err) {
      setClaimError(formatWeb3Error(err));
    } finally {
      setClaimBusy(false);
    }
  }

  function handleInspectSubmit(event) {
    event.preventDefault();
    const clean = lookupId.trim();
    if (!/^\d+$/.test(clean) || BigInt(clean) <= 0n) {
      setLookupErr('Enter a positive integer PositionNFT / Loan ID (e.g. 1).');
      return;
    }
    setLookupErr('');
    navigate(`/loans/${clean}`);
  }

  const data = posState.data;
  const positions = data?.positions ?? [];
  const activePositions = positions.filter((p) => !p.isBurned);
  const burnedPositions = positions.filter((p) => p.isBurned);
  const hasClaimable = Boolean(data?.claimableRaw && BigInt(data.claimableRaw) > 0n);

  return (
    <Page
      kicker="Positions · Claims"
      title="Position NFTs & LoanCore claims."
      lede="Each PositionNFT (ERC-721 tokenId = loanId) represents a lender claim on Base. Pull-based USDC repayments and auction proceeds accrue to LoanCore.getClaimable() and can always be claimed."
    >
      <div className="actions">
        {!web3?.connected ? (
          <button
            className="btn"
            type="button"
            onClick={() => void web3?.connect?.()}
            disabled={web3?.connecting}
          >
            {web3?.connecting ? 'Connecting…' : 'Connect wallet'}
          </button>
        ) : (
          <>
            {web3?.wrongNetwork ? (
              <button className="btn" type="button" onClick={() => void web3?.switchNetwork?.()}>
                Switch to Base ({web3?.config?.chainId ?? 8453})
              </button>
            ) : null}
            <button
              className="btn secondary"
              type="button"
              onClick={() => void loadPositions()}
              disabled={posState.loading}
            >
              {posState.loading ? 'Refreshing positions…' : 'Refresh positions & claimable'}
            </button>
          </>
        )}
        <Link className="btn secondary" to="/loans">Active loans</Link>
        <Link className="btn secondary" to="/lend">Open LendOffers</Link>
      </div>

      {data?.rpcError ? (
        <p className="err block" role="alert">
          Base RPC position read failed — {data.rpcError}
        </p>
      ) : null}

      {data?.apiError ? (
        <p className="hint block" role="status">
          api/ /positions unavailable ({data.apiError}) — showing direct Base RPC LoanCore &amp; PositionNFT reads.
        </p>
      ) : null}

      {data &&
      !data.rpcError &&
      (data.scanTruncated ||
        data.positionsIncomplete ||
        (data.nftBalanceCount !== null &&
          (data.verifiedOwnedCount ?? activePositions.length) < data.nftBalanceCount)) ? (
        <p className="hint block" role="status">
          Showing {data.verifiedOwnedCount ?? activePositions.length} of {data.nftBalanceCount ?? '—'} held
          PositionNFTs on-chain
          {data.scanTruncated
            ? ' (direct fallback scanned the recent 50 loan IDs only; use Inspect PositionNFT / Loan by ID for older positions).'
            : ' (some positions could not be verified on-chain; use Inspect PositionNFT / Loan by ID or refresh).'}
        </p>
      ) : null}

      {posState.error ? (
        <p className="err block" role="alert">
          {posState.error}
        </p>
      ) : null}

      <div className="block split">
        <Sheet
          title="LoanCore pull-payment USDC claims (claim)"
          note="Repaid principal, net lender interest, and auction settlements credit LoanCore.claimable[account]. Claiming requires zero Regulation S declaration and stays open regardless of pause or API downtime."
        >
          <Rows
            items={[
              { label: 'Connected wallet', value: web3?.address ?? 'Not connected' },
              {
                label: 'Claimable USDC (6 dec)',
                value: data
                  ? data.claimableFormatted !== null
                    ? `$${data.claimableFormatted} USDC (${data.claimableRaw} raw)`
                    : 'unavailable'
                  : web3?.address
                    ? 'Loading…'
                    : '—',
              },
              {
                label: 'Wallet USDC balance',
                value: data
                  ? data.usdcBalanceFormatted !== null
                    ? `$${data.usdcBalanceFormatted} USDC`
                    : 'unavailable'
                  : web3?.address
                    ? 'Loading…'
                    : '—',
              },
              {
                label: 'PositionNFT balance (ERC-721)',
                value: data
                  ? data.nftBalanceCount !== null
                    ? String(data.nftBalanceCount)
                    : 'unavailable'
                  : web3?.address
                    ? 'Loading…'
                    : '—',
              },
            ]}
          />

          <form onSubmit={handleClaim} style={{ marginTop: 14 }}>
            <Field
              id="claim-recipient"
              label="Claim recipient address"
              hint="Defaults to your connected wallet; USDC transfers directly from LoanCore to this non-zero address."
            >
              {(props) => (
                <TextInput
                  id="claim-recipient"
                  value={recipientInput}
                  onChange={(val) => {
                    setRecipientInput(val);
                    setConfirmAlternateRecipient(false);
                  }}
                  invalid={!recipientValid}
                  placeholder="0x…"
                  {...props}
                />
              )}
            </Field>

            {!recipientValid ? (
              <p className="err" role="alert">
                Enter a valid non-zero payout address.
              </p>
            ) : null}

            {isAlternateRecipient ? (
              <div style={{ marginTop: 10 }}>
                <p className="hint" role="alert">
                  Payout address ({resolvedRecipient}) differs from your connected wallet ({connectedAddr}). Claimed USDC will be sent permanently to that address.
                </p>
                <Choice
                  id="confirm-alternate-claim-recipient"
                  checked={confirmAlternateRecipient}
                  onChange={setConfirmAlternateRecipient}
                >
                  Confirm sending claimed USDC to alternate payout address {resolvedRecipient}
                </Choice>
              </div>
            ) : null}

            {claimError ? (
              <p className="err" role="alert">
                {claimError}
              </p>
            ) : null}
            {claimResult ? (
              <p className="note" role="status">
                Claimed ${claimResult.claimedAmountFormatted} USDC ({claimResult.claimedAmountRaw} raw) for claimant{' '}
                {claimResult.claimant} to payout address {claimResult.recipient} (tx {claimResult.txHash}). Remaining claimable:{' '}
                {claimResult.remainingClaimableRaw} raw.
              </p>
            ) : null}

            <div className="actions">
              <button
                className="btn"
                type="submit"
                disabled={
                  !walletOnBase ||
                  !hasClaimable ||
                  claimBusy ||
                  !recipientValid ||
                  (isAlternateRecipient && !confirmAlternateRecipient)
                }
              >
                {claimBusy ? 'Claiming USDC…' : 'Claim USDC from LoanCore'}
              </button>
            </div>
          </form>
        </Sheet>

        <Sheet
          title="Inspect PositionNFT / Loan by ID"
          note="Every PositionNFT tokenId matches its Base LoanCore loanId. Jump directly to manage extensions or view repayment/auction status."
        >
          <form onSubmit={handleInspectSubmit}>
            <Field id="inspect-position-id" label="PositionNFT / Loan ID">
              {(props) => (
                <TextInput
                  id="inspect-position-id"
                  inputMode="numeric"
                  value={lookupId}
                  onChange={setLookupId}
                  placeholder="e.g. 1"
                  {...props}
                />
              )}
            </Field>
            {lookupErr ? (
              <p className="err" role="alert">
                {lookupErr}
              </p>
            ) : null}
            <div className="actions">
              <button className="btn secondary" type="submit">
                Open /loans/:id
              </button>
            </div>
          </form>

          <div style={{ marginTop: 16 }}>
            <Choice
              id="include-burned-positions"
              checked={includeBurned}
              onChange={setIncludeBurned}
            >
              Include settled &amp; burned historical PositionNFTs (requires api/)
            </Choice>
          </div>
        </Sheet>
      </div>

      <section className="block">
        <h2>Held PositionNFTs ({activePositions.length})</h2>
        {!web3?.address ? (
          <p className="lede">Connect your wallet to enumerate live PositionNFTs on Base.</p>
        ) : posState.loading && !data ? (
          <p className="hint">Reading live PositionNFT &amp; LoanCore state…</p>
        ) : activePositions.length === 0 ? (
          <p className="lede">
            No held PositionNFTs found for {shortAddress(web3.address)}. Open or fill a loan on{' '}
            <Link to="/lend">Lend</Link>.
          </p>
        ) : (
          activePositions.map((pos) => (
            <article className="order-row" key={pos.loanId}>
              <div>
                <strong>
                  PositionNFT #{pos.loanId} · {pos.collateralSymbol || (pos.collateralToken ? shortAddress(pos.collateralToken) : 'Unknown')} · {pos.statusName}
                </strong>
                <span className="quiet">
                  {pos.ownerUnknown
                    ? 'Owner unknown (PositionNFT.ownerOf read failed)'
                    : pos.onchainVerified
                      ? `Borrower ${pos.borrower ? shortAddress(pos.borrower) : '—'} · APR ${pos.rateBps !== null ? formatBpsPercent(pos.rateBps) : '—'} · Maturity ${formatMaturityIso(pos.maturity)}`
                      : 'Not verified on-chain (Base RPC unavailable)'}
                  {pos.auctionLocked === true
                    ? ' · Transfer locked (active LiquidationAuction)'
                    : pos.auctionLocked === null
                      ? ' · Transfer lock unknown'
                      : ''}
                </span>
                {pos.collateralFormatted !== null ? (
                  <span className="quiet">
                    Escrowed collateral: {pos.collateralFormatted} {pos.collateralSymbol || 'TOKEN'} · Due interest:{' '}
                    {pos.dueInterestFormatted !== null ? `$${pos.dueInterestFormatted} USDC` : 'unavailable'}
                  </span>
                ) : null}
                <div className="actions" style={{ marginTop: 8 }}>
                  <Link className="btn secondary" to={`/loans/${pos.loanId}`}>
                    Inspect / Extend Loan #{pos.loanId}
                  </Link>
                </div>
              </div>
              <span className="numline">
                {pos.principalRemainingFormatted !== null ? `$${pos.principalRemainingFormatted} USDC` : 'unavailable'}
              </span>
            </article>
          ))
        )}
      </section>

      {includeBurned && burnedPositions.length > 0 ? (
        <section className="block">
          <h2>Settled / burned historical PositionNFTs ({burnedPositions.length})</h2>
          {burnedPositions.map((pos) => (
            <article className="order-row" key={`burned-${pos.loanId}`}>
              <div>
                <strong>
                  PositionNFT #{pos.loanId} (Burned) · {pos.collateralSymbol || (pos.collateralToken ? shortAddress(pos.collateralToken) : 'Asset')} · {pos.statusName}
                </strong>
                <span className="quiet">
                  Original principal: {pos.principalRaw ? `${pos.principalRaw} raw` : '—'} ·{' '}
                  <Link to={`/loans/${pos.loanId}`}>Inspect Loan #{pos.loanId}</Link>
                </span>
              </div>
              <span className="quiet">Settled</span>
            </article>
          ))}
        </section>
      ) : null}

      <section className="block">
        <h2>Secondary Position Market status</h2>
        <p className="hint">
          On-chain secondary ERC-721 PositionNFT orderbook listings and asks are scheduled for Phase 6 (M6.2). Direct PositionNFT transfers via <code>transferWithAttestation</code> remain subject to <code>PositionNFT.isAuctionLocked</code> and <code>EligibilityGate</code> recipient checks.
        </p>
      </section>
    </Page>
  );
}
