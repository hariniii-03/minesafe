/**
 * Development-only SIMULATED sensor feed.
 *
 * Every row written by this module is stored with `source = 'simulated'` and
 * the UI renders a "SIMULATED DATA" badge. Set the simulator OFF (Settings >
 * Data source) before connecting real ESP32-S3 hardware.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { helmets, sensorReadings, systemState, workers } from "@/db/schema";
import { ingestReading } from "@/lib/safety/engine";
import { getSettings } from "@/lib/settings";
import { magnitudeG } from "@/lib/safety/types";

/** Helmets intentionally kept offline so the offline alert path is testable. */
export const SIMULATED_OFFLINE_HELMETS = ["HELMET-004"];

export async function isSimulatorEnabled(): Promise<boolean> {
  const rows = await db.select().from(systemState).where(eq(systemState.key, "simulator"));
  return rows[0]?.value?.enabled === true;
}

export async function setSimulatorEnabled(enabled: boolean): Promise<void> {
  await db
    .insert(systemState)
    .values({ key: "simulator", value: { enabled, lastTickAt: new Date().toISOString() } })
    .onConflictDoUpdate({
      target: systemState.key,
      set: { value: { enabled, lastTickAt: new Date().toISOString() }, updatedAt: new Date() },
    });
}

type Profile = {
  gasBase: number;
  tempBase: number;
  humidityBase: number;
  batteryBase: number;
};

function profileFor(code: string, index: number): Profile {
  const presets: Record<string, Profile> = {
    "HELMET-001": { gasBase: 660, tempBase: 31.5, humidityBase: 63, batteryBase: 84 },
    "HELMET-002": { gasBase: 780, tempBase: 33.4, humidityBase: 70, batteryBase: 46 },
    "HELMET-003": { gasBase: 590, tempBase: 30.1, humidityBase: 58, batteryBase: 91 },
    "HELMET-004": { gasBase: 700, tempBase: 32.0, humidityBase: 66, batteryBase: 21 },
  };
  return presets[code] ?? { gasBase: 620, tempBase: 31, humidityBase: 60, batteryBase: 80 - index * 5 };
}

function noise(spread: number): number {
  return (Math.random() - 0.5) * 2 * spread;
}

async function tickHelmet(
  helmet: { id: number; code: string; batteryPercent: number | null; sensors: Record<string, boolean> },
  index: number,
): Promise<void> {
  const settings = await getSettings();
  const p = profileFor(helmet.code, index);
  const drift = Math.random() < 0.08 ? 260 : 0; // occasional short gas spike (simulated)
  const gasRaw = Math.max(120, p.gasBase + noise(70) + drift);
  const temperatureC = Math.max(20, p.tempBase + noise(1.4) + (drift ? 2.5 : 0));
  const humidityPercent = Math.min(99, Math.max(20, p.humidityBase + noise(6)));
  const batteryPercent = Math.max(
    3,
    (helmet.batteryPercent ?? p.batteryBase) - Math.random() * 0.35,
  );
  const ax = 0.12 + noise(0.06);
  const ay = 0.18 + noise(0.06);
  const az = 0.98 + noise(0.05);

  await ingestReading({
    helmet_id: helmet.code,
    worker_id: null,
    timestamp: new Date().toISOString(),
    gas_raw: helmet.sensors.gas === false ? null : Number(gasRaw.toFixed(1)),
    temperature_c: helmet.sensors.temperature === false ? null : Number(temperatureC.toFixed(2)),
    humidity_percent: helmet.sensors.humidity === false ? null : Number(humidityPercent.toFixed(1)),
    pressure_hpa: helmet.sensors.pressure === false ? null : Number((1012 + noise(4)).toFixed(1)),
    accel_x: helmet.sensors.accelerometer === false ? null : Number(ax.toFixed(3)),
    accel_y: helmet.sensors.accelerometer === false ? null : Number(ay.toFixed(3)),
    accel_z: helmet.sensors.accelerometer === false ? null : Number(az.toFixed(3)),
    battery_percent: helmet.sensors.battery === false ? null : Number(batteryPercent.toFixed(1)),
    source: "simulated",
  });
  void settings;
}

/**
 * Advance the simulated feed by one sample per helmet.
 * Safe to call frequently (SSE loop / dashboard refresh).
 */
export async function tickSimulator(): Promise<{ ticked: string[]; skipped: string[] }> {
  if (!(await isSimulatorEnabled())) return { ticked: [], skipped: [] };
  const rows = await db
    .select()
    .from(helmets)
    .where(andActive());
  const ticked: string[] = [];
  const skipped: string[] = [];
  let index = 0;
  for (const helmet of rows) {
    if (SIMULATED_OFFLINE_HELMETS.includes(helmet.code)) {
      skipped.push(helmet.code);
      index += 1;
      continue;
    }
    await tickHelmet(
      {
        id: helmet.id,
        code: helmet.code,
        batteryPercent: helmet.batteryPercent,
        sensors: helmet.sensors as unknown as Record<string, boolean>,
      },
      index,
    );
    ticked.push(helmet.code);
    index += 1;
  }
  await db
    .insert(systemState)
    .values({ key: "simulator", value: { enabled: true, lastTickAt: new Date().toISOString() } })
    .onConflictDoUpdate({
      target: systemState.key,
      set: { value: { enabled: true, lastTickAt: new Date().toISOString() }, updatedAt: new Date() },
    });
  return { ticked, skipped };
}

function andActive() {
  return sql`active = true`;
}

export type ScenarioKind = "gas" | "fall" | "temperature" | "battery" | "sos";

/**
 * Inject a clearly-labelled SIMULATED scenario. This is how the gas alert,
 * fall alert, temperature alert, low-battery alert and SOS paths are tested
 * without hardware (see docs/TESTING.md).
 */
export async function injectScenario(
  kind: ScenarioKind,
  helmetCode?: string,
): Promise<{ helmetCode: string; readingId: number; alertsRaised: number }> {
  const rows = await db.select().from(helmets).orderBy(helmets.id);
  const helmet = helmetCode ? rows.find((h) => h.code === helmetCode) : rows.find((h) => h.code !== "HELMET-004");
  if (!helmet) throw new Error("No helmet available for scenario injection");

  const linked = await db.select().from(workers).where(eq(workers.helmetId, helmet.id)).limit(1);
  const worker = linked[0];

  const base = {
    helmet_id: helmet.code,
    worker_id: worker?.code ?? null,
    timestamp: new Date().toISOString(),
    source: "simulated" as const,
  };
  const quietAxes = { accel_x: 0.12, accel_y: 0.16, accel_z: 0.99 };
  const g = (v: number) => Number(v.toFixed(3));

  let payload: Record<string, unknown>;
  switch (kind) {
    case "gas":
      payload = { ...base, ...quietAxes, gas_raw: 1650, temperature_c: 32.4, humidity_percent: 69, battery_percent: 78 };
      break;
    case "fall": {
      const ax = 2.9;
      const ay = -1.4;
      const az = 0.35;
      payload = {
        ...base,
        accel_x: g(ax),
        accel_y: g(ay),
        accel_z: g(az),
        accelMagnitudeOverride: magnitudeG(ax, ay, az),
        gas_raw: 690,
        temperature_c: 31.8,
        humidity_percent: 64,
        battery_percent: 76,
      };
      break;
    }
    case "temperature":
      payload = { ...base, ...quietAxes, gas_raw: 700, temperature_c: 46.5, humidity_percent: 72, battery_percent: 74 };
      break;
    case "battery":
      payload = { ...base, ...quietAxes, gas_raw: 640, temperature_c: 31.2, humidity_percent: 61, battery_percent: 8 };
      break;
    default:
      payload = { ...base, ...quietAxes, gas_raw: 655, temperature_c: 31, humidity_percent: 60, battery_percent: 70 };
  }

  const accelMagnitude =
    typeof payload.accel_x === "number" && typeof payload.accel_y === "number" && typeof payload.accel_z === "number"
      ? magnitudeG(payload.accel_x, payload.accel_y, payload.accel_z)
      : null;

  const result = await ingestReading({
    helmet_id: base.helmet_id,
    worker_id: base.worker_id ?? undefined,
    timestamp: base.timestamp,
    gas_raw: typeof payload.gas_raw === "number" ? payload.gas_raw : undefined,
    temperature_c: typeof payload.temperature_c === "number" ? payload.temperature_c : undefined,
    humidity_percent: typeof payload.humidity_percent === "number" ? payload.humidity_percent : undefined,
    accel_x: typeof payload.accel_x === "number" ? payload.accel_x : undefined,
    accel_y: typeof payload.accel_y === "number" ? payload.accel_y : undefined,
    accel_z: typeof payload.accel_z === "number" ? payload.accel_z : undefined,
    battery_percent: typeof payload.battery_percent === "number" ? payload.battery_percent : undefined,
    source: "simulated",
  });
  void accelMagnitude;

  if (kind === "sos") {
    const { raiseSosAlert } = await import("@/lib/safety/engine");
    await raiseSosAlert({
      workerCode: worker?.code,
      helmetCode: helmet.code,
      location: worker?.zone ?? null,
      note: "Simulated SOS from the mobile test panel.",
      source: "simulated",
    });
  }

  return {
    helmetCode: helmet.code,
    readingId: result.readingId,
    alertsRaised: result.alertsRaised.filter((a) => !a.suppressed).length,
  };
}

export async function simulatorStatus() {
  const enabled = await isSimulatorEnabled();
  const rows = await db.select({ code: helmets.code, state: helmets.connectionState }).from(helmets);
  const deviceHelmets = rows.filter((r) => r.state === "online").length;
  return { enabled, helmets: rows, deviceHelmets };
}

export async function helmetCodes(): Promise<string[]> {
  const rows = await db.select({ code: helmets.code }).from(helmets).where(eq(helmets.active, true));
  return rows.map((r) => r.code);
}
