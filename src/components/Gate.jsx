import { useState } from 'react';
import {
  ELIGIBILITY_DECLARATION_STATEMENT,
} from '../lib/contracts.js';
import { formatWeb3Error, shortAddress } from '../lib/web3.js';
import { useStore } from '../store.jsx';
import { resolveJurisdictionSelection } from './DeclarationPanel.jsx';
import { Choice, Field } from './ui.jsx';

const CHECKS = [
  ['person', 'I am an eligible non-US person, and I am not in a sanctioned or restricted jurisdiction.'],
  ['escrow', 'I understand the stock sits in escrow, and the lender receives a Position NFT, not the stock.'],
  ['surplus', 'I understand a default sells only enough collateral, and any surplus comes back to the borrower.'],
  ['oracle', 'I understand liquidation does not run when the market is closed, the oracle is stale, or the asset is frozen.'],
  ['onchain', 'I understand orders and settlements interact with real NOSTOK smart contracts on Base.'],
];

function formatGeoStatus(geo, screening) {
  if (screening?.loading && !screening?.data) {
    return 'Checking edge IP geolocation via api/ GET /eligibility…';
  }
  if (screening?.error) {
    return `Unavailable (${screening.error})`;
  }
  if (!geo) {
    return 'Awaiting api/ GET /eligibility check';
  }
  if (geo.verified) {
    return geo.allowed
      ? `Verified ${geo.country_code} (Allowed)`
      : `Blocked (${geo.country_code ?? 'Unknown'} · ${geo.reason ?? 'GEO_RESTRICTED'})`;
  }
  if (geo.status === 'disabled') {
    return 'Edge geoblock disabled via server override';
  }
  if (geo.status === 'local_unverified') {
    return 'Local fork mode (unverified edge geo — non-US declaration required)';
  }
  return geo.allowed ? `Allowed (${geo.status})` : `Blocked (${geo.reason ?? geo.status})`;
}

export function GateChecking() {
  return (
    <main className="wrap gate" id="main">
      <p className="mark">NOSTOK</p>
      <p className="kicker">Compliance</p>
      <h1>Verifying eligibility.</h1>
      <p className="lede">
        Checking edge IP jurisdiction, sanctions screening, and on-chain EligibilityGate before opening the desk.
      </p>
    </main>
  );
}

export function Gate() {
  const { act, web3 } = useStore();
  const [checks, setChecks] = useState({});
  const [jurisdictionInput, setJurisdictionInput] = useState('');
  const [localError, setLocalError] = useState('');

  const screening = web3?.eligibilityScreening ?? {
    loading: false,
    checkedOnce: false,
    data: null,
    error: '',
  };
  const screeningData = screening.data;
  const geo = screeningData?.geo ?? null;
  const walletEligibility =
    web3?.walletState && web3?.address && web3.walletState.address === web3.address
      ? web3.walletState.eligibility
      : null;

  if (web3?.hardRestricted) {
    return <Restricted />;
  }

  const {
    isEdgeCountryLocked,
    resolved: resolvedJurisdiction,
    error: jurisdictionError,
  } = resolveJurisdictionSelection(
    geo,
    jurisdictionInput,
    screeningData?.declaration_params?.restricted_countries
  );

  const screeningPassed = Boolean(screeningData?.allowed === true && !screening.error);
  const allChecksAccepted = CHECKS.every(([id]) => Boolean(checks[id]));
  const declStatus = web3?.eligibilityDeclarationStatus ?? { valid: false, reason: '' };
  const declValid = Boolean(declStatus.valid);
  const connected = Boolean(web3?.connected && web3?.address);
  const wrongNetwork = Boolean(connected && web3?.wrongNetwork);

  const canEnter =
    screeningPassed &&
    allChecksAccepted &&
    !wrongNetwork &&
    (!connected || !jurisdictionError);

  async function submit(event) {
    event.preventDefault();
    setLocalError('');
    if (!screeningPassed) {
      setLocalError(screening.error || 'Eligibility screening must pass before entering NOSTOK.');
      return;
    }
    if (!allChecksAccepted) {
      setLocalError('Confirm every eligibility and protocol mechanics statement before entering.');
      return;
    }
    if (!connected) {
      act({ type: 'accept' });
      return;
    }
    if (wrongNetwork) {
      await web3?.switchNetwork();
      return;
    }
    if (jurisdictionError) {
      setLocalError(jurisdictionError);
      return;
    }
    if (declValid) {
      act({ type: 'accept' });
      return;
    }
    try {
      await web3.signAndVerifyDeclaration({ jurisdiction: resolvedJurisdiction });
      act({ type: 'accept' });
    } catch (err) {
      setLocalError(formatWeb3Error(err));
    }
  }

  const activeError = localError || web3?.declarationError || screening.error || '';

  return (
    <main className="wrap gate" id="main">
      <p className="mark">NOSTOK</p>
      <p className="kicker">Eligibility</p>
      <h1>Eligible persons outside the United States.</h1>
      <p className="lede">
        Access to tokenized equity repo markets requires live IP geoblock screening, wallet sanctions screening, and a Regulation S EIP-712 non-US declaration.
      </p>

      <div className="note">
        <p className="hint">
          <strong>IP Geolocation:</strong> {formatGeoStatus(geo, screening)}
        </p>
        <p className="hint">
          <strong>Wallet screening:</strong>{' '}
          {connected
            ? screeningData?.wallet
              ? screeningData.wallet.sanctioned
                ? `BLOCKED (${shortAddress(web3.address)} failed sanctions check)`
                : `${shortAddress(web3.address)} cleared`
              : screening.loading
                ? `Screening ${shortAddress(web3.address)}…`
                : 'Awaiting wallet screening'
            : 'No wallet connected yet (read-only browsing allowed once IP passes; wallet + EIP-712 declaration required to transact)'}
        </p>
        {connected ? (
          <p className="hint">
            <strong>On-chain EligibilityGate:</strong>{' '}
            {walletEligibility
              ? walletEligibility.isRevoked
                ? 'REVOKED — address cannot enter'
                : `${walletEligibility.isEligible ? 'Eligible' : 'Allowlist or attestation required for settlement'} (${walletEligibility.eligibilityReason ?? 'checked'}, nonce ${walletEligibility.userNonce ?? '0'})`
              : 'Reading EligibilityGate…'}
          </p>
        ) : null}
        {connected && !wrongNetwork ? (
          <p className="hint">
            <strong>EIP-712 Reg S declaration:</strong>{' '}
            {web3?.verifyingDeclaration
              ? 'Verifying stored declaration via api/ POST /eligibility/verify…'
              : declValid
                ? `Verified (${declStatus.jurisdiction}, expires block ${declStatus.expiresAt})`
                : declStatus.reason || 'Not yet signed for this wallet & nonce'}
          </p>
        ) : null}
      </div>

      <form onSubmit={submit}>
        <fieldset>
          <legend>Before you continue</legend>
          {CHECKS.map(([id, label]) => (
            <Choice
              key={id}
              id={`gate-check-${id}`}
              checked={Boolean(checks[id])}
              onChange={(checked) => setChecks({ ...checks, [id]: checked })}
            >
              {label}
            </Choice>
          ))}
        </fieldset>

        {connected && !wrongNetwork ? (
          <div className="block">
            <div className="note">
              <p className="hint">
                <strong>Regulation S Statement signed via EIP-712:</strong> {ELIGIBILITY_DECLARATION_STATEMENT}
              </p>
            </div>
            <Field
              id="gate-jurisdiction"
              label={
                isEdgeCountryLocked
                  ? 'Declared jurisdiction (locked by edge IP check)'
                  : 'Declared jurisdiction (ISO-3166 alpha-2 or NON_US_SELF_DECLARED)'
              }
              hint={
                isEdgeCountryLocked
                  ? `Edge geolocation verified your IP country as ${geo.country_code}.`
                  : 'Leave blank to sign NON_US_SELF_DECLARED, or enter a 2-letter non-US ISO code (e.g. CH, SG).'
              }
              error={jurisdictionError}
            >
              {({ describedBy, invalid }) => (
                <input
                  id="gate-jurisdiction"
                  type="text"
                  autoComplete="off"
                  spellCheck="false"
                  value={isEdgeCountryLocked ? geo.country_code : jurisdictionInput}
                  placeholder={isEdgeCountryLocked ? geo.country_code : 'NON_US_SELF_DECLARED'}
                  readOnly={isEdgeCountryLocked}
                  disabled={!screeningPassed}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  onChange={(event) => setJurisdictionInput(event.target.value)}
                />
              )}
            </Field>
          </div>
        ) : null}

        {activeError ? <p className="err">{activeError}</p> : null}

        <div className="actions">
          <button
            className="btn secondary"
            type="button"
            disabled={screening.loading}
            onClick={() => void web3?.refreshEligibilityScreening()}
          >
            {screening.loading ? 'Screening…' : 'Re-check screening'}
          </button>

          {!connected ? (
            <button
              className="btn secondary"
              type="button"
              disabled={Boolean(web3?.connecting)}
              onClick={() => void web3?.connect()}
            >
              {web3?.connecting ? 'Connecting…' : 'Connect wallet'}
            </button>
          ) : wrongNetwork ? (
            <button
              className="btn"
              type="button"
              onClick={() => void web3?.switchNetwork()}
            >
              Switch to Base ({web3.config.chainId})
            </button>
          ) : null}

          {!wrongNetwork ? (
            <button
              className="btn"
              type="submit"
              disabled={!canEnter || Boolean(web3?.signingDeclaration)}
            >
              {!connected
                ? 'Enter read-only desk'
                : declValid
                  ? 'Enter NOSTOK'
                  : web3?.signingDeclaration
                    ? 'Signing EIP-712 declaration…'
                    : 'Sign EIP-712 Reg S declaration & enter'}
            </button>
          ) : null}
        </div>
      </form>
    </main>
  );
}

export function Restricted() {
  const { act, web3 } = useStore();
  const [recheckMsg, setRecheckMsg] = useState('');
  const screening = web3?.eligibilityScreening;
  const reasons = Array.isArray(screening?.data?.rejection_reasons) ? screening.data.rejection_reasons : [];
  const walletEligibility =
    web3?.walletState && web3?.address && web3.walletState.address === web3.address
      ? web3.walletState.eligibility
      : null;

  async function recheck() {
    setRecheckMsg('');
    const fresh = await web3?.refreshEligibilityScreening({ allowRecoverFromRestriction: true });
    if (!fresh) {
      setRecheckMsg(web3?.eligibilityScreening?.error || 'Compliance screening API unreachable.');
      return;
    }
    if (fresh.allowed && !walletEligibility?.isRevoked) {
      act({ type: 'reset-gate' });
      return;
    }
    const first = fresh.rejection_reasons?.[0];
    setRecheckMsg(
      first ? `${first.code}: ${first.message}` : 'Access remains restricted by compliance screening.'
    );
  }

  return (
    <main className="wrap gate" id="main">
      <p className="mark">NOSTOK</p>
      <p className="kicker">Unavailable</p>
      <h1>This interface is not available here.</h1>
      <p className="lede">
        NOSTOK does not offer stock-backed loans to US persons, sanctioned addresses, revoked accounts, Tor exits, or restricted jurisdictions.
      </p>
      {reasons.length > 0 || walletEligibility?.isRevoked ? (
        <div className="note">
          {reasons.map((r, idx) => (
            <p className="err" key={`${r.code}-${idx}`}>
              {r.code}: {r.message}
            </p>
          ))}
          {walletEligibility?.isRevoked && !reasons.some((r) => r.code === 'WALLET_REVOKED') ? (
            <p className="err">
              WALLET_REVOKED: Connected wallet {web3.address} is revoked on EligibilityGate.
            </p>
          ) : null}
        </div>
      ) : null}
      {recheckMsg ? <p className="err">{recheckMsg}</p> : null}
      <div className="actions">
        <button
          className="btn secondary"
          type="button"
          disabled={Boolean(screening?.loading)}
          onClick={() => void recheck()}
        >
          {screening?.loading ? 'Re-checking…' : 'Re-check IP & wallet eligibility'}
        </button>
      </div>
    </main>
  );
}
