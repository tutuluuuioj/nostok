import { useState } from 'react';
import { useStore } from '../store.jsx';

const CHECKS = [
  ['person', 'I am an eligible non-US person, and I am not in a sanctioned jurisdiction.'],
  ['escrow', 'I understand the stock sits in escrow, and the lender receives a Position NFT, not the stock.'],
  ['surplus', 'I understand a default sells only enough collateral, and any surplus comes back to the borrower.'],
  ['oracle', 'I understand liquidation does not run when the market is closed, the oracle is stale, or the asset is frozen.'],
  ['preview', 'I understand this preview sends no transaction and moves no funds.'],
];

export function Gate() {
  const { act } = useStore();
  const [region, setRegion] = useState('');
  const [checks, setChecks] = useState({});
  const eligible = region === 'eligible';
  const ready = eligible && CHECKS.every(([id]) => checks[id]);

  function submit(event) {
    event.preventDefault();
    if (region === 'restricted') {
      act({ type: 'restrict' });
      return;
    }
    if (ready) act({ type: 'accept' });
  }

  return (
    <main className="wrap gate" id="main">
      <p className="mark">NOSTOK</p>
      <p className="kicker">Eligibility</p>
      <h1>Eligible persons outside the United States.</h1>
      <p className="lede">
        Tokenized stocks on Base are offered only to eligible non-US persons. This interface asks you to confirm that before you see a loan.
      </p>
      <form onSubmit={submit}>
        <fieldset>
          <legend>Where do you sit?</legend>
          <label className="choice">
            <input type="radio" name="region" checked={region === 'eligible'} onChange={() => setRegion('eligible')} />
            <span>Outside the United States, and not in a sanctioned jurisdiction.</span>
          </label>
          <label className="choice">
            <input type="radio" name="region" checked={region === 'restricted'} onChange={() => setRegion('restricted')} />
            <span>In the United States, or in a restricted jurisdiction.</span>
          </label>
        </fieldset>
        {eligible ? (
          <fieldset>
            <legend>Before you continue</legend>
            {CHECKS.map(([id, label]) => (
              <label className="choice" key={id}>
                <input
                  type="checkbox"
                  checked={Boolean(checks[id])}
                  onChange={(event) => setChecks({ ...checks, [id]: event.target.checked })}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {region === 'restricted' ? (
          <p className="lede">US persons and sanctioned jurisdictions cannot use this interface.</p>
        ) : null}
        <div className="actions">
          <button className="btn" type="submit" disabled={!region || (eligible && !ready)}>
            {region === 'restricted' ? 'Continue' : 'Enter NOSTOK'}
          </button>
        </div>
      </form>
    </main>
  );
}

export function Restricted() {
  const { act } = useStore();
  return (
    <main className="wrap gate" id="main">
      <p className="mark">NOSTOK</p>
      <p className="kicker">Unavailable</p>
      <h1>This interface is not available here.</h1>
      <p className="lede">
        NOSTOK does not offer stock-backed loans to US persons or to sanctioned jurisdictions. The contracts are not shown from this region.
      </p>
      <p className="lede">
        In production this page is the end of the road. This preview lets you return so the block can be checked.
      </p>
      <div className="actions">
        <button className="btn secondary" type="button" onClick={() => act({ type: 'reset-gate' })}>
          Return to eligibility
        </button>
      </div>
    </main>
  );
}
