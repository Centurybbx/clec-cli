import type { AppConfig } from '../config.js';
import { currentGeneration } from '../ingestion/generation.js';
import { assertQmdGeneration } from '../qa/qmd-generation.js';

/** Availability of configuration and real generation metadata; never paid model work. */
export async function dependenciesReady(config: AppConfig, signal: AbortSignal): Promise<boolean> {
  if (!process.env.DEEPSEEK_API_KEY?.trim()) return false;
  try {
    const generation = await currentGeneration(config.stateRoot);
    await assertQmdGeneration(config, generation, signal);
    return !signal.aborted;
  } catch { return false; }
}
