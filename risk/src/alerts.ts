export type AlertSeverity = 'info' | 'warning' | 'critical' | 'page';

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
  page: 3,
};

export interface AlertObservation {
  dedupKey: string;
  category: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  details: Record<string, string | number | boolean | null>;
}

export interface RiskAlert {
  id: string;
  dedup_key: string;
  category: string;
  severity: AlertSeverity;
  status: 'active' | 'resolved';
  title: string;
  message: string;
  details: Record<string, string | number | boolean | null>;
  first_triggered_at: string;
  last_updated_at: string;
  last_notified_at: string;
  resolved_at: string | null;
  occurrences: number;
  notifications_sent: number;
}

export interface AlertTransitionEvent {
  action: 'trigger' | 'escalate' | 'downgrade' | 'repeat' | 'resolve';
  alert: RiskAlert;
}

export interface AlertEngineOptions {
  minActiveMs?: number;
  webhookTimeoutMs?: number;
  maxQueueSize?: number;
  maxWebhookAttempts?: number;
  retryBaseMs?: number;
  maxTransitions?: number;
  maxHistory?: number;
}

interface QueuedWebhookItem {
  payload: string;
  dedupKey: string;
}

export class AlertEngine {
  private readonly cooldownMs: number;
  private readonly minActiveMs: number;
  private readonly webhookUrl?: string;
  private readonly webhookTimeoutMs: number;
  private readonly maxQueueSize: number;
  private readonly maxWebhookAttempts: number;
  private readonly retryBaseMs: number;
  private readonly maxTransitions: number;
  private readonly maxHistory: number;
  private readonly activeByKey = new Map<string, RiskAlert>();
  private readonly history: RiskAlert[] = [];
  readonly transitions: AlertTransitionEvent[] = [];
  private readonly webhookQueue: QueuedWebhookItem[] = [];
  private workerRunning = false;
  private flushWaiters: Array<() => void> = [];
  private seq = 0;

  constructor(cooldownMs: number, webhookUrl?: string, opts: AlertEngineOptions = {}) {
    this.cooldownMs = cooldownMs;
    this.minActiveMs = opts.minActiveMs ?? 2_000;
    this.webhookUrl = webhookUrl;
    this.webhookTimeoutMs = opts.webhookTimeoutMs ?? 5_000;
    this.maxQueueSize = opts.maxQueueSize ?? 256;
    this.maxWebhookAttempts = opts.maxWebhookAttempts ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 150;
    this.maxTransitions = opts.maxTransitions ?? 500;
    this.maxHistory = opts.maxHistory ?? 500;
  }

  private pushTransition(event: AlertTransitionEvent): void {
    if (this.transitions.length >= this.maxTransitions) {
      this.transitions.shift();
    }
    this.transitions.push(event);
  }

  private enqueueWebhook(action: AlertTransitionEvent['action'], alert: RiskAlert): void {
    if (!this.webhookUrl) return;
    if (this.webhookQueue.length >= this.maxQueueSize) {
      this.webhookQueue.shift();
      console.warn('[RISK_WEBHOOK_QUEUE_FULL] Dropped oldest queued webhook event to preserve bound');
    }
    this.webhookQueue.push({
      dedupKey: alert.dedup_key,
      payload: JSON.stringify({
        action,
        timestamp: new Date().toISOString(),
        alert,
      }),
    });
    if (!this.workerRunning) {
      void this.processWebhookQueue();
    }
  }

  private async processWebhookQueue(): Promise<void> {
    if (this.workerRunning || !this.webhookUrl) return;
    this.workerRunning = true;
    try {
      while (this.webhookQueue.length > 0) {
        const item = this.webhookQueue.shift()!;
        for (let attempt = 1; attempt <= this.maxWebhookAttempts; attempt++) {
          try {
            const res = await fetch(this.webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: item.payload,
              signal: AbortSignal.timeout(this.webhookTimeoutMs),
            });
            if (!res.ok && res.status >= 500) {
              throw new Error(`HTTP ${res.status}`);
            }
            break;
          } catch (err) {
            if (attempt === this.maxWebhookAttempts) {
              console.warn(
                `[RISK_WEBHOOK_ERROR] Failed posting alert ${item.dedupKey} after ${attempt} attempts: ${err instanceof Error ? err.message : String(err)}`
              );
            } else {
              await new Promise((r) => setTimeout(r, this.retryBaseMs * 2 ** (attempt - 1)));
            }
          }
        }
      }
    } finally {
      this.workerRunning = false;
      const waiters = this.flushWaiters.splice(0, this.flushWaiters.length);
      for (const resolve of waiters) resolve();
    }
  }

  /**
   * Waits for any queued background webhook sends (up to timeoutMs). Used by shutdown/tests.
   */
  async flushWebhooks(timeoutMs = 5_000): Promise<void> {
    if (!this.workerRunning && this.webhookQueue.length === 0) return;
    await Promise.race([
      new Promise<void>((resolve) => this.flushWaiters.push(resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private dispatch(action: AlertTransitionEvent['action'], alert: RiskAlert): void {
    this.pushTransition({ action, alert: { ...alert, details: { ...alert.details } } });
    const tag = `[RISK_ALERT][${action.toUpperCase()}][${alert.severity.toUpperCase()}][${alert.category}]`;
    const logMsg = `${tag} (${alert.dedup_key}) ${alert.message} ${JSON.stringify(alert.details)}`;
    if (alert.severity === 'page' || alert.severity === 'critical') {
      console.error(logMsg);
    } else if (alert.severity === 'warning') {
      console.warn(logMsg);
    } else {
      console.log(logMsg);
    }

    // Non-blocking background queue so a hanging webhook never stalls the risk scan loop
    this.enqueueWebhook(action, { ...alert, details: { ...alert.details } });
  }

  /**
   * Synchronizes the current cycle's observed alert conditions against active alert state.
   * Handles deduplication, cooldown suppression, severity escalation/downgrade, flap damping, and auto-resolve.
   */
  async syncObservations(
    observations: AlertObservation[],
    nowMs = Date.now(),
    preserveKeysWhenDegraded?: Set<string>
  ): Promise<{ triggered: number; resolved: number; notified: number }> {
    const nowIso = new Date(nowMs).toISOString();
    const seenKeys = new Set<string>();
    let triggered = 0;
    let resolved = 0;
    let notified = 0;

    for (const obs of observations) {
      seenKeys.add(obs.dedupKey);
      const existing = this.activeByKey.get(obs.dedupKey);
      if (!existing) {
        const alert: RiskAlert = {
          id: `alt_${++this.seq}`,
          dedup_key: obs.dedupKey,
          category: obs.category,
          severity: obs.severity,
          status: 'active',
          title: obs.title,
          message: obs.message,
          details: { ...obs.details },
          first_triggered_at: nowIso,
          last_updated_at: nowIso,
          last_notified_at: nowIso,
          resolved_at: null,
          occurrences: 1,
          notifications_sent: 1,
        };
        this.activeByKey.set(obs.dedupKey, alert);
        this.history.unshift(alert);
        if (this.history.length > this.maxHistory) this.history.pop();
        triggered++;
        notified++;
        this.dispatch('trigger', alert);
      } else {
        existing.occurrences += 1;
        existing.last_updated_at = nowIso;
        existing.title = obs.title;
        existing.message = obs.message;
        existing.details = { ...obs.details };

        const newRank = SEVERITY_RANK[obs.severity];
        const prevRank = SEVERITY_RANK[existing.severity];
        existing.severity = obs.severity;
        const lastNotifMs = Date.parse(existing.last_notified_at);
        const cooldownElapsed = nowMs - lastNotifMs >= this.cooldownMs;

        if (newRank > prevRank) {
          existing.last_notified_at = nowIso;
          existing.notifications_sent += 1;
          notified++;
          this.dispatch('escalate', existing);
        } else if (newRank < prevRank) {
          existing.last_notified_at = nowIso;
          existing.notifications_sent += 1;
          notified++;
          this.dispatch('downgrade', existing);
        } else if (cooldownElapsed) {
          existing.last_notified_at = nowIso;
          existing.notifications_sent += 1;
          notified++;
          this.dispatch('repeat', existing);
        }
      }
    }

    // Resolve alerts whose conditions cleared in this scan (respecting minActiveMs flap damping)
    for (const [key, alert] of Array.from(this.activeByKey.entries())) {
      if (seenKeys.has(key)) continue;
      if (preserveKeysWhenDegraded && preserveKeysWhenDegraded.has(key)) continue;
      if (nowMs - Date.parse(alert.first_triggered_at) < this.minActiveMs) continue;

      alert.status = 'resolved';
      alert.resolved_at = nowIso;
      alert.last_updated_at = nowIso;
      this.activeByKey.delete(key);
      resolved++;
      this.dispatch('resolve', alert);
    }

    return { triggered, resolved, notified };
  }

  getActiveAlerts(): RiskAlert[] {
    return Array.from(this.activeByKey.values()).sort(
      (a, b) => Date.parse(b.last_updated_at) - Date.parse(a.last_updated_at) || a.id.localeCompare(b.id)
    );
  }

  getAllAlerts(): RiskAlert[] {
    return [...this.history].sort(
      (a, b) => Date.parse(b.last_updated_at) - Date.parse(a.last_updated_at) || a.id.localeCompare(b.id)
    );
  }

  getActiveCountBySeverity(): Record<AlertSeverity, number> {
    const counts: Record<AlertSeverity, number> = {
      info: 0,
      warning: 0,
      critical: 0,
      page: 0,
    };
    for (const a of this.activeByKey.values()) {
      counts[a.severity] += 1;
    }
    return counts;
  }
}
