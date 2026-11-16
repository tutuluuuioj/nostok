import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Field, Page, PreviewBanner, Sheet, TextInput } from '../components/ui.jsx';
import { ASSETS } from '../lib/data.js';
import { formatApr, formatHundredths, formatUsd, parseDays, parseDollars, parsePercent } from '../lib/format.js';
import { termSheet } from '../lib/money.js';

const CHOICES = ['NVDAc', 'AAPLc', 'MSFTc', 'GOOGLc', 'AMZNc', 'METAc'];

export function Lend() {
  const [usdc, setUsdc] = useState('5000');
  const [rate, setRate] = useState('8.00');
  const [term, setTerm] = useState('30');
  const [maxLtv, setMaxLtv] = useState('50');
  const [minFill, setMinFill] = useState('500');
  const [expiry, setExpiry] = useState('2');
  const [picked, setPicked] = useState(['NVDAc', 'MSFTc']);
  const [yieldOn, setYieldOn] = useState(false);

  const principal = parseDollars(usdc);
  const rateBps = parsePercent(rate);
  const termDays = parseDays(term);
  const maxLtvBps = parsePercent(maxLtv);
  const minFillCents = parseDollars(minFill);
  const expiryDays = parseDays(expiry);
  let quote = null;
  let inputError = '';
  if ([principal, rateBps, termDays, maxLtvBps, minFillCents, expiryDays].some((value) => value == null)) {
    inputError = 'Use numbers. USDC and the rate have up to two decimals.';
  } else if (termDays < 7 || termDays > 90) {
    inputError = 'The term has to be 7 to 90 days.';
  } else if (rateBps > 4000) {
    inputError = 'The rate cannot be above 40% APR.';
  } else {
    quote = termSheet({ principalCents: principal, rateBps, termDays });
  }

  function toggle(symbol) {
    setPicked((current) => (
      current.includes(symbol) ? current.filter((item) => item !== symbol) : [...current, symbol]
    ));
  }

  return (
    <Page
      kicker="Lend · Preview"
      title="Offer USDC (coming soon)."
      lede="You name the stocks, the minimum rate, and the longest term you will take. Live lend offer signing and order filling arrive in WS3.4."
    >
      <PreviewBanner>
        Preview data, not your positions — live EIP-712 lend offer signing and OrderSettlement fills arrive in WS3.4. For live on-chain quotes today, use{' '}
        <Link to="/markets">Markets</Link> or sign a live borrow order on <Link to="/borrow">Borrow</Link>.
      </PreviewBanner>
      <form className="form-layout" onSubmit={(event) => event.preventDefault()}>
        <div className="fields">
          <Field id="usdc" label="USDC to offer (illustrative)" hint="Each fill is capped at $10,000. The offer itself can be larger, up to $100,000 in this preview.">
            {(props) => <TextInput id="usdc" value={usdc} onChange={setUsdc} {...props} />}
          </Field>
          <Field id="rate" label="Minimum APR (illustrative)" hint="The borrower pays this fixed rate. You receive it minus the protocol cut of interest.">
            {(props) => <TextInput id="rate" value={rate} onChange={setRate} {...props} />}
          </Field>
          <Field id="term" label="Term, days (illustrative)" hint="7 to 90 days.">
            {(props) => <TextInput id="term" value={term} onChange={setTerm} inputMode="numeric" {...props} />}
          </Field>
          <Field id="ltv" label="Maximum LTV (illustrative)" hint="Applied to the stock named at fill. Tier A caps initial LTV at 60%.">
            {(props) => <TextInput id="ltv" value={maxLtv} onChange={setMaxLtv} {...props} />}
          </Field>
          <Field id="fill" label="Minimum fill, USDC (illustrative)">
            {(props) => <TextInput id="fill" value={minFill} onChange={setMinFill} {...props} />}
          </Field>
          <Field id="expiry" label="Expiry, days (illustrative)">
            {(props) => <TextInput id="expiry" value={expiry} onChange={setExpiry} inputMode="numeric" {...props} />}
          </Field>
          <fieldset>
            <legend>Stocks (preview roster)</legend>
            {CHOICES.map((symbol) => {
              const asset = ASSETS[symbol];
              const blocked = asset.status !== 'Active';
              return (
                <label className="choice" key={symbol}>
                  <input
                    type="checkbox"
                    checked={picked.includes(symbol)}
                    disabled={blocked}
                    onChange={() => toggle(symbol)}
                  />
                  <span>{symbol}{blocked ? ` · ${asset.status}` : ''}</span>
                </label>
              );
            })}
            <p className="hint">Live asset statuses and caps are shown on Markets and Risk.</p>
          </fieldset>
          <fieldset>
            <legend>Yield on the locked stock</legend>
            <label className="choice">
              <input type="radio" name="yield" checked={!yieldOn} onChange={() => setYieldOn(false)} />
              <span>Off. You are paid the agreed interest only.</span>
            </label>
            <label className="choice">
              <input type="radio" name="yield" checked={yieldOn} onChange={() => setYieldOn(true)} />
              <span>On. Deferred until yield integration is enabled.</span>
            </label>
          </fieldset>
          <p className="hint">Lend offer posting is disabled until WS3.4 live OrderSettlement integration.</p>
        </div>
        <Sheet
          sticky
          title="Illustrative preview economics"
          note="Static formula illustration only. Query /quote on Markets for live on-chain numbers."
          items={quote ? [
            { label: 'Rate', value: `${formatApr(rateBps)} APR` },
            { label: 'Term', value: `${termDays} days` },
            { label: 'Interest at maturity', value: formatUsd(quote.interest) },
            { label: 'Protocol cut of interest', value: formatUsd(quote.cut) },
            { label: 'Lender receives', value: formatUsd(quote.holder) },
            { label: 'Lender yield', value: `${formatHundredths(quote.lenderApr)} APR` },
            { label: 'Borrower origination', value: formatUsd(quote.fee) },
          ] : []}
        >
          {inputError ? <p className="err">{inputError}</p> : null}
        </Sheet>
      </form>
    </Page>
  );
}
