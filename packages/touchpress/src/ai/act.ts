import type { FlexibleSchema, LanguageModel, ToolSet } from 'ai';
import { TouchpressError } from '../core/errors.ts';
import { renderTitle, type ActionSink } from '../core/report.ts';
import type { Platform } from '../core/screen.ts';
import { createQueue } from '../core/session.ts';
import type { ExtractSchema } from './device.ts';
import type { AiModel } from './options.ts';
import { loadAi, toolRecord, typedText } from './tools.ts';

const TRANSCRIPT_RESULT_LIMIT = 2048;

export type ActRun = {
  readonly model: AiModel;
  readonly tools: ToolSet;
  readonly sink: ActionSink;
  readonly instruction: string;
  readonly platform: Platform;
  readonly maxSteps: number;
  readonly timeout: number;
  /** Read only when the run fails, for the screen an `ai-blocked` or `ai-incomplete` message prints. */
  readonly screen: () => Promise<string>;
  /** Numbers this run's transcript, the way `device.screenshot` numbers its files. */
  readonly attempt: number;
};

export type ExtractRun<T> = {
  readonly model: AiModel;
  readonly screen: string;
  readonly question: string;
  readonly schema: ExtractSchema<T>;
  readonly sink: ActionSink;
  readonly timeout: number;
};

/**
 * How the run ends. The model says so by calling `done`, rather than the
 * outcome being read out of free text, so a run that could not finish fails the
 * test instead of returning prose that reads like success.
 */
type Outcome =
  | { readonly kind: 'completed'; readonly summary: string }
  | { readonly kind: 'blocked'; readonly summary: string };

function instructionsFor(platform: Platform): string {
  return [
    `You are driving a ${platform} app that is already launched and in the foreground.`,
    'Start with snapshot.',
    'A snapshot prints one node per line, indented by depth, as in: @e4 [button] "Sign in" #signIn',
    "Use press to tap a node and fill to replace a field's text.",
    'Both take the ref as { "kind": "ref", "ref": "@e4" }, copied exactly as the line printed it.',
    'Every ref stops working when the next command runs, so snapshot again after each action before you use one.',
    'Use coordinates only when no line on the snapshot is the thing you need.',
    'Once a snapshot shows the instruction is satisfied, call done with outcome "completed" and a one-line summary. Do not take a second snapshot to double-check.',
    'If you cannot proceed, call done with outcome "blocked" and say what stopped you.',
  ].join('\n');
}

const EXTRACT_INSTRUCTIONS = [
  'You are reading one accessibility tree captured from an app.',
  'Each line is one node, indented by depth, carrying its ref, role, name, and test id, as in: @e4 [button] "Sign in" #signIn',
  "The tree never prints a field's value.",
  'Answer from what the tree shows, not from what the app is expected to show.',
].join('\n');

/**
 * Runs the model against the tools until it calls `done`. Nothing here knows
 * about a session, so a test drives it with fake tools and a mock model.
 *
 * A tool error thrown inside `execute` is not caught: the AI SDK hands it back
 * to the model as a tool result, which is what lets it recover from a ref that
 * went stale by taking a fresh snapshot.
 */
export function runAct(run: ActRun): Promise<string> {
  return run.sink.step(
    renderTitle({ kind: 'act', instruction: run.instruction }),
    async (): Promise<string> => {
      const { ToolLoopAgent, hasToolCall, jsonSchema, stepCountIs, tool } = await loadAi();

      const agent = new ToolLoopAgent({
        model: languageModel(run.model),
        instructions: instructionsFor(run.platform),
        tools: {
          ...reporting(run.tools, run.sink),
          done: tool({
            description:
              'Finish the instruction. Call this when it is satisfied, or when you cannot proceed.',
            inputSchema: jsonSchema({
              type: 'object',
              properties: {
                outcome: {
                  type: 'string',
                  enum: ['completed', 'blocked'],
                  description:
                    'completed when the instruction is satisfied, blocked when it is not',
                },
                summary: {
                  type: 'string',
                  description: 'One line saying what you did, or what stopped you.',
                },
              },
              required: ['outcome', 'summary'],
              additionalProperties: false,
            }),
          }),
        },
        stopWhen: [hasToolCall('done'), stepCountIs(run.maxSteps)],
      });

      const result = await agent
        .generate({
          prompt: run.instruction,
          abortSignal: AbortSignal.timeout(run.timeout),
        })
        .catch(async (error: unknown) => {
          if (!timedOut(error)) throw error;
          throw new TouchpressError({
            kind: 'ai-timeout',
            instruction: run.instruction,
            timeoutMs: run.timeout,
            screen: await run.screen(),
          });
        });

      await run.sink.attach({
        name: `ai-act-${String(run.attempt)}.json`,
        contentType: 'application/json',
        body: JSON.stringify(
          {
            instruction: run.instruction,
            usage: result.usage,
            steps: result.steps.map((step) => {
              const errors = toolErrors(step.content);
              return {
                text: step.text,
                toolCalls: step.toolCalls.map((call) => ({
                  name: call.toolName,
                  input: call.input,
                })),
                toolResults: step.toolResults.map((toolResult) => ({
                  name: toolResult.toolName,
                  output: clip(toolResult.output),
                })),
                ...(errors.length === 0 ? {} : { toolErrors: errors }),
              };
            }),
          },
          null,
          2,
        ),
      });

      const outcome = outcomeOf(result.steps.at(-1)?.toolCalls);
      if (outcome === null) {
        throw new TouchpressError({
          kind: 'ai-incomplete',
          instruction: run.instruction,
          steps: result.steps.length,
          screen: await run.screen(),
        });
      }
      if (outcome.kind === 'blocked') {
        throw new TouchpressError({
          kind: 'ai-blocked',
          instruction: run.instruction,
          summary: outcome.summary,
          screen: await run.screen(),
        });
      }
      return outcome.summary;
    },
  );
}

/**
 * The public types are structural so the main entry's declarations never
 * import from `ai`, and these two casts are where they meet the SDK's own.
 * Every `LanguageModel` and every `FlexibleSchema` satisfies the structural
 * type it is cast from, so nothing the SDK accepts is turned away.
 */
function languageModel(model: AiModel): LanguageModel {
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

/**
 * Every model action becomes a step wrapping its own execution, so a report
 * shows the loop as it ran. The executions share one queue, because the AI SDK
 * runs the tool calls of one step concurrently and a snapshot overlapping a
 * press on the device reads a screen the press is changing.
 */
function reporting(tools: ToolSet, sink: ActionSink): ToolSet {
  const queue = createQueue();
  const wrapped: ToolSet = {};
  for (const [name, built] of Object.entries(tools)) {
    const { execute } = built;
    if (execute === undefined) {
      wrapped[name] = built;
      continue;
    }
    wrapped[name] = {
      ...built,
      execute: (input, options) =>
        queue.enqueue(() =>
          sink.step(renderTitle(toolRecord(name, input)), async () => {
            const text = typedText(name, input);
            if (text !== null) {
              await sink.step(
                renderTitle({ kind: 'typed', typed: { kind: 'text', value: text } }),
                () => Promise.resolve(),
                { box: true },
              );
            }
            return execute(input, options);
          }),
        ),
    };
  }
  return wrapped;
}

/**
 * The `done` call is validated here rather than trusted, because a JSON schema
 * handed to `jsonSchema()` describes the tool to the model and validates
 * nothing. A malformed call is a run that never reached an outcome.
 */
function outcomeOf(
  calls: readonly { toolName: string; input: unknown }[] | undefined,
): Outcome | null {
  const call = calls?.find((one) => one.toolName === 'done');
  if (call === undefined || typeof call.input !== 'object' || call.input === null) return null;
  const summary = Reflect.get(call.input, 'summary');
  if (typeof summary !== 'string') return null;
  const outcome = Reflect.get(call.input, 'outcome');
  if (outcome === 'completed') return { kind: 'completed', summary };
  if (outcome === 'blocked') return { kind: 'blocked', summary };
  return null;
}

/** `AbortSignal.timeout` rejects with a DOMException named TimeoutError, which a provider surfaces as is or as an AbortError. */
function timedOut(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * The calls that failed. `step.toolResults` holds only the ones that returned,
 * so a transcript built from it alone shows a loop doing nothing and never says
 * why, which is what a nine-error run looked like from the attachment.
 */
function toolErrors(
  content: readonly { readonly type: string }[],
): { name: string; input: unknown; error: string }[] {
  return content
    .filter((part): part is ToolErrorPart => part.type === 'tool-error')
    .map((part) => ({ name: part.toolName, input: part.input, error: messageOf(part.error) }));
}

type ToolErrorPart = {
  readonly type: 'tool-error';
  readonly toolName: string;
  readonly input: unknown;
  readonly error: unknown;
};

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : (JSON.stringify(error) ?? 'unknown error');
}

function clip(output: unknown): string {
  const text = JSON.stringify(output) ?? 'undefined';
  return text.length <= TRANSCRIPT_RESULT_LIMIT
    ? text
    : `${text.slice(0, TRANSCRIPT_RESULT_LIMIT)}...`;
}
