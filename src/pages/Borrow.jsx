import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Choice, Field, Page, Sheet, TextInput } from '../components/ui.jsx';
import { ASSETS } from '../lib/data.js';
import { formatApr, formatHundredths, formatTokens, formatUsd, parseDays, parseDollars, parsePercent, parseTokens } from '../lib/format.js';
import { termSheet, valueCents } from '../lib/money.js';
import { assess } from '../lib/origination.js';
import { stateLabel } from '../lib/data.js';
import { useStore } from '../store.jsx';

const LAUNCH = ['NVDAc', 'AAPLc', 'MSFTc', 'GOOGLc', 'AMZNc', 'METAc'];

export function Borrow() {
  const { act } = useStore();
  const [symbol, setSymbol] = useState('NVDAc');
  const [tokens, setTokens] = useState('56.053812');
  const [usdc, setUsdc] = useState('5000');
  const [rate, setRate] = useState('8.00');
  const [term, setTerm] = useState('30');
  const [maxLtv, setMaxLtv] = useState('60');
  const [minFill, setMinFill] = useState('500');
  const [expiry, setExpiry] = useState('2');
  const [inKind, setInKind] = useState(false);
  const [yieldOn, setYieldOn] = useState(false);
  const [eligible, setEligible] = useState(false);
  const [message, setMessage] = useState('');
  const [formError, setFormError] = useState('');

  const asset = ASSETS[symbol];
  const principal = parseDollars(usdc);
  const tokenMicro = parseTokens(tokens);
  const rateBps = parsePercent(rate);
  const termDays = parseDays(term);
  const maxLtvBps = parsePercent(maxLtv);
  const minFillCents = parseDollars(minFill);
  const expiryDays = parseDays(expiry);

  let quote = null;
  let check = null;
  let inputError = '';
  if ([principal, tokenMicro, rateBps, termDays, maxLtvBps, minFillCents, expiryDays].some((value) => value == null)) {
    inputError = 'Use numbers. USDC has up to two decimals. The stock has up to six.';
  } else if (termDays < 7 || termDays > 90) {
    inputError = 'The term has to be 7 to 90 days.';
  } else if (rateBps > 4000) {
    inputError = 'The rate cannot be above 40% APR.';
  } else {
    quote = termSheet({ principalCents: principal, rateBps, termDays });
    check = assess({ asset, tokenMicro, principalCents: principal, maxLtvBps });
  }
  const gross = tokenMicro && asset ? valueCents(tokenMicro, asset.oracleCents) : 0;
  const originLtv = principal && gross ? formatApr(Math.floor((principal * 10000) / gross)) : '—';

  function submit(event) {
    event.preventDefault();
    setMessage('');
    if (inputError || !check?.ok) {
      setFormError(inputError || check?.error || 'Check the order.');
      return;
    }
    const next = act({
      type: 'place-borrow',
      asset: symbol,
      tokenMicro,
      usdcCents: principal,
      rateBps,
      termDays,
      maxLtvBps,
      minFillCents,
      expiryDays,
      inKind,
      yieldOn,
      eligible,
    });
    setFormError(next.error || '');
    setMessage(next.error ? '' : next.notice);
  }

  return (
    <Page
      kicker="Borrow"
      title="Ask for USDC."
      lede="You sign the order. The stock stays in your wallet until someone fills it. Posting is free of gas in this market."
    >
      <form className="form-layout" onSubmit={submit}>
        <div className="fields">
          <div className="field">
            <label htmlFor="asset">Stock</label>
            <select id="asset" value={symbol} onChange={(event) => setSymbol(event.target.value)}>
              {LAUNCH.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <p className="hint">{stateLabel(asset.state)}. {asset.status}. Tier {asset.tier}. Max initial LTV {formatApr(asset.maxInitLtvBps)}.</p>
          </div>
          <Field id="tokens" label="Stock to offer, raw units" hint="Escrow stores raw token units. The feed already includes the multiplier.">
            {(props) => <TextInput id="tokens" value={tokens} onChange={setTokens} {...props} />}
          </Field>
          <Field id="usdc" label="USDC to borrow" hint="Minimum $500. Guarded launch caps a loan at $10,000.">
            {(props) => <TextInput id="usdc" value={usdc} onChange={setUsdc} {...props} />}
          </Field>
          <Field id="rate" label="Maximum APR" hint="Fixed for the term. Simple interest, actual/365. Floor is 0%. Ceiling is 40%.">
            {(props) => <TextInput id="rate" value={rate} onChange={setRate} {...props} />}
          </Field>
          <Field id="term" label="Term, days" hint="7 to 90 days. Guarded launch is planned to start at 7 to 30.">
            {(props) => <TextInput id="term" value={term} onChange={setTerm} inputMode="numeric" {...props} />}
          </Field>
          <Field id="ltv" label="Maximum LTV" hint="The parties can choose any LTV up to the asset cap. The cap is a ceiling, not a target.">
            {(props) => <TextInput id="ltv" value={maxLtv} onChange={setMaxLtv} {...props} />}
          </Field>
          <Field id="fill" label="Minimum fill, USDC" hint="Each fill becomes its own loan and its own claim.">
            {(props) => <TextInput id="fill" value={minFill} onChange={setMinFill} {...props} />}
          </Field>
          <Field id="expiry" label="Expiry, days" hint="You can also cancel. Nothing is locked, so nothing has to be returned.">
            {(props) => <TextInput id="expiry" value={expiry} onChange={setExpiry} inputMode="numeric" {...props} />}
          </Field>
          <fieldset>
            <legend>Yield on the locked stock</legend>
            <label className="choice">
              <input type="radio" name="yield" checked={!yieldOn} onChange={() => setYieldOn(false)} />
              <span>Off. The stock stays in escrow and is not lent on.</span>
            </label>
            <label className="choice">
              <input type="radio" name="yield" checked={yieldOn} onChange={() => setYieldOn(true)} />
              <span>On. The lender earns what the venue pays on the locked stock, and bears any venue loss. This does not promise a rate. The other side has to turn it on too.</span>
            </label>
          </fieldset>
          <Choice id="inkind" checked={inKind} onChange={setInKind}>
            Allow in-kind settlement on default. Off unless the lender agrees too. The holder must be eligible to receive the stock.
          </Choice>
          <Choice id="eligible" checked={eligible} onChange={setEligible}>
            I am still eligible to hold this stock token.
          </Choice>
          <p className="hint">A venue may pay nothing on the stock today. Turning yield on does not promise a rate.</p>
          {formError ? <p className="err" role="alert">{formError}</p> : null}
          {message ? <p className="note" role="status">{message} <Link to="/markets">See the book.</Link></p> : null}
          <button className="btn" type="submit">Post borrow order</button>
        </div>
        <Sheet
          sticky
          title="Term sheet"
          note="Illustrative quote. The contract rounds amounts owed up and payouts down."
          items={quote ? [
            { label: 'Oracle value', value: formatUsd(gross) },
            { label: 'Value used for the cap', value: formatUsd(check?.effective || 0) },
            { label: 'LTV at origination', value: originLtv },
            { label: 'Interest at maturity', value: formatUsd(quote.interest) },
            { label: 'Origination', value: formatUsd(quote.fee) },
            { label: 'You receive', value: formatUsd(quote.proceeds) },
            { label: 'You repay', value: formatUsd(quote.repay) },
            { label: 'Your cost', value: `${formatHundredths(quote.borrowerApr)} APR` },
            { label: 'Lender receives', value: formatUsd(quote.holder) },
            { label: 'Lender yield', value: `${formatHundredths(quote.lenderApr)} APR` },
            check?.haircut ? { label: 'Closed-market haircut', value: formatApr(check.haircut) } : null,
          ] : []}
        >
          {inputError ? <p className="err">{inputError}</p> : null}
          {!inputError && check && !check.ok ? <p className="err">{check.error}</p> : null}
          {tokenMicro ? <p className="hint">Raw units on the order: {formatTokens(tokenMicro)} {symbol}.</p> : null}
        </Sheet>
      </form>
    </Page>
  );
}
