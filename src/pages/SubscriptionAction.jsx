import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Field, Page, Rows, Sheet, TextInput } from '../components/ui.jsx';
import { getFrontendConfig } from '../lib/contracts.js';
import { fetchJsonStrict } from '../lib/web3.js';
import { useStore } from '../store.jsx';

/**
 * Handles one-click email link confirmation and sender/address blocking via explicit POST.
 * GET previews token details cleanly without side effects; buttons issue the POST request.
 */
export function SubscriptionAction({ mode = 'confirm' }) {
  const { web3 } = useStore();
  const [searchParams] = useSearchParams();
  const tokenFromUrl = (searchParams.get('token') ?? '').trim();
  const [tokenInput, setTokenInput] = useState(tokenFromUrl);

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [manageOffset, setManageOffset] = useState(0);

  const [submitting, setSubmitting] = useState('');
  const [result, setResult] = useState(null);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    setTokenInput(tokenFromUrl);
    setManageOffset(0);
  }, [tokenFromUrl]);

  const activeToken = tokenInput.trim();
  const cfg = web3?.config ?? getFrontendConfig();
  const endpointPath =
    mode === 'block'
      ? '/subscriptions/block'
      : mode === 'unblock'
        ? '/subscriptions/unblock'
        : mode === 'manage'
          ? '/subscriptions/manage'
          : '/subscriptions/confirm';

  const loadPreview = useCallback(
    async (tok, nextOffset = 0) => {
      if (!tok || !cfg?.notificationsUrl) return;
      setPreviewLoading(true);
      setPreviewError('');
      try {
        const qs =
          mode === 'manage'
            ? `?token=${encodeURIComponent(tok)}&limit=20&offset=${nextOffset}`
            : `?token=${encodeURIComponent(tok)}`;
        const res = await fetchJsonStrict(`${cfg.notificationsUrl}${endpointPath}${qs}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        setPreviewData(res);
        setManageOffset(nextOffset);
      } catch (err) {
        setPreviewData(null);
        setPreviewError(err instanceof Error ? err.message : String(err));
      } finally {
        setPreviewLoading(false);
      }
    },
    [cfg?.notificationsUrl, endpointPath, mode]
  );

  useEffect(() => {
    if (tokenFromUrl) {
      void loadPreview(tokenFromUrl, 0);
    }
  }, [loadPreview, tokenFromUrl]);

  async function executePost(scope = null, subscriptionId = null, action = 'confirm') {
    if (!activeToken) {
      setSubmitError('Missing verification or block token.');
      return;
    }
    if (!cfg?.notificationsUrl) {
      setSubmitError('VITE_NOTIFICATIONS_URL is not configured.');
      return;
    }
    setSubmitError('');
    setSubmitting(scope || mode);
    try {
      const payload =
        mode === 'block'
          ? {
              token: activeToken,
              scope: scope === 'target_all' ? 'target_all' : 'wallet',
              block_all: scope === 'target_all',
            }
          : mode === 'manage'
            ? {
                token: activeToken,
                subscription_id: subscriptionId,
                action,
              }
            : { token: activeToken };
      const res = await fetchJsonStrict(`${cfg.notificationsUrl}${endpointPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
      setResult(res);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting('');
    }
  }

  const isBlock = mode === 'block';
  const isUnblock = mode === 'unblock';
  const isManage = mode === 'manage';

  return (
    <Page
      kicker={
        isBlock
          ? 'Notifications · Opt-out & Block'
          : isUnblock
            ? 'Notifications · Re-enable Address'
            : isManage
              ? 'Notifications · Manage Pending Requests'
              : 'Notifications · Confirm Subscription'
      }
      title={
        isBlock
          ? 'Stop unwanted alert verification emails.'
          : isUnblock
            ? 'Re-enable NOSTOK alert requests for this address.'
            : isManage
              ? 'Review pending subscription requests.'
              : 'Confirm your alert subscription.'
      }
      lede={
        isBlock
          ? 'Block the specific wallet that requested alerts for this address, or block your entire address across new NOSTOK requests. Note: blocking does not stop existing verified subscriptions — use the unsubscribe link in any alert email or Wallet settings to disable those.'
          : isUnblock
            ? 'Reverse an address-wide block so you can create new alert subscriptions for this address again.'
            : isManage
              ? 'Approve or block any pending wallet subscription request waiting on this target address using your single-use manage link.'
              : 'Review the wallet and subscription ID below, then confirm via POST to activate delivery.'
      }
    >
      <div className="form-layout">
        <div className="fields">
          <Field
            id="sub-action-token"
            label={
              isBlock
                ? 'Block token'
                : isUnblock
                  ? 'Unblock token'
                  : isManage
                    ? 'Manage requests token'
                    : 'Confirmation token'
            }
            hint="Pre-filled from your email link; never submitted on page load (POST only)."
          >
            {(props) => (
              <TextInput
                id="sub-action-token"
                value={tokenInput}
                onChange={(v) => {
                  setTokenInput(v);
                  setResult(null);
                  setSubmitError('');
                }}
                {...props}
              />
            )}
          </Field>

          {previewLoading ? <p className="hint">Checking token details…</p> : null}
          {previewError ? (
            <p className="err" role="alert">
              {previewError}
            </p>
          ) : null}
          {submitError ? (
            <p className="err" role="alert">
              {submitError}
            </p>
          ) : null}

          {result ? (
            <div className="note" role="status">
              {isBlock ? (
                result.scope === 'target_all' || result.block_all ? (
                  <>
                    <strong>Address blocked from new alert requests.</strong> No wallet can create new NOSTOK alert subscriptions for this address ({result.deleted_pending_count ?? 0} unverified pending request(s) removed). Blocking does not stop existing verified subscriptions — use the unsubscribe link in any alert email or <Link to="/wallet">Wallet &amp; alert settings</Link>.
                  </>
                ) : (
                  <>
                    <strong>Sender wallet blocked.</strong> Wallet <code>{result.blocked_wallet}</code> can no longer send requests to this address. Blocking does not stop existing verified subscriptions.
                  </>
                )
              ) : isUnblock ? (
                <>
                  <strong>Address unblocked.</strong> New NOSTOK alert subscription requests are enabled again for this address.
                </>
              ) : isManage ? (
                <>
                  {result.blocked ? (
                    <>
                      <strong>Sender wallet blocked.</strong> Wallet <code>{result.blocked_wallet}</code> is blocked and its pending request was removed.
                    </>
                  ) : (
                    <>
                      <strong>Subscription confirmed.</strong> Channel {result.channel} ({result.id}) is now verified and active for {result.wallet_address}.
                    </>
                  )}
                  {result.remaining_actions &&
                  (result.remaining_actions.confirm > 0 || result.remaining_actions.block > 0) ? (
                    <div className="actions" style={{ marginTop: '8px' }}>
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={() => {
                          setResult(null);
                          void loadPreview(activeToken, manageOffset);
                        }}
                      >
                        Review remaining pending requests ({result.remaining_actions.confirm} confirm,{' '}
                        {result.remaining_actions.block} block(s) left)
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <strong>Subscription confirmed.</strong> Channel {result.channel} ({result.id}) is now verified and active for {result.wallet_address}.
                </>
              )}
            </div>
          ) : null}

          {isManage && Array.isArray(previewData?.data) && !result ? (
            <div className="fields">
              <p className="hint">
                Showing {previewData.data.length} of {previewData.pagination?.total ?? previewData.data.length} unique pending wallet(s)
                {previewData.remaining_actions
                  ? ` · Remaining link actions: ${previewData.remaining_actions.confirm} confirm, ${previewData.remaining_actions.block} block(s)`
                  : ''}.
              </p>
              {previewData.data.length === 0 ? (
                <p className="hint">No pending unverified requests waiting on this address.</p>
              ) : (
                previewData.data.map((item) => (
                  <div key={item.subscription_id} className="note">
                    <div>
                      <strong>{item.wallet_address}</strong> · <code>{item.subscription_id}</code>
                    </div>
                    <div className="actions">
                      <button
                        className="btn"
                        type="button"
                        onClick={() =>
                          void executePost(`confirm:${item.subscription_id}`, item.subscription_id, 'confirm')
                        }
                        disabled={
                          !activeToken ||
                          Boolean(submitting) ||
                          previewData?.remaining_actions?.confirm === 0
                        }
                      >
                        Confirm
                      </button>
                      <button
                        className="btn secondary"
                        type="button"
                        onClick={() =>
                          void executePost(`block:${item.subscription_id}`, item.subscription_id, 'block')
                        }
                        disabled={
                          !activeToken ||
                          Boolean(submitting) ||
                          previewData?.remaining_actions?.block === 0
                        }
                      >
                        Block wallet
                      </button>
                    </div>
                  </div>
                ))
              )}
              {(manageOffset > 0 || previewData.pagination?.has_more) ? (
                <div className="actions">
                  {manageOffset > 0 ? (
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={() => void loadPreview(activeToken, Math.max(0, manageOffset - 20))}
                      disabled={previewLoading}
                    >
                      Previous page
                    </button>
                  ) : null}
                  {previewData.pagination?.has_more ? (
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={() => void loadPreview(activeToken, manageOffset + 20)}
                      disabled={previewLoading}
                    >
                      Next page
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="actions">
            {!previewData && activeToken ? (
              <button
                className="btn secondary"
                type="button"
                onClick={() => void loadPreview(activeToken, manageOffset)}
                disabled={previewLoading || Boolean(submitting)}
              >
                Inspect token
              </button>
            ) : null}

            {isBlock ? (
              <>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => void executePost('wallet')}
                  disabled={!activeToken || Boolean(submitting)}
                >
                  {submitting === 'wallet'
                    ? 'Blocking sender wallet…'
                    : 'Block this sender wallet only'}
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => void executePost('target_all')}
                  disabled={!activeToken || Boolean(submitting)}
                >
                  {submitting === 'target_all'
                    ? 'Blocking email address…'
                    : 'Block this address entirely (all wallets)'}
                </button>
              </>
            ) : isUnblock ? (
              <button
                className="btn"
                type="button"
                onClick={() => void executePost('unblock')}
                disabled={!activeToken || Boolean(submitting)}
              >
                {submitting ? 'Unblocking address…' : 'Unblock this address'}
              </button>
            ) : isManage ? null : (
              <button
                className="btn"
                type="button"
                onClick={() => void executePost('confirm')}
                disabled={!activeToken || Boolean(submitting)}
              >
                {submitting ? 'Confirming subscription…' : 'Confirm email subscription'}
              </button>
            )}

            <Link className="btn secondary" to="/wallet">
              Wallet &amp; alert settings
            </Link>
          </div>
        </div>

        <Sheet
          title={
            isBlock
              ? 'Block request details'
              : isUnblock
                ? 'Unblock request details'
                : isManage
                  ? 'Pending request summary'
                  : 'Subscription details'
          }
          note="Tokens are verified via HMAC against notifications/ without exposing plaintext recipient addresses."
        >
          <Rows
            items={[
              { label: 'Service endpoint', value: `${cfg.notificationsUrl}${endpointPath}` },
              previewData?.subscription_id
                ? { label: 'Subscription ID', value: previewData.subscription_id }
                : null,
              previewData?.wallet_address
                ? { label: 'Subscriber wallet', value: previewData.wallet_address }
                : null,
              previewData?.blocked_wallet
                ? { label: 'Sender wallet to block', value: previewData.blocked_wallet }
                : null,
              { label: 'Submission method', value: 'Explicit POST (CSRF/scanner safe)' },
            ]}
          />
        </Sheet>
      </div>
    </Page>
  );
}
