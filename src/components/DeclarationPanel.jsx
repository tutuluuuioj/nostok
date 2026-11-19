import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ELIGIBILITY_DECLARATION_STATEMENT,
  RESTRICTED_JURISDICTIONS,
} from '../lib/contracts.js';
import { formatWeb3Error, normalizeJurisdictionCode, shortAddress } from '../lib/web3.js';
import { useStore } from '../store.jsx';
import { Field, Rows, Sheet } from './ui.jsx';

export function resolveJurisdictionSelection(geo, rawInput, restrictedCountries = RESTRICTED_JURISDICTIONS) {
  const restrictedList = Array.isArray(restrictedCountries) && restrictedCountries.length > 0
    ? restrictedCountries
    : RESTRICTED_JURISDICTIONS;
  const isEdgeCountryLocked = Boolean(geo?.verified && geo?.country_code);
  const candidate = isEdgeCountryLocked
    ? geo.country_code
    : (typeof rawInput === 'string' && rawInput.trim() !== '' ? rawInput.trim() : 'NON_US_SELF_DECLARED');

  try {
    const resolved = normalizeJurisdictionCode(candidate, { restrictedList });
    return { isEdgeCountryLocked, resolved, error: '' };
  } catch (err) {
    return {
      isEdgeCountryLocked,
      resolved: candidate,
      error: err instanceof Error ? err.message : 'Invalid jurisdiction code.',
    };
  }
}

export function formatRegSDeclarationRowValue(web3) {
  if (!web3?.connected) return 'Connect Base wallet';
  if (web3.wrongNetwork) return `Wrong network (${web3.chainId})`;
  if (web3.verifyingDeclaration) return 'Verifying via POST /eligibility/verify…';
  if (web3.eligibilityDeclarationValid) {
    const j = web3.eligibilityDeclaration?.declarationJson?.jurisdiction ?? web3.eligibilityDeclarationStatus?.jurisdiction ?? 'Verified';
    const n = web3.eligibilityDeclaration?.declarationJson?.nonce ?? '0';
    return `Verified (${j}, nonce ${n})`;
  }
  return `Required (${web3.eligibilityDeclarationStatus?.code ?? 'DECLARATION_MISSING'})`;
}

function formatExpiryIso(rawSecs) {
  if (!rawSecs || !/^\d+$/.test(String(rawSecs))) return '—';
  const ms = Number(rawSecs) * 1000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(rawSecs);
}

/**
 * Compact compliance gate banner rendered on Borrow, Lend, and Loan pages when a connected
 * Base wallet does not yet hold a verified EIP-712 Regulation S declaration.
 */
export function ComplianceTxGateBanner({ actionLabel = 'approve, sign, or execute transactions' }) {
  const { web3 } = useStore();
  const [jurisdictionInput, setJurisdictionInput] = useState('');
  const [localError, setLocalError] = useState('');

  if (!web3?.connected || web3.wrongNetwork || web3.eligibilityDeclarationValid) {
    return null;
  }

  const screening = web3.eligibilityScreening;
  const geo = screening?.data?.geo ?? null;
  const screeningPassed = Boolean(screening?.data?.allowed === true && !screening?.error && !web3.hardRestricted);
  const { isEdgeCountryLocked, resolved, error: jurisdictionError } = resolveJurisdictionSelection(
    geo,
    jurisdictionInput,
    screening?.data?.declaration_params?.restricted_countries
  );

  async function handleInlineSign() {
    setLocalError('');
    if (!screeningPassed) {
      setLocalError(screening?.error || 'Compliance screening must pass before signing.');
      return;
    }
    if (jurisdictionError) {
      setLocalError(jurisdictionError);
      return;
    }
    try {
      await web3.signAndVerifyDeclaration({ jurisdiction: resolved });
    } catch (err) {
      setLocalError(formatWeb3Error(err));
    }
  }

  const activeError = localError || web3.declarationError || screening?.error || '';
  const statusReason = web3.verifyingDeclaration
    ? 'Re-verifying stored EIP-712 declaration via api/ POST /eligibility/verify…'
    : web3.eligibilityDeclarationStatus?.reason || 'Sign an EIP-712 Regulation S declaration for this wallet.';

  return (
    <div className="err block" role="region" aria-label="Regulation S compliance gate">
      <p>
        <strong>EIP-712 Regulation S declaration required</strong> to {actionLabel}. {statusReason}
      </p>
      <p className="hint" style={{ marginTop: 6 }}>
        <strong>IP screening:</strong>{' '}
        {geo?.verified
          ? `Edge verified ${geo.country_code}`
          : geo?.status === 'disabled'
            ? 'Server geoblock override enabled'
            : geo?.status === 'local_unverified'
              ? 'Local fork (self-declared jurisdiction permitted)'
              : screening?.loading
                ? 'Checking api/ GET /eligibility…'
                : 'Awaiting screening'}
      </p>
      <div className="block" style={{ marginTop: 10 }}>
        <Field
          id="tx-gate-jurisdiction"
          label={
            isEdgeCountryLocked
              ? 'Declared jurisdiction (edge IP verified)'
              : 'Declared jurisdiction (ISO-3166 alpha-2 or NON_US_SELF_DECLARED)'
          }
          error={jurisdictionError}
        >
          {({ describedBy, invalid }) => (
            <input
              id="tx-gate-jurisdiction"
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
      {activeError ? <p className="err">{activeError}</p> : null}
      <div className="actions" style={{ marginTop: 10 }}>
        <button
          className="btn"
          type="button"
          disabled={
            !screeningPassed ||
            Boolean(jurisdictionError) ||
            Boolean(web3.signingDeclaration) ||
            Boolean(web3.verifyingDeclaration)
          }
          onClick={() => void handleInlineSign()}
        >
          {web3.signingDeclaration
            ? 'Signing EIP-712 Reg S declaration…'
            : web3.verifyingDeclaration
              ? 'Verifying declaration…'
              : 'Sign & verify Reg S declaration'}
        </button>
        <button
          className="btn secondary"
          type="button"
          disabled={Boolean(screening?.loading)}
          onClick={() => void web3.refreshEligibilityScreening()}
        >
          {screening?.loading ? 'Re-checking…' : 'Re-check screening'}
        </button>
        <Link className="btn secondary" to="/wallet">
          Manage on Wallet
        </Link>
      </div>
    </div>
  );
}

/**
 * Full compliance, EligibilityGate attestation inspection, EIP-712 Reg S declaration signing,
 * and on-chain bumpMyNonce() control sheet for Wallet.jsx.
 */
export function ComplianceDeclarationSheet() {
  const { web3 } = useStore();
  const [jurisdictionInput, setJurisdictionInput] = useState('');
  const [localError, setLocalError] = useState('');

  const screening = web3?.eligibilityScreening;
  const screeningData = screening?.data ?? null;
  const geo = screeningData?.geo ?? null;
  const ws = web3?.walletState && web3?.address && web3.walletState.address === web3.address ? web3.walletState : null;
  const elig = ws?.eligibility ?? null;
  const att = elig?.attestation ?? null;
  const decl = web3?.eligibilityDeclaration ?? null;
  const declStatus = web3?.eligibilityDeclarationStatus ?? { valid: false, code: 'DECLARATION_MISSING', reason: '' };
  const declJson = decl?.declarationJson ?? null;

  const screeningPassed = Boolean(screeningData?.allowed === true && !screening?.error && !web3?.hardRestricted);
  const { isEdgeCountryLocked, resolved, error: jurisdictionError } = resolveJurisdictionSelection(
    geo,
    jurisdictionInput,
    screeningData?.declaration_params?.restricted_countries
  );

  async function handleSign() {
    setLocalError('');
    if (!screeningPassed) {
      setLocalError(screening?.error || 'API eligibility screening must pass before signing.');
      return;
    }
    if (jurisdictionError) {
      setLocalError(jurisdictionError);
      return;
    }
    try {
      await web3.signAndVerifyDeclaration({ jurisdiction: resolved });
    } catch (err) {
      setLocalError(formatWeb3Error(err));
    }
  }

  async function handleBumpNonce() {
    setLocalError('');
    try {
      await web3.bumpMyEligibilityNonce();
    } catch (err) {
      setLocalError(formatWeb3Error(err));
    }
  }

  const activeError = localError || web3?.declarationError || screening?.error || '';

  return (
    <div className="block">
      <Sheet
        title="Compliance, EligibilityGate & EIP-712 Reg S Declaration"
        note="Transactions on Borrow, Lend, and Loan require an active non-US EIP-712 EligibilityDeclaration verified by api/ POST /eligibility/verify and bound to your live EligibilityGate.userNonce."
      >
        {activeError ? <p className="err" role="alert">{activeError}</p> : null}
        {web3?.declarationNotice ? <p className="hint" role="status">{web3.declarationNotice}</p> : null}

        <Rows
          items={[
            {
              label: 'IP geolocation (api/ GET /eligibility)',
              value: screening?.loading && !geo
                ? 'Screening…'
                : screening?.error
                  ? `Error (${screening.error})`
                  : geo
                    ? geo.verified
                      ? `Verified ${geo.country_code} (${geo.allowed ? 'allowed' : geo.reason ?? 'blocked'})`
                      : `${geo.status} (${geo.allowed ? 'allowed' : geo.reason ?? 'blocked'})`
                    : 'Not fetched',
            },
            {
              label: 'Sanctions screening',
              value: !web3?.connected
                ? 'Connect wallet'
                : screeningData?.wallet
                  ? screeningData.wallet.sanctioned
                    ? `BLOCKED (${shortAddress(web3.address)} sanctioned)`
                    : `Cleared (${shortAddress(web3.address)})`
                  : screening?.loading
                    ? 'Checking…'
                    : 'Unavailable',
            },
            {
              label: 'EligibilityGate contract',
              value: elig?.gateAddress ?? web3?.config?.contracts?.eligibilityGate ?? 'Unset',
            },
            elig
              ? {
                  label: 'On-chain status & mode',
                  value: elig.isRevoked
                    ? 'Revoked'
                    : `${elig.isEligible ? 'Eligible' : 'Not eligible'} (${elig.eligibilityReason}; permissionless=${elig.permissionlessMode ? 'yes' : 'no'}, allowlisted=${elig.allowlisted ? 'yes' : 'no'})`,
                }
              : null,
            elig
              ? {
                  label: 'EligibilityGate userNonce',
                  value: String(elig.userNonce ?? '0'),
                }
              : null,
            elig
              ? {
                  label: 'Configured attestationSigner',
                  value: elig.attestationSigner ?? '—',
                }
              : null,
            att?.provided
              ? {
                  label: 'Attestation hex inspection',
                  value: att.validFormat
                    ? `Expiry ${formatExpiryIso(att.expiry)} (${att.isExpired ? 'EXPIRED' : 'unexpired'}) · Signer ${att.recoveredSigner ?? '—'} · Matches signer: ${att.matchesAttestationSigner ? 'Yes' : 'No'}`
                    : `Invalid (${att.error})`,
                }
              : null,
            {
              label: 'EIP-712 Reg S declaration status',
              value: web3?.verifyingDeclaration
                ? 'Re-verifying with api/ POST /eligibility/verify…'
                : declStatus.valid
                  ? `Verified (${declStatus.jurisdiction}, nonce ${declJson?.nonce ?? '0'})`
                  : `${declStatus.code}: ${declStatus.reason}`,
            },
            declJson
              ? {
                  label: 'Signed declaration window',
                  value: `Issued ${formatExpiryIso(declJson.issuedAt)} -> Expires ${formatExpiryIso(declJson.expiresAt)}`,
                }
              : null,
            decl?.digest
              ? {
                  label: 'Declaration EIP-712 digest',
                  value: decl.digest,
                }
              : null,
          ]}
        />

        <div className="note" style={{ marginTop: 12 }}>
          <p className="hint">
            <strong>Canonical Regulation S statement:</strong> {ELIGIBILITY_DECLARATION_STATEMENT}
          </p>
        </div>

        {web3?.connected && !web3?.wrongNetwork ? (
          <div className="block" style={{ marginTop: 12 }}>
            <Field
              id="wallet-jurisdiction"
              label={
                isEdgeCountryLocked
                  ? 'Declared jurisdiction (locked by verified IP country)'
                  : 'Declared jurisdiction (ISO-3166 alpha-2 or NON_US_SELF_DECLARED)'
              }
              hint={
                isEdgeCountryLocked
                  ? `Edge proxy verified IP jurisdiction ${geo.country_code}.`
                  : 'In local fork / GEO_DISABLED mode, enter a non-US ISO code (e.g. CH, SG) or leave blank for NON_US_SELF_DECLARED.'
              }
              error={jurisdictionError}
            >
              {({ describedBy, invalid }) => (
                <input
                  id="wallet-jurisdiction"
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

        <div className="actions" style={{ marginTop: 12 }}>
          <button
            className="btn"
            type="button"
            disabled={
              !web3?.connected ||
              Boolean(web3?.wrongNetwork) ||
              !screeningPassed ||
              Boolean(jurisdictionError) ||
              Boolean(web3?.signingDeclaration) ||
              Boolean(web3?.verifyingDeclaration) ||
              Boolean(web3?.bumpingEligibilityNonce)
            }
            onClick={() => void handleSign()}
          >
            {web3?.signingDeclaration
              ? 'Signing EIP-712 declaration…'
              : declStatus.valid
                ? 'Re-sign & verify EIP-712 Reg S declaration'
                : 'Sign & verify EIP-712 Reg S declaration'}
          </button>

          <button
            className="btn secondary"
            type="button"
            disabled={Boolean(screening?.loading)}
            onClick={() => void web3?.refreshEligibilityScreening()}
          >
            {screening?.loading ? 'Re-checking…' : 'Re-check compliance screening'}
          </button>

          {decl ? (
            <button
              className="btn secondary"
              type="button"
              disabled={Boolean(web3?.signingDeclaration) || Boolean(web3?.verifyingDeclaration)}
              onClick={() => web3?.clearEligibilityDeclaration()}
            >
              Clear stored declaration
            </button>
          ) : null}

          <button
            className="btn secondary"
            type="button"
            disabled={
              !web3?.connected ||
              Boolean(web3?.wrongNetwork) ||
              Boolean(web3?.bumpingEligibilityNonce) ||
              Boolean(web3?.signingDeclaration)
            }
            onClick={() => void handleBumpNonce()}
          >
            {web3?.bumpingEligibilityNonce
              ? 'Bumping EligibilityGate nonce…'
              : 'Bump EligibilityGate nonce (on-chain)'}
          </button>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          <code>Bump EligibilityGate nonce</code> sends <code>EligibilityGate.bumpMyNonce()</code> (zero token approvals) to invalidate all prior KYC attestations and signed EIP-712 Reg S declarations.
        </p>
      </Sheet>
    </div>
  );
}
