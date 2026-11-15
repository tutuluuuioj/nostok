export function Page({ kicker, title, lede, children }) {
  return (
    <article className="page">
      <header className="page-head">
        {kicker ? <p className="kicker">{kicker}</p> : null}
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </header>
      {children}
    </article>
  );
}

export function Rows({ items }) {
  return (
    <dl className="rows">
      {items.filter(Boolean).map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Sheet({ title, items, note, children, sticky = false }) {
  return (
    <section className={sticky ? 'sheet sticky' : 'sheet'}>
      {title ? <h2>{title}</h2> : null}
      {items ? <Rows items={items} /> : null}
      {note ? <p className="hint">{note}</p> : null}
      {children}
    </section>
  );
}

export function Field({ id, label, hint, error, children }) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ describedBy, invalid: Boolean(error) })}
      {hint ? <p id={hintId} className="hint">{hint}</p> : null}
      {error ? <p id={errId} className="err">{error}</p> : null}
    </div>
  );
}

export function Choice({ id, checked, onChange, children }) {
  return (
    <label className="choice" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

export function TextInput({ id, value, onChange, describedBy, invalid, inputMode = 'decimal' }) {
  return (
    <input
      id={id}
      type="text"
      inputMode={inputMode}
      autoComplete="off"
      spellCheck="false"
      value={value}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
