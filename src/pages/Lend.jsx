import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Choice, Field, Page, Sheet, TextInput } from '../components/ui.jsx';
import { ASSETS } from '../lib/data.js';
import { formatApr, formatHundredths, formatUsd, parseDays, parseDollars, parsePercent } from '../lib/format.js';
import { termSheet } from '../lib/money.js';
import { useStore } from '../store.jsx';

const CHOICES = ['NVDAc', 'AAPLc', 'MSFTc', 'GOOGLc', 'AMZNc', 'METAc'];

export function Lend() {
  const { act } = useStore();
  const [usdc, setUsdc] = useState('5000');
  const [rate, setRate] = useState('8.00');
  const [term, setTerm] = useState('30');
  const [maxLtv, setMaxLtv] = useState('50');
  const [minFill, setMinFill] = useState('500');
  const [expiry, setExpiry] = useState('2');
  const [picked, setPicked] = useState(['NVDAc', 'MSFTc']);
  const [inKind, setInKind] = useState(false);
  const [yieldOn, setYieldOn] = useState(false);
  const [eligible, setEligible] = useState(false);
  const [message, setMessage] = useState('');
  const [formError, setFormError] = useState('');

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

  function submit(event) {
    event.preventDefault();
    setMessage('');
    if (inputError) {
      setFormError(inputError);
      return;
    }
    const next = act({
      type: 'place-lend',
      assets: picked,
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
      kicker="Lend"
      title="Offer USDC."
      lede="You name the stocks, the minimum rate, and the longest term you will take. Your USDC stays with you until a borrower fills the offer."
    >
      <form className="form-layout" onSubmit={submit}>
        <div className="fields">
          <Field id="usdc" label="USDC to offer" hint="Each fill is capped at $10,000. The offer itself can be larger, up to $100,000 in this preview.">
            {(props) => <TextInput id="usdc" value={usdc} onChange={setUsdc} {...props} />}
          </Field>
          <Field id="rate" label="Minimum APR" hint="The borrower pays this fixed rate. You receive it minus a 10% cut of the interest.">
            {(props) => <TextInput id="rate" value={rate} onChange={setRate} {...props} />}
          </Field>
          <Field id="term" label="Term, days" hint="7 to 90 days.">
            {(props) => <TextInput id="term" value={term} onChange={setTerm} inputMode="numeric" {...props} />}
          </Field>
          <Field id="ltv" label="Maximum LTV" hint="Applied to the stock named at fill. Tier A caps initial LTV at 60%.">
            {(props) => <TextInput id="ltv" value={maxLtv} onChange={setMaxLtv} {...props} />}
          </Field>
          <Field id="fill" label="Minimum fill, USDC">
            {(props) => <TextInput id="fill" value={minFill} onChange={setMinFill} {...props} />}
          </Field>
          <Field id="expiry" label="Expiry, days">
            {(props) => <TextInput id="expiry" value={expiry} onChange={setExpiry} inputMode="numeric" {...props} />}
          </Field>
          <fieldset>
            <legend>Stocks you will lend against</legend>
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
            <p className="hint">Tier B names are not at launch. METAc is frozen, so a new loan against it will not open.</p>
          </fieldset>
          <fieldset>
            <legend>Yield on the locked stock</legend>
            <label className="choice">
              <input type="radio" name="yield" checked={!yieldOn} onChange={() => setYieldOn(false)} />
              <span>Off. You are paid the agreed interest only.</span>
            </label>
            <label className="choice">
              <input type="radio" name="yield" checked={yieldOn} onChange={() => setYieldOn(true)} />
              <span>On. You earn what the venue pays on the locked stock, and you bear any venue loss. The borrower has to turn it on too.</span>
            </label>
          </fieldset>
          <Choice id="inkind" checked={inKind} onChange={setInKind}>
            Allow in-kind settlement if the borrower allows it too.
          </Choice>
          <Choice id="eligible" checked={eligible} onChange={setEligible}>
            I am eligible to lend and to hold a Position NFT.
          </Choice>
          <p className="hint">Venue yield can be about nothing. The switch does not promise a rate.</p>
          {formError ? <p className="err" role="alert">{formError}</p> : null}
          {message ? <p className="note" role="status">{message} <Link to="/markets">See the book.</Link></p> : null}
          <button className="btn" type="submit">Post lend offer</button>
        </div>
        <Sheet
          sticky
          title="If this is filled in full"
          note="The borrower pays the origination. You pay none of it. You pay 10% of the interest when the loan repays."
          items={quote ? [
            { label: 'Rate', value: `${formatApr(rateBps)} APR` },
            { label: 'Term', value: `${termDays} days` },
            { label: 'Interest at maturity', value: formatUsd(quote.interest) },
            { label: 'Protocol cut of interest', value: formatUsd(quote.cut) },
            { label: 'You receive', value: formatUsd(quote.holder) },
            { label: 'Your yield', value: `${formatHundredths(quote.lenderApr)} APR` },
            { label: 'Borrower origination', value: formatUsd(quote.fee) },
          ] : []}
        >
          {inputError ? <p className="err">{inputError}</p> : null}
        </Sheet>
      </form>
    </Page>
  );
}
