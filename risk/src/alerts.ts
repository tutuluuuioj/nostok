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
  action: 'trigger' | 'escalate' | 'repeat' | 'resolve';
  alert: RiskAlert;
}

export class AlertEngine {
  private readonly cooldownMs: number;
  private readonly webhookUrl?: string;
  private readonly activeByKey = new Map<string, RiskAlert>();
  private readonly history: RiskAlert[] = [];
  readonly transitions: AlertTransitionEvent[] = [];
  private seq = 0;

  constructor(cooldownMs: number, webhookUrl?: string) {
    this.cooldownMs = cooldownMs;
    this.webhookUrl = webhookUrl;
  }

  private async dispatch(action: AlertTransitionEvent['action'], alert: RiskAlert): Promise<void> {
    this.transitions.push({ action, alert: { ...alert, details: { ...alert.details } } });
    const tag = `[RISK_ALERT][${action.toUpperCase()}][${alert.severity.toUpperCase()}][${alert.category}]`;
    const logMsg = `${tag} (${alert.dedup_key}) ${alert.message} ${JSON.stringify(alert.details)}`;
    if (alert.severity === 'page' || alert.severity === 'critical') {
      console.error(logMsg);
    } else if (alert.severity === 'warning') {
      console.warn(logMsg);
    } else {
      console.log(logMsg);
    }

    if (this.webhookUrl) {
      try {
        await fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            timestamp: new Date().toISOString(),
            alert,
          }),
        });
      } catch (err) {
        console.warn(
          `[RISK_WEBHOOK_ERROR] Failed posting alert ${alert.dedup_key}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  /**
   * Synchronizes the current cycle's observed alert conditions against active alert state.
   * Handles deduplication, cooldown suppression, severity escalation, and auto-resolve (clear).
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
        if (this.history.length > 2000) this.history.pop();
        triggered++;
        notified++;
        await this.dispatch('trigger', alert);
      } else {
        existing.occurrences += 1;
        existing.last_updated_at = nowIso;
        existing.title = obs.title;
        existing.message = obs.message;
        existing.details = { ...obs.details };

        const escalated = SEVERITY_RANK[obs.severity] > SEVERITY_RANK[existing.severity];
        existing.severity = obs.severity;
        const lastNotifMs = Date.parse(existing.last_notified_at);
        const cooldownElapsed = nowMs - lastNotifMs >= this.cooldownMs;

        if (escalated) {
          existing.last_notified_at = nowIso;
          existing.notifications_sent += 1;
          notified++;
          await this.dispatch('escalate', existing);
        } else if (cooldownElapsed) {
          existing.last_notified_at = nowIso;
          existing.notifications_sent += 1;
          notified++;
          await this.dispatch('repeat', existing);
        }
      }
    }

    // Resolve alerts whose conditions cleared in this scan
    for (const [key, alert] of Array.from(this.activeByKey.entries())) {
      if (seenKeys.has(key)) continue;
      if (preserveKeysWhenDegraded && preserveKeysWhenDegraded.has(key)) continue;

      alert.status = 'resolved';
      alert.resolved_at = nowIso;
      alert.last_updated_at = nowIso;
      this.activeByKey.delete(key);
      resolved++;
      await this.dispatch('resolve', alert);
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
