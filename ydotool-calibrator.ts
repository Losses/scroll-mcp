// ydotool coordinate calibration module
// Provides stable coordinate mapping and calibration functionality

import { execSync } from "node:child_process";

// Types
export interface Point {
  x: number;
  y: number;
}

interface CalibrationResult {
  scaleFactor: number;
  maxLogical: Point;
  maxPhysical: Point;
  timestamp: number;
}

interface CalibratorConfig {
  samples: number;
  settleMs: number;
  maxAttempts: number;
  tolerance: number;
  validationPoints: Point[];
}

// Helpers
function run(cmd: string): string {
  try {
    return execSync(cmd, { timeout: 10000 }).toString().trim();
  } catch (e: any) {
    throw new Error(`Command failed: ${cmd}\n${e.message}`);
  }
}

// Get screen size from scrollmsg
function getScreenSize(): Point {
  try {
    const tree = run("scrollmsg -t GET_TREE");
    const data = JSON.parse(tree);

    let maxX = 0, maxY = 0;
    for (const node of data.nodes || []) {
      if (node.rect) {
        maxX = Math.max(maxX, node.rect.x + (node.rect.width || 0));
        maxY = Math.max(maxY, node.rect.y + (node.rect.height || 0));
      }
    }

    if (maxX > 0 && maxY > 0) {
      return { x: maxX, y: maxY };
    }
  } catch (e) {
    // fallback to default
  }
  return { x: 1920, y: 1080 };
}

// Read cursor position with debouncing
async function stableReadPosition(
  targetSamples: number,
  tolerance: number,
  timeoutMs: number = 5000
): Promise<Point> {
  const readings: Point[] = [];
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const output = run("wl-find-cursor -p");
      const parts = output.trim().split(/\s+/);

      if (parts.length >= 2) {
        const x = Number(parts[0]);
        const y = Number(parts[1]);

        if (!isNaN(x) && !isNaN(y)) {
          readings.push({ x, y });

          if (readings.length >= targetSamples) {
            const lastN = readings.slice(-targetSamples);
            const avg = averagePoint(lastN);
            const maxDev = maxDeviation(lastN, avg);

            if (maxDev <= tolerance) {
              return avg;
            }
          }
        }
      }
    } catch (e) {
      // ignore single read error, continue
    }

    await sleep(20);
  }

  if (readings.length >= 3) {
    return averagePoint(readings);
  }

  throw new Error(`Insufficient readings: got ${readings.length}, needed ${targetSamples}`);
}

// Move mouse and wait for settle
async function moveToAndWait(targetX: number, targetY: number, settleMs: number): Promise<void> {
  execSync(`ydotool mousemove --absolute -x ${targetX} -y ${targetY}`, {
    stdio: "ignore",
  });
  await sleep(settleMs);
}

function averagePoint(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return {
    x: Math.round(sum.x / points.length),
    y: Math.round(sum.y / points.length),
  };
}

function maxDeviation(points: Point[], center: Point): number {
  let maxDev = 0;
  for (const p of points) {
    const dev = Math.sqrt((p.x - center.x) ** 2 + (p.y - center.y) ** 2);
    maxDev = Math.max(maxDev, dev);
  }
  return maxDev;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Calibrate single point
async function calibratePoint(
  targetX: number,
  targetY: number,
  config: CalibratorConfig
): Promise<{ expected: Point; actual: Point }> {
  console.log(`  Calibrating point (${targetX}, ${targetY})...`);

  await moveToAndWait(targetX, targetY, config.settleMs);
  const actual = await stableReadPosition(config.samples, config.tolerance);

  console.log(`    Expected: (${targetX}, ${targetY}) → Actual: (${actual.x}, ${actual.y})`);

  return { expected: { x: targetX, y: targetY }, actual };
}

// Calculate scale factor from multiple points
// Scale factor MUST be an integer (1, 2, 3) representing DPI scaling
// Non-integer or inconsistent values indicate a bug
function calculateScaleFactor(points: Array<{ expected: Point; actual: Point }>): number {
  const scales: number[] = [];

  for (const p of points) {
    if (p.expected.x > 0) scales.push(p.actual.x / p.expected.x);
    if (p.expected.y > 0) scales.push(p.actual.y / p.expected.y);
  }

  if (scales.length === 0) {
    throw new Error("No valid scale measurements");
  }

  // All scales must be identical (within rounding error)
  const firstScale = scales[0]!;
  for (const scale of scales) {
    if (Math.abs(scale - firstScale) > 0.01) {
      throw new Error(
        `Inconsistent scale factors detected: ${scales.map(s => s.toFixed(2)).join(", ")}`
      );
    }
  }

  const scale = Math.round(firstScale);

  // Must be an integer
  if (Math.abs(scale - firstScale) > 0.01) {
    throw new Error(
      `Scale factor must be integer, got ${firstScale.toFixed(2)}. ` +
      "This indicates a bug in the coordinate mapping assumption."
    );
  }

  return scale;
}

// Validate calibration result
async function validateCalibration(
  calibration: CalibrationResult,
  config: CalibratorConfig
): Promise<boolean> {
  console.log("\nValidating calibration...");

  for (const testPoint of config.validationPoints) {
    const logical = {
      x: Math.min(testPoint.x, calibration.maxLogical.x),
      y: Math.min(testPoint.y, calibration.maxLogical.y),
    };

    const expectedPhysical = {
      x: Math.min(Math.round(logical.x * calibration.scaleFactor), calibration.maxPhysical.x),
      y: Math.min(Math.round(logical.y * calibration.scaleFactor), calibration.maxPhysical.y),
    };

    const result = await calibratePoint(logical.x, logical.y, config);
    const actual = result.actual;

    const error = Math.sqrt(
      (actual.x - expectedPhysical.x) ** 2 + (actual.y - expectedPhysical.y) ** 2
    );

    console.log(`  Point (${logical.x}, ${logical.y})`);
    console.log(`    Expected: (${expectedPhysical.x}, ${expectedPhysical.y})`);
    console.log(`    Actual: (${actual.x}, ${actual.y})`);
    console.log(`    Error: ${error.toFixed(2)}px`);

    if (error > config.tolerance * 2) {
      console.log(`    ✗ Error too large`);
      return false;
    }
    console.log(`    ✓ Pass`);
  }

  return true;
}

// Perform full calibration
export async function calibrate(): Promise<CalibrationResult> {
  console.log("\n=== ydotool Coordinate Calibration ===\n");
  console.log("Please ensure:");
  console.log("  - wl-find-cursor is available");
  console.log("  - ydotool daemon is running");
  console.log("  - Don't move mouse during calibration\n");

  const config: CalibratorConfig = {
    samples: 5,
    settleMs: 100,
    maxAttempts: 10,
    tolerance: 2,
    validationPoints: [
      { x: 0, y: 0 },
      { x: 384, y: 480 },
      { x: 768, y: 960 },
    ],
  };

  const screenSize = getScreenSize();
  console.log(`Screen size: ${screenSize.x}×${screenSize.y}\n`);

  // Step 1: Determine scale factor
  console.log("Step 1: Determining scale factor");

  const scaleTestPoints = [
    { x: 100, y: 100 },
    { x: 200, y: 200 },
    { x: 500, y: 500 },
  ];

  const scaleResults: Array<{ expected: Point; actual: Point }> = [];

  for (const p of scaleTestPoints) {
    try {
      const result = await calibratePoint(p.x, p.y, config);
      scaleResults.push(result);
    } catch (e) {
      console.log(`    Warning: ${e}`);
    }
  }

  const scaleFactor = calculateScaleFactor(scaleResults);
  console.log(`  ✓ Scale factor: ${scaleFactor}\n`);

  // Step 2: Determine max physical coordinates
  console.log("Step 2: Determining max physical coordinates");

  const maxResult = await calibratePoint(99999, 99999, config);
  const maxPhysical = maxResult.actual;
  const maxLogical = {
    x: Math.round(maxPhysical.x / scaleFactor),
    y: Math.round(maxPhysical.y / scaleFactor),
  };

  console.log(`  Max physical coords: (${maxPhysical.x}, ${maxPhysical.y})`);
  console.log(`  Max logical coords: (${maxLogical.x}, ${maxLogical.y})`);
  console.log(`  Actual resolution: ${maxPhysical.x + 1}×${maxPhysical.y + 1}\n`);

  const calibration: CalibrationResult = {
    scaleFactor,
    maxLogical,
    maxPhysical,
    timestamp: Date.now(),
  };

  // Step 3: Validate
  const valid = await validateCalibration(calibration, config);
  if (!valid) {
    throw new Error("Calibration validation failed! Formula may not work for current device.");
  }

  console.log("\n✓ Calibration successful!\n");
  console.log("Conversion formula:");
  console.log(`  physical = min(logical × ${scaleFactor}, ${maxPhysical.x}, ${maxPhysical.y})`);
  console.log(`  logical = min(physical ÷ ${scaleFactor}, ${maxLogical.x}, ${maxLogical.y})`);

  return calibration;
}

// Coordinate conversion
export function logicalToPhysical(logical: Point, calibration: CalibrationResult): Point {
  return {
    x: Math.min(Math.round(logical.x * calibration.scaleFactor), calibration.maxPhysical.x),
    y: Math.min(Math.round(logical.y * calibration.scaleFactor), calibration.maxPhysical.y),
  };
}

export function physicalToLogical(physical: Point, calibration: CalibrationResult): Point {
  return {
    x: Math.min(Math.round(physical.x / calibration.scaleFactor), calibration.maxLogical.x),
    y: Math.min(Math.round(physical.y / calibration.scaleFactor), calibration.maxLogical.y),
  };
}

// Global calibrator manager
class CalibratorManager {
  private calibration: CalibrationResult | null = null;
  private calibrating: boolean = false;

  async get(): Promise<CalibrationResult> {
    if (this.calibration) {
      return this.calibration;
    }

    if (this.calibrating) {
      while (this.calibrating) {
        await sleep(100);
      }
      return this.calibration!;
    }

    this.calibrating = true;
    try {
      this.calibration = await calibrate();
      return this.calibration;
    } finally {
      this.calibrating = false;
    }
  }

  set(calibration: CalibrationResult) {
    this.calibration = calibration;
  }

  reset() {
    this.calibration = null;
  }

  async toPhysical(logical: Point): Promise<Point> {
    const cal = await this.get();
    return logicalToPhysical(logical, cal);
  }

  async toLogical(physical: Point): Promise<Point> {
    const cal = await this.get();
    return physicalToLogical(physical, cal);
  }
}

export const calibrator = new CalibratorManager();
