import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Choice, Field, Page, Sheet, TextInput } from '../components/ui.jsx';
import { openOrders } from '../lib/book.js';
import { ASSETS, partyName, stateLabel } from '../lib/data.js';
import { formatApr, formatLeft, formatTokens, formatUsd, formatWhen, parseDollars, parseTokens } from '../lib/format.js';
import { termSheet, tokensForValue, valueCents } from '../lib/money.js';
import { assess } from '../lib/origination.js';
import { useStore } from '../store.jsx';
import { CLOCK } from '../lib/data.js';

const FILTERS = ['All', 'NVDAc', 'AAPLc', 'MSFTc', 'GOOGLc', 'AMZNc', 'METAc'];

function matches(order, filter) {
  if (filter === 'All') return true;
  return order.asset === filter || order.assets.includes(filter);
}

export function Markets() {
  const { state, act } = useStore();
  const [filter, setFilter] = useState('All');
  const [selected, setSelected] = useState('');
  const [usdc, setUsdc] = useState('');
  const [tokens, setTokens] = useState('');
  const [asset, setAsset] = useState('NVDAc');
  const [inKind, setInKind] = useState(false);
  const [yieldOn, setYieldOn] = useState(false);
  const [message, setMessage] = useState('');
  const [formError, setFormError] = useState('');
  const orders = openOrders(state).filter((order) => matches(order, filter));
  const borrows = orders.filter((order) => order.side === 'borrow');
  const lends = orders.filter((order) => order.side === 'lend');
  const order = orders.find((item) => item.id === selected) || state.orders.find((item) => item.id === selected);

  function dollars(cents) {
    return (cents / 100).toFixed(2).replace(/\.00$/, '');
  }

  function suggest(symbol, usdcCents, maxLtvBps) {
    const named = ASSETS[symbol];
    if (!named?.oracleCents || !usdcCents || !maxLtvBps) return '';
    const haircut = named.state === 'VALID_CLOSED' ? named.haircutBps : 0;
    const cap = Math.min(maxLtvBps, named.maxInitLtvBps);
    const effectiveNeeded = Math.ceil((usdcCents * 10000) / cap);
    const grossNeeded = Math.ceil((effectiveNeeded * 10000) / (10000 - haircut));
    return formatTokens(tokensForValue(grossNeeded, named.oracleCents));
  }

  function choose(item) {
    setSelected(item.id);
    setMessage('');
    setFormError('');
    const capped = Math.min(item.remainingCents, 1000000);
    setUsdc(dollars(capped));
    setInKind(false);
    setYieldOn(false);
    if (item.side === 'lend') {
      const symbol = item.assets[0];
      setAsset(symbol);
      setTokens(suggest(symbol, capped, item.maxLtvBps));
    }
  }

  const principal = parseDollars(usdc);
  const tokenMicro = order?.side === 'borrow'
    ? (principal && order.remainingCents
      ? (principal === order.remainingCents
        ? order.remainingTokenMicro
        : Number((BigInt(order.remainingTokenMicro) * BigInt(principal) + BigInt(order.remainingCents) - 1n) / BigInt(order.remainingCents)))
      : null)
    : parseTokens(tokens);
  const chosen = order ? ASSETS[order.side === 'borrow' ? order.asset : asset] : null;
  const check = order && principal && tokenMicro && chosen
    ? assess({ asset: chosen, tokenMicro, principalCents: principal, maxLtvBps: order.maxLtvBps })
    : null;
  const quote = order && principal ? termSheet({ principalCents: principal, rateBps: order.rateBps, termDays: order.termDays }) : null;

  function submit(event) {
    event.preventDefault();
    if (!order) return;
    const next = act({
      type: 'fill',
      id: order.id,
      usdcCents: principal,
      tokenMicro,
      asset: order.side === 'lend' ? asset : order.asset,
      inKind,
      yieldOn,
    });
    setFormError(next.error || '');
    setMessage(next.error ? '' : next.notice);
    if (!next.error) setSelected('');
  }

  function cancel(id) {
    const next = act({ type: 'cancel', id });
    setMessage(next.notice || '');
    setFormError(next.error || '');
  }

  return (
    <Page
      kicker="Markets"
      title="The book."
      lede="Orders are public. A fill can be partial. Each fill is its own loan and its own Position NFT. The stock is pulled only when the order is filled."
    >
      <div className="chips" role="group" aria-label="Filter by stock">
        {FILTERS.map((item) => (
          <button key={item} type="button" aria-pressed={filter === item} onClick={() => setFilter(item)}>{item}</button>
        ))}
      </div>

      <section className="block">
        <h2>Borrow orders</h2>
        <p className="hint">A borrower is offering stock and asking for USDC.</p>
        {borrows.length === 0 ? <p className="lede">No open borrow orders in this filter.</p> : borrows.map((item) => (
          <article className="order-row" key={item.id}>
            <div>
              <strong>{item.asset} · {formatApr(item.rateBps)} APR</strong>
              <span className="quiet">{formatUsd(item.remainingCents)} left · {item.termDays} days · max LTV {formatApr(item.maxLtvBps)} · {partyName(item.maker)}</span>
              <span className="quiet">{stateLabel(ASSETS[item.asset].state)} · expires {formatWhen(item.expiry)}</span>
            </div>
            {item.maker === 'you'
              ? <button className="btn secondary" type="button" onClick={() => cancel(item.id)}>Cancel</button>
              : <button className="btn" type="button" onClick={() => choose(item)}>Review fill</button>}
          </article>
        ))}
      </section>

      <section className="block">
        <h2>Lend offers</h2>
        <p className="hint">A lender is offering USDC against the stocks they name.</p>
        {lends.length === 0 ? <p className="lede">No open lend offers in this filter.</p> : lends.map((item) => (
          <article className="order-row" key={item.id}>
            <div>
              <strong>{formatUsd(item.remainingCents)} · {formatApr(item.rateBps)} APR</strong>
              <span className="quiet">{item.termDays} days · max LTV {formatApr(item.maxLtvBps)} · {item.assets.join(', ')} · {partyName(item.maker)}</span>
              <span className="quiet">Expires {formatWhen(item.expiry)} · {formatLeft(item.expiry - CLOCK)} left</span>
            </div>
            {item.maker === 'you'
              ? <button className="btn secondary" type="button" onClick={() => cancel(item.id)}>Cancel</button>
              : <button className="btn" type="button" onClick={() => choose(item)}>Review fill</button>}
          </article>
        ))}
      </section>

      <div className="actions">
        <button className="btn secondary" type="button" onClick={() => {
          const next = act({ type: 'cancel-mine' });
          setMessage(next.notice || '');
          setFormError(next.error || '');
        }}>Cancel all my open orders</button>
      </div>

      {order && order.remainingCents > 0 ? (
        <form id="fill-panel" className="block" tabIndex={-1} onSubmit={submit}>
          <Sheet
            title={order.side === 'borrow' ? `Fill borrow ${order.id}` : `Fill offer ${order.id}`}
            note="You become the other side of a new loan. Collateral moves only in this fill."
            items={quote && check ? [
              { label: 'Fill', value: formatUsd(principal) },
              { label: 'Stock', value: `${formatTokens(tokenMicro || 0)} ${chosen.symbol}` },
              { label: 'Oracle value', value: formatUsd(valueCents(tokenMicro || 0, chosen.oracleCents)) },
              { label: 'Rate', value: `${formatApr(order.rateBps)} APR` },
              { label: 'Term', value: `${order.termDays} days` },
              { label: 'You pay or escrow', value: order.side === 'borrow' ? formatUsd(principal) : `${formatTokens(tokenMicro || 0)} ${chosen.symbol}` },
              { label: order.side === 'borrow' ? 'You receive at maturity' : 'Borrower receives now', value: order.side === 'borrow' ? formatUsd(quote.holder) : formatUsd(quote.proceeds) },
            ] : []}
          >
            <div className="fields">
              <Field id="fill-usdc" label="USDC to fill" hint={`Between ${formatUsd(Math.max(50000, order.minFillCents))} and ${formatUsd(Math.min(order.remainingCents, 1000000))}.`}>
                {(props) => <TextInput id="fill-usdc" value={usdc} onChange={setUsdc} {...props} />}
              </Field>
              {order.side === 'lend' ? (
                <>
                  <div className="field">
                    <label htmlFor="fill-asset">Stock you will escrow</label>
                    <select id="fill-asset" value={asset} onChange={(event) => {
                      const symbol = event.target.value;
                      setAsset(symbol);
                      if (principal) setTokens(suggest(symbol, Math.min(principal, 1000000), order.maxLtvBps));
                    }}>
                      {order.assets.map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                  </div>
                  <Field id="fill-tokens" label="Raw units" hint={chosen.state === 'VALID_CLOSED' ? 'The market is closed. Origination uses the extra haircut. Liquidation will not run until it opens.' : 'Enough stock to sit inside the offer’s LTV cap.'}>
                    {(props) => <TextInput id="fill-tokens" value={tokens} onChange={setTokens} {...props} />}
                  </Field>
                </>
              ) : null}
              {order.yieldMode === 'lender' ? (
                <Choice id="fill-yield" checked={yieldOn} onChange={setYieldOn}>
                  Turn yield on for this fill. The lender earns what the venue pays on the locked stock and bears any venue loss. Leave this off and the stock is not lent on.
                </Choice>
              ) : <p className="hint">Yield on this order is off. The stock is not lent on.</p>}
              {order.inKind ? (
                <Choice id="fill-inkind" checked={inKind} onChange={setInKind}>
                  Agree to in-kind settlement. The other side already allowed it.
                </Choice>
              ) : null}
              {check && !check.ok ? <p className="err">{check.error}</p> : null}
              {formError ? <p className="err" role="alert">{formError}</p> : null}
              <button className="btn" type="submit">Confirm fill</button>
            </div>
          </Sheet>
        </form>
      ) : null}
      {message ? <p className="note" role="status">{message} {message.startsWith('Loan') ? <Link to="/loans">See loans.</Link> : null}</p> : null}
    </Page>
  );
}
