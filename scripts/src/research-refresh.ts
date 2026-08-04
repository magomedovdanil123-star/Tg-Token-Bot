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
  const candidateLimit = arg("candidate-limit", "10");

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

  const candidateCount = Number(candidateLimit);
  if (!Number.isInteger(candidateCount) || candidateCount < 1) {
    throw new Error("--candidate-limit должен быть положительным числом");
  }
  for (let candidate = 1; candidate <= candidateCount; candidate += 1) {
    steps.push({
      name: `Discovery пакет ${candidate}/${candidateCount}`,
      args: [
        "./src/research-discover.ts",
        `--candidate-limit=${candidateCount}`,
        `--candidate-start=${candidate}`,
        `--candidate-end=${candidate}`,
        "--max-results=100",
      ],
    });
  }
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