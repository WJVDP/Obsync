export interface TelemetryEvent {
  name: string;
  level: "debug" | "info" | "warn" | "error";
  payload?: Record<string, unknown>;
  occurredAt: string;
}

export class TelemetryClient {
  constructor(private readonly enabled: boolean) {}

  track(name: string, level: TelemetryEvent["level"], payload?: Record<string, unknown>): void {
    if (!this.enabled) {
      return;
    }

    const event: TelemetryEvent = {
      name,
      level,
      payload,
      occurredAt: new Date().toISOString()
    };

    if (level === "error") {
      console.error("[Obsync telemetry]", event);
      return;
    }

    console.log("[Obsync telemetry]", event);
  }
}
