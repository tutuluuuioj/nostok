import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { signWebhookPayload } from './crypto.js';

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
  timestampSec?: number;
}

export interface ChannelTransports {
  sendEmail(msg: NotificationOutboundMessage): Promise<void>;
  sendTelegram(msg: NotificationOutboundMessage): Promise<void>;
  sendWebhook(msg: NotificationOutboundMessage): Promise<void>;
}

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface WebhookHttpRequestOpts {
  url: URL;
  pinnedIp: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  redirect: 'manual';
}

export type WebhookHttpRequester = (
  opts: WebhookHttpRequestOpts
) => Promise<{ status: number }>;

export const defaultDnsLookup: DnsLookupFn = async (hostname: string) => {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
};

export function isBlockedIpv4(ip: string): boolean {
  if (net.isIP(ip) !== 4) return true;
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol / TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true; // benchmarking / TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast & reserved (224.0.0.0/4 + 240.0.0.0/4)
  return false;
}

function assertCleanWebhookRawHost(rawTarget: string): void {
  if (!/^https:\/\//i.test(rawTarget)) {
    throw new Error('Webhook URL must use https://');
  }
  const authMatch = rawTarget.match(/^https:\/\/([^/?#]+)/i);
  if (!authMatch) {
    throw new Error('Invalid webhook URL host');
  }
  const authority = authMatch[1];
  if (authority.includes('@')) {
    throw new Error('Webhook URL must not include userinfo credentials');
  }
  if (authority.includes('[') || authority.includes(']')) {
    throw new Error('Webhook IPv6 addresses are not permitted');
  }
  const hostNoPort = authority.replace(/:\d+$/, '');
  if (hostNoPort.includes(':')) {
    throw new Error('Webhook IPv6 addresses are not permitted');
  }
  const lower = hostNoPort.toLowerCase().replace(/\.+$/, '');
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.arpa')
  ) {
    throw new Error('Webhook localhost or internal hostnames are not permitted');
  }

  // Reject decimal integer IPs (e.g. 2130706433), hex (0x7f000001 / 0x7f.0.0.1), octal (0177.0.0.1),
  // and shorthand numeric IPv4 (e.g. 127.1) before URL normalization converts them silently.
  const labels = lower.split('.');
  if (labels.some((lbl) => lbl.startsWith('0x'))) {
    throw new Error('Webhook hexadecimal IP addresses are not permitted');
  }
  const allNumericish = labels.every((lbl) => /^(?:\d+|0x[0-9a-f]+)$/i.test(lbl));
  if (allNumericish) {
    if (labels.length !== 4 || labels.some((lbl) => /^0\d+/.test(lbl))) {
      throw new Error('Webhook octal, decimal, or shorthand IP forms are not permitted');
    }
  }
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

  assertCleanWebhookRawHost(target);

  let u: URL;
  try {
    u = new URL(target);
  } catch {
    throw new Error('Invalid webhook URL');
  }
  if (u.protocol !== 'https:') {
    throw new Error('Webhook URL must use https://');
  }
  if (u.username || u.password) {
    throw new Error('Webhook URL must not contain credentials');
  }
  const host = u.hostname.toLowerCase();
  if (host.includes(':') || net.isIP(host) === 6) {
    throw new Error('Webhook IPv6 addresses are not permitted');
  }
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.arpa')
  ) {
    throw new Error('Webhook localhost or internal hostnames are not permitted');
  }
  if (net.isIP(host) === 4 && isBlockedIpv4(host)) {
    throw new Error('Webhook IP address is blocked (private, loopback, link-local, or metadata)');
  }
  return u.toString();
}

export async function resolveAndValidateWebhookTarget(
  rawTarget: string,
  dnsLookup: DnsLookupFn = defaultDnsLookup
): Promise<{ url: URL; pinnedIp: string }> {
  const normalized = validateChannelTarget('webhook', rawTarget);
  const url = new URL(normalized);
  if (net.isIP(url.hostname) === 4) {
    if (isBlockedIpv4(url.hostname)) {
      throw new Error('Webhook IP address is blocked');
    }
    return { url, pinnedIp: url.hostname };
  }

  const records = await dnsLookup(url.hostname);
  if (!records || records.length === 0) {
    throw new Error('Webhook DNS lookup returned no addresses');
  }
  for (const rec of records) {
    if (rec.family !== 4 || net.isIP(rec.address) !== 4) {
      throw new Error('Webhook DNS resolved to blocked IPv6/non-IPv4 address');
    }
    if (isBlockedIpv4(rec.address)) {
      throw new Error('Webhook DNS resolved to blocked private, loopback, link-local, or metadata IPv4 address');
    }
  }
  return { url, pinnedIp: records[0].address };
}

async function defaultWebhookRequester(opts: WebhookHttpRequestOpts): Promise<{ status: number }> {
  return new Promise<{ status: number }>((resolve, reject) => {
    const req = https.request(
      {
        protocol: 'https:',
        hostname: opts.url.hostname,
        port: opts.url.port ? Number(opts.url.port) : 443,
        path: `${opts.url.pathname}${opts.url.search}`,
        method: 'POST',
        servername: opts.url.hostname,
        lookup: (_hostname, lookupOpts, cb) => {
          if (lookupOpts && (lookupOpts as { all?: boolean }).all) {
            cb(null, [{ address: opts.pinnedIp, family: 4 }]);
          } else {
            cb(null, opts.pinnedIp, 4);
          }
        },
        headers: {
          ...opts.headers,
          'Content-Length': Buffer.byteLength(opts.body, 'utf8'),
        },
        timeout: opts.timeoutMs,
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0 });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Webhook request timed out'));
    });
    req.on('error', reject);
    req.write(opts.body, 'utf8');
    req.end();
  });
}

export function createDefaultTransports(cfg: {
  smtpApiUrl?: string;
  smtpApiKey?: string;
  emailFrom: string;
  telegramBotToken?: string;
  telegramApiBase: string;
  outboundTimeoutMs: number;
  webhookSigningSecret: string;
  dnsLookup?: DnsLookupFn;
  webhookRequester?: WebhookHttpRequester;
}): ChannelTransports {
  const dnsLookup = cfg.dnsLookup ?? defaultDnsLookup;
  const requester = cfg.webhookRequester ?? defaultWebhookRequester;

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
        redirect: 'manual',
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
      if (res.status >= 300 && res.status < 400) {
        throw new Error('Email transport redirect blocked');
      }
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
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: msg.target,
          text: `*NOSTOK Alert (${msg.severity.toUpperCase()})*\n${msg.title}\n${msg.message}\n\nUnsubscribe: ${msg.unsubscribeUrl}`,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(cfg.outboundTimeoutMs),
      });
      if (res.status >= 300 && res.status < 400) {
        throw new Error('Telegram transport redirect blocked');
      }
      if (!res.ok) {
        throw new Error(`Telegram transport HTTP ${res.status}`);
      }
    },

    async sendWebhook(msg) {
      const { url, pinnedIp } = await resolveAndValidateWebhookTarget(msg.target, dnsLookup);
      const rawBody = JSON.stringify({
        event: msg.alertType,
        severity: msg.severity,
        wallet: msg.wallet,
        title: msg.title,
        message: msg.message,
        payload: msg.payload,
        unsubscribe_url: msg.unsubscribeUrl,
      });
      const tsSec = msg.timestampSec ?? Math.floor(Date.now() / 1000);
      const sig = signWebhookPayload(cfg.webhookSigningSecret, tsSec, rawBody);

      const res = await requester({
        url,
        pinnedIp,
        headers: {
          'Content-Type': 'application/json',
          Host: url.host,
          'X-Nostok-Timestamp': sig.timestampHeader,
          'X-Nostok-Signature': sig.signatureHeader,
        },
        body: rawBody,
        timeoutMs: cfg.outboundTimeoutMs,
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400) {
        throw new Error('Webhook redirect blocked');
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Webhook transport HTTP ${res.status}`);
      }
    },
  };
}
