import { Link } from 'react-router-dom';
import { Page } from '../components/ui.jsx';
import { useStore } from '../store.jsx';

export function Alerts() {
  const { alerts, act } = useStore();
  return (
    <Page
      kicker="Alerts"
      title="What needs you."
      lede="Margin calls, grace, a freeze, and an auction. Delivery in production is email, Telegram, push, or an agent. Here they sit on the desk."
    >
      {alerts.length === 0 ? <p className="lede">Nothing open.</p> : alerts.map((item) => (
        <article className="order-row" key={item.id}>
          <div>
            <strong>{item.title}</strong>
            <span className="quiet">{item.body}</span>
            <Link className="open-loan" to={item.href}>Open the loan</Link>
          </div>
          <button className="btn secondary" type="button" onClick={() => act({ type: 'dismiss', id: item.id })}>Dismiss</button>
        </article>
      ))}
    </Page>
  );
}
