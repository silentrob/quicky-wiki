import chalk from "chalk";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { requireInit, openStore, loadConfig } from "./context.js";
import { detectDuplicateEntities } from "../embeddings/dedup.js";

export async function dedupEntitiesCommand(opts: {
  threshold?: string;
  autoMerge?: boolean;
  dryRun?: boolean;
}): Promise<void> {
  requireInit();
  const store = openStore();
  const config = await loadConfig();
  try {
    const threshold =
      opts.threshold != null ? parseFloat(opts.threshold) : 0.92;
    if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
      console.error(chalk.red("Invalid --threshold (expect 0..1)"));
      process.exitCode = 1;
      return;
    }

    const pairs = detectDuplicateEntities(store, config, { threshold });
    if (pairs.length === 0) {
      console.log(chalk.green("No duplicate entity candidates found."));
      return;
    }

    console.log(
      chalk.bold(`Found ${pairs.length} potential duplicate pair(s):\n`),
    );

    if (opts.dryRun) {
      for (const p of pairs) {
        console.log(
          `  ${p.canonicalNameA} ↔ ${p.canonicalNameB}  sim=${p.similarity.toFixed(3)}  claims: ${p.claimCountA} vs ${p.claimCountB}`,
        );
      }
      return;
    }

    if (opts.autoMerge) {
      let merged = 0;
      for (const p of pairs) {
        if (!store.getEntity(p.entityIdA) || !store.getEntity(p.entityIdB)) {
          continue;
        }
        const [winnerId, loserId] =
          p.claimCountA >= p.claimCountB
            ? [p.entityIdA, p.entityIdB]
            : [p.entityIdB, p.entityIdA];
        store.mergeEntities(winnerId, loserId);
        merged++;
        const w = store.getEntity(winnerId);
        console.log(
          chalk.green(
            `Merged into "${w?.canonicalName ?? winnerId}" (winner kept).`,
          ),
        );
      }
      console.log(chalk.green(`\nDone. Merged ${merged} pair(s).`));
      return;
    }

    const rl = createInterface({ input, output });
    try {
      for (const p of pairs) {
        const winnerClaims =
          p.claimCountA >= p.claimCountB ? p.claimCountA : p.claimCountB;
        const loserClaims =
          p.claimCountA >= p.claimCountB ? p.claimCountB : p.claimCountA;
        const [winnerId, loserId, winnerName, loserName] =
          p.claimCountA >= p.claimCountB
            ? [
                p.entityIdA,
                p.entityIdB,
                p.canonicalNameA,
                p.canonicalNameB,
              ]
            : [
                p.entityIdB,
                p.entityIdA,
                p.canonicalNameB,
                p.canonicalNameA,
              ];

        console.log(
          chalk.cyan(`\n  ${loserName}`) +
            chalk.dim(` (${loserClaims} claims)`) +
            chalk.dim(" ↔ ") +
            chalk.cyan(`${winnerName}`) +
            chalk.dim(` (${winnerClaims} claims)`) +
            chalk.dim(`  similarity: ${p.similarity.toFixed(3)}`),
        );

        if (!store.getEntity(winnerId) || !store.getEntity(loserId)) {
          console.log(chalk.dim("  Skipped (entity already merged)."));
          continue;
        }

        const ans = (
          await rl.question(
            chalk.yellow(
              `Merge into "${winnerName}" (absorb "${loserName}")? [Y/n/skip] `,
            ),
          )
        )
          .trim()
          .toLowerCase();

        if (ans === "skip" || ans === "s") {
          console.log(chalk.dim("  Skipped pair."));
          continue;
        }
        if (ans === "n" || ans === "no") {
          console.log(chalk.dim("  No."));
          continue;
        }

        if (!store.getEntity(winnerId) || !store.getEntity(loserId)) {
          console.log(chalk.dim("  Skipped (entity already merged)."));
          continue;
        }

        store.mergeEntities(winnerId, loserId);
        console.log(chalk.green("  Merged."));
      }
    } finally {
      rl.close();
    }
  } finally {
    store.close();
  }
}
