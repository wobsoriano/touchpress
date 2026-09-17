import type { DeviceFailure } from './driver.ts';
import type { ScrollTrail } from './scroll.ts';

/**
 * The most a failure may say about the text that was typed. A secure field
 * reports one masking character per character it holds, so its length is all it
 * can report, and a field marked secret discloses a length too. A password has
 * no representation here, which keeps it out of a terminal and an HTML report.
 */
export type ExpectedValue =
  | { readonly kind: 'exact'; readonly value: string }
  | { readonly kind: 'masked'; readonly length: number };

/**
 * One class with a closed `info` union, so adapters and test authors switch on
 * `info.kind` and the compiler names a missing case when a kind is added.
 */
export type ErrorInfo =
  | { readonly kind: 'config'; readonly field: string; readonly detail: string }
  | {
      readonly kind: 'device-in-use';
      readonly owner: string | null;
      readonly device: string;
      readonly releaseCommand: string;
      /** False once `onDeviceInUse: 'reclaim'` is already set, so the message stops suggesting it. */
      readonly canReclaim: boolean;
    }
  | {
      readonly kind: 'launch-failed';
      readonly app: string;
      readonly device: string;
      readonly failure: DeviceFailure;
    }
  | {
      readonly kind: 'not-ready';
      readonly locator: string;
      readonly timeoutMs: number;
      readonly screen: string;
    }
  | { readonly kind: 'session-closed'; readonly command: string }
  | {
      readonly kind: 'strict-mode';
      readonly locator: string;
      readonly matches: readonly string[];
      readonly screen: string;
    }
  | {
      readonly kind: 'not-found';
      readonly locator: string;
      readonly timeoutMs: number;
      readonly screen: string;
      /** What the search scrolled looking for it, or null when it never scrolled. */
      readonly scrolled: ScrollTrail | null;
    }
  | {
      readonly kind: 'fill-unconfirmed';
      readonly locator: string;
      readonly expected: ExpectedValue;
      readonly actual: ExpectedValue | null;
      readonly attempts: number;
      readonly timeoutMs: number;
      readonly screen: string;
    }
  | {
      readonly kind: 'untappable';
      readonly locator: string;
      readonly screen: string;
    }
  /** Carries no field, because the rejected text is the one thing this error may not hold. */
  | { readonly kind: 'type-rejected' }
  | { readonly kind: 'driver'; readonly command: string; readonly failure: DeviceFailure }
  | { readonly kind: 'ai-not-configured' }
  | { readonly kind: 'ai-judge-not-configured' }
  | { readonly kind: 'ai-missing-peer' }
  /** The installed `ai` predates `experimental_evaluate`, which the peer range still allows. */
  | { readonly kind: 'ai-judge-unsupported' }
  /** A judgment `toBeJudged` was handed that no model could be asked, caught before one is. */
  | { readonly kind: 'ai-judgment-invalid'; readonly reason: string }
  | {
      readonly kind: 'ai-blocked';
      readonly instruction: string;
      /** The model's own account of what stopped it. */
      readonly summary: string;
      readonly screen: string;
    }
  | {
      readonly kind: 'ai-incomplete';
      readonly instruction: string;
      readonly steps: number;
      readonly screen: string;
    }
  | {
      readonly kind: 'ai-timeout';
      /** Which call ran out. Both spend a budget of their own on a model that never answered. */
      readonly command: 'act' | 'toBeJudged';
      /** What the call was asked. An instruction for `act`, the judgments for `toBeJudged`. */
      readonly asked: string;
      /** @deprecated Read `asked`. 0.2 carried the instruction here, and 0.3.0 dropped it without saying so. */
      readonly instruction: string;
      readonly timeoutMs: number;
      readonly screen: string;
    };

export class TouchpressError extends Error {
  readonly info: ErrorInfo;

  constructor(info: ErrorInfo) {
    super(formatError(info));
    this.name = 'TouchpressError';
    this.info = info;
  }
}

function formatError(info: ErrorInfo): string {
  switch (info.kind) {
    case 'config':
      return `Invalid touchpress option: use.${info.field} ${info.detail}`;
    case 'device-in-use':
      return [
        `Device ${info.device} is held by ${info.owner === null ? 'another session' : `session "${info.owner}"`}.`,
        `Release it with: ${info.releaseCommand}`,
        ...(info.canReclaim ? ["Or set use.onDeviceInUse to 'reclaim'."] : []),
      ].join('\n');
    case 'launch-failed':
      return `Could not open ${info.app} on ${info.device}: ${describeFailure(info.failure)}`;
    case 'not-ready':
      return [
        `App launched but never became ready.`,
        `Waited ${String(info.timeoutMs)}ms for readyWhen: ${info.locator}`,
        ``,
        `Screen:`,
        info.screen,
      ].join('\n');
    case 'session-closed':
      return `Cannot ${info.command}: the device session is closed.`;
    case 'strict-mode':
      return [
        `Locator resolved to ${String(info.matches.length)} nodes but an action needs exactly one.`,
        ``,
        `Locator: ${info.locator}`,
        `Matches:`,
        ...info.matches.map((match) => `  ${match}`),
        ``,
        `Narrow it with getByRole, or take one deliberately with .first() or .nth(n).`,
        ``,
        `Screen:`,
        info.screen,
      ].join('\n');
    case 'not-found':
      return [
        `Locator never resolved to a node within ${String(info.timeoutMs)}ms.`,
        ``,
        `Locator: ${info.locator}`,
        ...(info.scrolled === null ? [] : [`Scrolled: ${describeTrail(info.scrolled)}`]),
        ``,
        `Screen:`,
        info.screen,
      ].join('\n');
    case 'fill-unconfirmed':
      return [
        info.actual === null
          ? `fill lost the field after ${String(info.attempts)} attempts in ${String(info.timeoutMs)}ms.`
          : `fill left the field holding something else after ${String(info.attempts)} attempts in ${String(info.timeoutMs)}ms.`,
        ``,
        `Locator: ${info.locator}`,
        `Expected value: ${describeValue(info.expected)}${info.expected.kind === 'masked' ? ' (a secure field reports a mask, not its contents)' : ''}`,
        `Actual value: ${info.actual === null ? 'unknown, the field no longer resolved after the write' : describeValue(info.actual)}`,
        ``,
        `Screen:`,
        info.screen,
      ].join('\n');
    case 'untappable':
      return [
        `The matched node has no touch point of its own, and no enclosing control was found.`,
        ``,
        `Locator: ${info.locator}`,
        ``,
        `Name the control that receives the touch, with getByRole, or with`,
        `locator({ role: 'button', where: (node) => ... }).`,
        ``,
        `Screen:`,
        info.screen,
      ].join('\n');
    case 'type-rejected':
      return [
        'The driver cannot type text whose first word looks like a node reference.',
        'It reads a leading @ followed by a name with a digit in it, or by ref, node,',
        'element or el, as a ref to resolve rather than as characters to send.',
        '',
        'Type it through the field instead, with fill on a locator for that field.',
      ].join('\n');
    case 'driver':
      return `${info.command} failed: ${describeFailure(info.failure)}`;
    case 'ai-not-configured':
      return [
        'device.act and device.extract need a model.',
        "Set use.aiModel to a gateway model id, such as 'anthropic/claude-sonnet-5', or to a provider model instance.",
      ].join('\n');
    case 'ai-judge-not-configured':
      return [
        'expect(device).toBeJudged needs an evaluation model.',
        "Set use.evaluationModel to a provider instance, such as typeSafeAi.evaluationModel('jev-latest'),",
        "or to a gateway model id, such as 'typesafe-ai/jev-latest'.",
        'An evaluation model is its own kind, so the model in use.aiModel does not stand in for it.',
      ].join('\n');
    case 'ai-missing-peer':
      return [
        "device.act, device.extract, and expect(device).toBeJudged need the optional peer dependency 'ai'.",
        'Install it with: pnpm add -D ai',
      ].join('\n');
    case 'ai-judge-unsupported':
      return [
        "expect(device).toBeJudged needs experimental_evaluate, which the installed 'ai' package does not export.",
        'It needs ai 7.0.103 or newer, and 7.0.105 for a gateway model id.',
        'Upgrade it with: pnpm add -D ai@latest',
      ].join('\n');
    case 'ai-blocked':
      return [
        `act stopped without finishing: ${info.summary}`,
        ``,
        `Instruction: ${info.instruction}`,
        ``,
        `Screen:`,
        info.screen,
      ].join('\n');
    case 'ai-incomplete':
      return [
        `act ran ${String(info.steps)} steps without reaching an outcome.`,
        ``,
        `Instruction: ${info.instruction}`,
        ``,
        'Raise maxSteps, or split the instruction into smaller ones.',
        ``,
        `Screen:`,
        info.screen,
      ].join('\n');
    case 'ai-judgment-invalid':
      return `toBeJudged cannot run, because ${info.reason}.`;
    case 'ai-timeout':
      return [
        `${info.command} ran out of its ${String(info.timeoutMs)}ms budget before the model answered.`,
        ``,
        `${info.command === 'act' ? 'Instruction' : 'Judgments'}: ${info.asked}`,
        ``,
        `Raise the ${info.command} timeout, and the test timeout with it.`,
        ``,
        `Screen:`,
        info.screen,
      ].join('\n');
    default: {
      const never: never = info;
      throw new Error(`unhandled error info ${JSON.stringify(never)}`);
    }
  }
}

function describeTrail(trail: ScrollTrail): string {
  return `${String(trail.steps)} step${trail.steps === 1 ? '' : 's'} ${trail.direction}`;
}

/** A masked value is reported by its length alone, which is all a secure or secret field may disclose. */
function describeValue(value: ExpectedValue): string {
  switch (value.kind) {
    case 'exact':
      return `"${value.value}"`;
    case 'masked':
      return `${String(value.length)} characters`;
    default: {
      const never: never = value;
      throw new Error(`unhandled expected value ${JSON.stringify(never)}`);
    }
  }
}

export function describeFailure(failure: DeviceFailure): string {
  switch (failure.kind) {
    case 'device-busy':
      return `device is in use${failure.owner === null ? '' : ` by session "${failure.owner}"`} (${failure.detail})`;
    case 'device-missing':
      return `no matching device is booted (${failure.detail})`;
    case 'app-missing':
      return `the app is not installed on this device (${failure.detail})`;
    case 'session-rebound':
      return `the session is already bound to ${failure.boundTo} (${failure.detail})`;
    case 'stale-ref':
      return `the screen changed before the action reached it (${failure.detail})`;
    case 'ambiguous':
      return `the driver matched more than one element (${failure.detail})`;
    case 'covered':
      return `the node owns no touch point of its own (${failure.detail})`;
    case 'timeout':
      return `the driver timed out (${failure.detail})`;
    case 'unknown':
      return `${failure.code}: ${failure.detail}${failure.logPath === null ? '' : `\nDiagnostics: ${failure.logPath}`}`;
    default: {
      const never: never = failure;
      throw new Error(`unhandled failure ${JSON.stringify(never)}`);
    }
  }
}
