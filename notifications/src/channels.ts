export type NotificationChannel = 'email' | 'telegram' | 'webhook';

export interface NotificationOutboundMessage {
  wallet: string;
  subscriptionId: string;
  channel: NotificationChannel;
  target: string; // decrypted plaintext target (email, telegram chat id, webhook url) - NEVER LOGGED
  alertType: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  payload: Record<string, unknown>;
  unsubscribeUrl: string;
}

export interface ChannelTransports {
  sendEmail(msg: NotificationOutboundMessage): Promise<void>;
  sendTelegram(msg: NotificationOutboundMessage): Promise<void>;
  sendWebhook(msg: NotificationOutboundMessage): Promise<void>;
}

export function validateChannelTarget(channel: NotificationChannel, rawTarget: string): string {
  const target = rawTarget.trim();
  if (channel === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target) || target.length > 254) {
      throw new Error('Invalid email address');
    }
    return target.toLowerCase();
  }
  if (channel === 'telegram') {
    if (!/^-?\d{3,20}$/.test(target)) {
      throw new Error('Telegram target must be a numeric chat ID');
    }
    return target;
  }
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    throw new Error('Invalid webhook URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Webhook URL must use http:// or https://');
  }
  return u.toString();
}

export function createDefaultTransports(cfg: {
  smtpApiUrl?: string;
  smtpApiKey?: string;
  emailFrom: string;
  telegramBotToken?: string;
  telegramApiBase: string;
  outboundTimeoutMs: number;
}): ChannelTransports {
  return {
    async sendEmail(msg) {
      if (!cfg.smtpApiUrl) {
        throw new Error('SMTP_API_URL not configured for email channel');
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (cfg.smtpApiKey) {
        headers.Authorization = `Bearer ${cfg.smtpApiKey}`;
      }
      const res = await fetch(cfg.smtpApiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          from: cfg.emailFrom,
          to: msg.target,
          subject: `[NOSTOK] ${msg.title}`,
          text: `${msg.message}\n\nUnsubscribe: ${msg.unsubscribeUrl}`,
          headers: { 'List-Unsubscribe': `<${msg.unsubscribeUrl}>` },
        }),
        signal: AbortSignal.timeout(cfg.outboundTimeoutMs),
      });
      if (!res.ok) {
        throw new Error(`Email transport HTTP ${res.status}`);
      }
    },

    async sendTelegram(msg) {
      if (!cfg.telegramBotToken) {
        throw new Error('TELEGRAM_BOT_TOKEN not configured for telegram channel');
      }
      const url = `${cfg.telegramApiBase}/bot${cfg.telegramBotToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: msg.target,
          text: `*NOSTOK Alert (${msg.severity.toUpperCase()})*\n${msg.title}\n${msg.message}\n\nUnsubscribe: ${msg.unsubscribeUrl}`,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(cfg.outboundTimeoutMs),
      });
      if (!res.ok) {
        throw new Error(`Telegram transport HTTP ${res.status}`);
      }
    },

    async sendWebhook(msg) {
      const targetUrl = validateChannelTarget('webhook', msg.target);
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: msg.alertType,
          severity: msg.severity,
          wallet: msg.wallet,
          title: msg.title,
          message: msg.message,
          payload: msg.payload,
          unsubscribe_url: msg.unsubscribeUrl,
        }),
        signal: AbortSignal.timeout(cfg.outboundTimeoutMs),
      });
      if (!res.ok) {
        throw new Error(`Webhook transport HTTP ${res.status}`);
      }
    },
  };
}
