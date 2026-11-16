import { Link } from 'react-router-dom';
import { Page, PreviewBanner } from '../components/ui.jsx';
import { useStore } from '../store.jsx';

export function Alerts() {
  const { alerts } = useStore();
  return (
    <Page
      kicker="Alerts · Preview"
      title="Notification examples (preview)."
      lede="Margin calls, grace, corporate-action freezes, and auctions are dispatched via Email, Telegram, and Webhooks by notifications/."
    >
      <PreviewBanner>
        The alert examples below come from the static preview book, not your live positions. Sign in with SIWE on{' '}
        <Link to="/wallet">Wallet</Link> to manage live alert subscriptions.
      </PreviewBanner>
      {alerts.length === 0 ? <p className="lede">No sample alerts.</p> : alerts.map((item) => (
        <article className="order-row" key={item.id}>
          <div>
            <strong>{item.title}</strong>
            <span className="quiet">{item.body}</span>
            <Link className="open-loan" to={item.href}>Inspect sample loan</Link>
          </div>
          <span className="quiet">Preview only</span>
        </article>
      ))}
    </Page>
  );
}
