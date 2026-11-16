import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Field, Page, Rows, Sheet, TextInput } from '../components/ui.jsx';
import { shortAddress } from '../lib/web3.js';
import { useStore } from '../store.jsx';

export function Wallet() {
  const { web3 } = useStore();
  const [copied, setCopied] = useState(false);

  const ws = web3.walletState;
  const isLive = Boolean(ws && !ws.stale && !web3.wrongNetwork);

  async function copyAddress() {
    if (!web3.address) return;
    try {
      await navigator.clipboard.writeText(web3.address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Page
      kicker="Wallet & Sign-In"
      title={web3.connected ? shortAddress(web3.address) : 'Connect a Base wallet.'}
      lede="Connect an EIP-1193 wallet on Base Mainnet (chainId 8453) to verify balances, on-chain EligibilityGate status, and sign in to Notifications via SIWE (EIP-4361)."
    >
      {web3.walletError ? <p className="err">{web3.walletError}</p> : null}

      <p className="addr">{web3.address ?? 'No wallet connected'}</p>

      <div className="actions">
        {!web3.connected ? (
          <button className="btn" type="button" onClick={() => void web3.connect()} disabled={web3.connecting}>
            {web3.connecting ? 'Connecting…' : 'Connect wallet'}
          </button>
        ) : (
          <>
            {web3.wrongNetwork ? (
              <button className="btn" type="button" onClick={() => void web3.switchNetwork()}>
                Switch to Base ({web3.config.chainId})
              </button>
            ) : null}
            <button className="btn secondary" type="button" onClick={copyAddress}>
              {copied ? 'Copied' : 'Copy address'}
            </button>
            <button className="btn secondary" type="button" onClick={() => void web3.refresh()} disabled={web3.loadingState}>
              {web3.loadingState ? 'Refreshing…' : 'Refresh live state'}
            </button>
            <button className="btn secondary" type="button" onClick={() => void web3.disconnect()}>
              Disconnect
            </button>
          </>
        )}
      </div>

      <div className="block split">
        <Sheet
          title="Notifications SIWE session"
          note="Sign an EIP-4361 message issued by notifications/ POST /auth/nonce and verified by POST /auth/verify. Signing is free and sends no on-chain transaction."
        >
          {web3.siweError ? <p className="err">{web3.siweError}</p> : null}
          {web3.siweNotice ? <p className="hint">{web3.siweNotice}</p> : null}
          <Rows
            items={[
              {
                label: 'Notifications endpoint',
                value: web3.config.notificationsUrl,
              },
              {
                label: 'SIWE session status',
                value: web3.siweSession ? 'Authenticated' : 'Signed out',
              },
              web3.siweSession
                ? { label: 'Session ID (jti)', value: web3.siweSession.jti }
                : null,
              web3.siweSession
                ? { label: 'Session expires', value: web3.siweSession.expiresAt }
                : null,
              web3.siweSubscriptions
                ? { label: 'Saved subscriptions', value: String(web3.siweSubscriptions.length) }
                : null,
              web3.siwePreferences
                ? {
                    label: 'Hourly alert cap',
                    value: String(web3.siwePreferences.max_per_hour ?? 'Default'),
                  }
                : null,
            ]}
          />
          <div className="actions">
            {!web3.siweSession ? (
              <button
                className="btn"
                type="button"
                onClick={() => void web3.signIn()}
                disabled={!web3.connected || web3.wrongNetwork || web3.signingIn}
              >
                {web3.signingIn ? 'Signing SIWE…' : 'Sign in with Ethereum (SIWE)'}
              </button>
            ) : (
              <button className="btn secondary" type="button" onClick={() => void web3.signOut()}>
                Sign out (revoke session)
              </button>
            )}
          </div>
        </Sheet>

        <Sheet
          title="Live on-chain balances & status"
          note={
            ws
              ? ws.stale
                ? 'One or more RPC or indexer reads failed; partial or stale values are withheld.'
                : `Live read at ${ws.fetchedAt}`
              : 'Connect your wallet to load live Base balances and EligibilityGate status.'
          }
        >
          {ws?.rpcError ? <p className="err">{ws.rpcError}</p> : null}
          {ws?.apiError ? <p className="err">{ws.apiError}</p> : null}
          <Rows
            items={[
              {
                label: 'Wallet network',
                value: web3.connected
                  ? web3.wrongNetwork
                    ? `Wrong network (chainId ${web3.chainId})`
                    : `Base (${web3.chainId ?? web3.config.chainId})`
                  : 'Disconnected',
              },
              {
                label: 'Live data status',
                value: ws ? (isLive ? 'Live' : 'Degraded / withheld') : 'Not fetched',
              },
              {
                label: 'ETH balance (18 dec)',
                value: ws?.ethBalance ? `${ws.ethBalance.formatted} ETH` : ws ? 'Unavailable' : '—',
              },
              {
                label: 'USDC balance (6 dec)',
                value: ws?.usdcBalance ? `${ws.usdcBalance.formatted} USDC` : ws ? 'Unavailable' : '—',
              },
              {
                label: 'LoanCore claimable (6 dec)',
                value: ws?.claimableUsdc
                  ? `${ws.claimableUsdc.formatted} USDC`
                  : web3.config.contracts.loanCore
                    ? ws ? 'Unavailable' : '—'
                    : 'LoanCore address unset',
              },
              ...(ws?.collateralBalances ?? []).map((tok) => ({
                label: `${tok.symbol} (${tok.decimals} dec)`,
                value: `${tok.formatted} ${tok.symbol}`,
              })),
              ws?.eligibility
                ? {
                    label: 'EligibilityGate',
                    value: ws.eligibility.isRevoked
                      ? 'Revoked'
                      : ws.eligibility.isEligible
                        ? `Eligible (${ws.eligibility.permissionlessMode ? 'permissionless' : ws.eligibility.allowlisted ? 'allowlisted' : 'attested'})`
                        : 'Attestation or allowlist required',
                  }
                : null,
              ws?.apiHealth
                ? {
                    label: 'Indexer health',
                    value: `${ws.apiHealth.status} (lag ${ws.apiHealth.lag_blocks ?? 0} blocks)`,
                  }
                : null,
              {
                label: 'Open loans you borrow',
                value: ws && !ws.apiError ? String(ws.openBorrowCount) : ws ? 'Unavailable' : '—',
              },
              {
                label: 'Open claims you hold',
                value: ws && !ws.apiError ? String(ws.openLenderCount) : ws ? 'Unavailable' : '—',
              },
            ]}
          />
          {web3.connected ? (
            <div className="block">
              <Field
                id="attestation-hex"
                label="Eligibility attestation context (optional 0x hex)"
                hint="Passed to EligibilityGate.isEligible(account, context) if KYC attestation gating is enabled."
              >
                {({ describedBy, invalid }) => (
                  <TextInput
                    id="attestation-hex"
                    inputMode="text"
                    value={web3.attestationHex}
                    onChange={web3.setAttestationHex}
                    describedBy={describedBy}
                    invalid={invalid}
                  />
                )}
              </Field>
            </div>
          ) : null}
        </Sheet>
      </div>

      <div className="actions">
        <Link className="btn" to="/loans">Your loans</Link>
        <Link className="btn secondary" to="/positions">Your claims</Link>
        <Link className="btn secondary" to="/alerts">Notifications & alerts</Link>
      </div>
    </Page>
  );
}
