import chalk from "chalk";
import ora from "ora";
import { requireInit, openStore, loadConfig } from "./context.js";
import { renderAllPages } from "../render/markdown.js";

/** Remove topic pages with zero claims, then re-render wiki markdown. */
export async function pruneTopicsCommand(): Promise<void> {
  requireInit();
  const store = openStore();
  const config = await loadConfig();

  try {
    const spinner = ora("Pruning empty topic pages…").start();
    const pruned = store.deleteEmptyTopicPages();
    await renderAllPages(store, config.paths.wiki);
    spinner.succeed(
      pruned > 0
        ? chalk.green(`Pruned ${pruned} topic stub(s); wiki re-rendered.`)
        : chalk.dim("No topic stubs to prune; wiki re-rendered."),
    );
  } finally {
    store.close();
  }
}
