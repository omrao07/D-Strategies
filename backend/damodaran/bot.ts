// damodaran/bot.ts
// High-level Damodaran “bot” for answering queries on models & datasets.
// Hooks into loader.ts (to fetch raw Damodaran data) and models.ts (to run analyses).

type DamodaranDataset = {
  name: string;
  category: string;
  year: number;
  values: Record<string, number>;
};

type BotResponse = {
  query: string;
  answer: string;
  context?: any;
};

declare function loadDamodaranData(source: string): DamodaranDataset[];
declare function runValuationModel(dataset: DamodaranDataset, model: string): Record<string, number>;

/**
 * DamodaranBot class
 * Provides Q&A style helpers around Damodaran datasets
 */
export class DamodaranBot {
  private datasets: DamodaranDataset[];

  constructor(source: string) {
    this.datasets = loadDamodaranData(source);
  }

  /** List all available dataset names */
  listDatasets(): string[] {
    return this.datasets.map(d => d.name);
  }

  /** Fetch dataset by name */
  getDataset(name: string): DamodaranDataset | undefined {
    return this.datasets.find(d => d.name.toLowerCase() === name.toLowerCase());
  }

  /** Run a valuation model on a dataset */
  analyze(name: string, model: string): Record<string, number> | undefined {
    const ds = this.getDataset(name);
    if (!ds) return;
    return runValuationModel(ds, model);
  }

  /** Q&A style response generator */
  ask(query: string): BotResponse {
    const q = query.toLowerCase();

    if (q.includes("list")) {
      return {
        query,
        answer: `Available datasets: ${this.listDatasets().join(", ")}`
      };
    }

    if (q.includes("valuation")) {
      const target = this.datasets[0];
      const result = this.analyze(target.name, "DCF");
      return {
        query,
        answer: `Ran valuation model (DCF) on ${target.name}.`,
        context: result
      };
    }

    return {
      query,
      answer: "Sorry, I could not understand the query. Try 'list datasets' or 'valuation <name>'."
    };
  }
}

// Example usage:
// const bot = new DamodaranBot("data/damodaran.csv");
// console.log(bot.ask("list datasets"));
// console.log(bot.ask("valuation US Equities"));