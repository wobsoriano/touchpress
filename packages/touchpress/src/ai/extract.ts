import type { FlexibleSchema, LanguageModel } from 'ai';
import { renderTitle, type ActionSink } from '../core/report.ts';
import type { ExtractSchema } from './device.ts';
import type { AiModel } from './options.ts';
import { loadAi } from './sdk.ts';

export type ExtractRun<T> = {
  readonly model: AiModel;
  readonly screen: string;
  readonly question: string;
  readonly schema: ExtractSchema<T>;
  readonly sink: ActionSink;
  readonly timeout: number;
};

const EXTRACT_INSTRUCTIONS = [
  'You are reading one accessibility tree captured from a mobile app.',
  'Each line is one node, indented by depth, carrying its ref, role, name, and test id, as in: @e4 [button] "Sign in" #signIn',
  "The tree never prints a field's value.",
  'Answer from what the tree shows, not from what the app is expected to show.',
].join('\n');

/**
 * The public types are structural so the main entry's declarations never
 * import from `ai`, and these two casts are where they meet the SDK's own.
 * Every `LanguageModel` and every `FlexibleSchema` satisfies the structural
 * type it is cast from, so nothing the SDK accepts is turned away.
 */
export function languageModel(model: AiModel): LanguageModel {
  return model as LanguageModel;
}

function flexibleSchema<T>(schema: ExtractSchema<T>): FlexibleSchema<T> {
  return schema as FlexibleSchema<T>;
}

/** One capture, one question, one answer. No tools, so the model cannot change the screen it is describing. */
export function runExtract<T>(run: ExtractRun<T>): Promise<T> {
  return run.sink.step(
    renderTitle({ kind: 'extract', question: run.question }),
    async (): Promise<T> => {
      const { ToolLoopAgent, Output } = await loadAi();
      const agent = new ToolLoopAgent({
        model: languageModel(run.model),
        instructions: EXTRACT_INSTRUCTIONS,
        output: Output.object({ schema: flexibleSchema(run.schema) }),
      });
      const result = await agent.generate({
        prompt: [`Question: ${run.question}`, ``, `Screen:`, run.screen].join('\n'),
        abortSignal: AbortSignal.timeout(run.timeout),
      });
      return result.output;
    },
  );
}

/** `AbortSignal.timeout` rejects with a DOMException named TimeoutError, which a provider surfaces as is or as an AbortError. */
export function timedOut(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}
