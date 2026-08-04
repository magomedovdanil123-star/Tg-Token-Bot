import { spawn } from "node:child_process";
import { once } from "node:events";

type Step = {
  name: string;
  args: string[];
};

function arg(name: string, fallback: string) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

async function runStep(step: Step) {
  console.log(`\n=== ${step.name} ===`);
  const child = spawn("pnpm", ["exec", "tsx", ...step.args], {
    stdio: "inherit",
    env: process.env,
  });
  const [code] = (await once(child, "exit")) as [number | null];
  if (code !== 0) {
    throw new Error(`${step.name} завершился с кодом ${code ?? "unknown"}`);
  }
}

async function main() {
  const years = arg("years", "2");
  const maxTickers = arg("max-tickers", "100");
  const skipImport = hasFlag("skip-import");
  const skipContext = hasFlag("skip-context");
  const maxResults = arg("max-results", "100");
  const maxEventsPerTicker = arg("max-events-per-ticker", "1000");
  const maxCombinationSize = arg("max-combination-size", "2");

  const steps: Step[] = [];
  if (!skipImport) {
    steps.push({
      name: "Обновление свечей MOEX и признаков",
      args: [
        "./src/download-moex-data.ts",
        `--years=${years}`,
        `--max-tickers=${maxTickers}`,
        "--skip-context=true",
      ],
    });
  }
  if (!skipContext) {
    steps.push({
      name: "Обновление рыночного контекста",
      args: ["./src/download-market-context.ts"],
    });
  }

  steps.push({
    name: "Исследовательское ядро комбинаций факторов",
    args: [
      "./src/research-discover.ts",
      `--max-results=${maxResults}`,
      `--max-events-per-ticker=${maxEventsPerTicker}`,
      `--max-combination-size=${maxCombinationSize}`,
      "--max-active-factors=6",
    ],
  });
  steps.push({
    name: "Обновление свечных паттернов",
    args: ["./src/discover-candle-patterns.ts"],
  });
  steps.push({
    name: "Обновление уровней и корреляций",
    args: ["./src/refresh-levels-correlations.ts"],
  });

  console.log(`Research refresh: ${steps.length} этапов`);
  for (const step of steps) {
    await runStep(step);
  }
  console.log("\nResearch refresh завершён успешно.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});