export type AlertType = 'FROZEN_SPLIT' | 'STALE_FEED' | 'FAILED_TX' | 'LOW_ETH_BALANCE';

export interface KeeperAlert {
  type: AlertType;
  message: string;
  details: Record<string, string | number | boolean | undefined>;
  timestamp: string;
}

export class AlertManager {
  public readonly history: KeeperAlert[] = [];
  private readonly webhookUrl?: string;
  private readonly chatId?: string;

  constructor(webhookUrl?: string, chatId?: string) {
    this.webhookUrl = webhookUrl;
    this.chatId = chatId;
  }

  async send(
    type: AlertType,
    message: string,
    details: Record<string, string | number | boolean | undefined> = {}
  ): Promise<KeeperAlert> {
    const alert: KeeperAlert = {
      type,
      message,
      details,
      timestamp: new Date().toISOString(),
    };
    this.history.push(alert);

    const logLine = `[ALERT][${alert.timestamp}][${type}] ${message} ${JSON.stringify(details)}`;
    if (type === 'FAILED_TX' || type === 'FROZEN_SPLIT') {
      console.error(logLine);
    } else {
      console.warn(logLine);
    }

    if (this.webhookUrl) {
      await this.dispatchWebhook(alert);
    }

    return alert;
  }

  private async dispatchWebhook(alert: KeeperAlert): Promise<void> {
    if (!this.webhookUrl) return;

    const formattedText = [
      `[NOSTOK KEEPER] ${alert.type}`,
      alert.message,
      Object.entries(alert.details)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n'),
      `time: ${alert.timestamp}`,
    ]
      .filter(Boolean)
      .join('\n');

    const payload: Record<string, unknown> = {
      text: formattedText,
      type: alert.type,
      message: alert.message,
      details: alert.details,
      timestamp: alert.timestamp,
    };
    if (this.chatId) {
      payload.chat_id = this.chatId;
    }

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        console.error(`[ALERT_WEBHOOK_ERROR] HTTP ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ALERT_WEBHOOK_ERROR] Failed to deliver webhook: ${msg}`);
    }
  }
}
