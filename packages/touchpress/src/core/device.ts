import { describeNode, type Check } from './checks.ts';
import type { ResolvedOptions } from './config.ts';
import type { BackMode, ScrollDirection, Settled } from './driver.ts';
import { TouchpressError, type ExpectedValue } from './errors.ts';
import { probe, type ProbeOptions, type ProbeResult } from './probe.ts';
import {
  describeQuery,
  normalizeText,
  textMatch,
  type Filter,
  type Query,
  type Role,
} from './query.ts';
import { createScrollSearch, type ScrollDevice } from './scroll.ts';
import { renderTitle, type ActionRecord, type ActionSink, type Typed } from './report.ts';
import {
  matchesOf,
  pin,
  renderScreen,
  resolve,
  touchTargetFor,
  type PinnedRef,
  type Screen,
  type ScreenNode,
} from './screen.ts';
import { failureOf, sleep, type DeviceSession, type SessionDevice } from './session.ts';

const ACTION_POLL_MS = 250;
const DEFAULT_LONG_PRESS_MS = 1000;

export type TextOptions = { exact?: boolean };
export type RoleOptions = { name?: string | RegExp; exact?: boolean };
export type ActionOptions = { timeout?: number };

/**
 * `hasText` matches the node's own text or any text in its subtree, while
 * `has` needs a strict descendant. That asymmetry matches Playwright.
 */
export type FilterOptions = {
  hasText?: string | RegExp;
  hasNotText?: string | RegExp;
  has?: Locator;
  hasNot?: Locator;
};

/**
 * `secret` reports only a character count, for a credential field the platform
 * did not mark secure. The write is still confirmed character by character,
 * because a plain field hands back its exact contents.
 */
export type FillOptions = ActionOptions & { secret?: boolean };

export type BackOptions = ActionOptions & { mode?: BackMode };

/** `secret` reports a character count instead of the text, the way `fill`'s does. */
export type TypeOptions = ActionOptions & { secret?: boolean };

/**
 * Playwright's `page.keyboard`, cut down to what a device keyboard can do with
 * no target. Everything else touchpress offers needs a locator.
 */
export type Keyboard = {
  /**
   * Types into whatever holds focus, for a field with nothing to select on,
   * such as a one-time-code input the app focused for itself. Nothing is read
   * back, because there is no target to read.
   */
  type(text: string, options?: TypeOptions): Promise<void>;
};

export type Device = {
  /**
   * The resolved configuration this device runs under. A spec reads `platform`
   * off it under either runner, and a matcher whose runner gives it no timeout
   * reads `expectTimeout`.
   */
  readonly options: ResolvedOptions;
  /** Matches a node's accessibility name or its value. */
  getByText(text: string | RegExp, options?: TextOptions): Locator;
  getByRole(role: Role, options?: RoleOptions): Locator;
  /** Matches the accessibility identifier, which is what a React Native `testID` becomes. */
  getByTestId(testId: string): Locator;
  locator(query: Query): Locator;

  scroll(direction: ScrollDirection): Promise<void>;
  /**
   * Goes back. Defaults to the platform gesture on Android and to the app's own
   * navigation control on iOS, which has no system back to press.
   */
  goBack(options?: BackOptions): Promise<void>;
  readonly keyboard: Keyboard;
  /** Discards the app's stored state, then relaunches and waits for the ready gate again. */
  clearState(): Promise<void>;
  /**
   * Resets the simulator's keychain, which is shared by every app on it, so
   * it is not part of `clearState`. A no-op on Android, where clearing state
   * already removes the app's keystore entries.
   */
  clearKeychain(): Promise<void>;
  /** Relaunches the app and waits for the ready gate again. */
  relaunch(): Promise<void>;
  /** Never automatic, because hiding the overlay would suppress a warning a test might want to see. */
  dismissDevOverlay(): Promise<void>;
  screen(): Promise<Screen>;
  /** Returns the path. Nothing is attached to the report, so the caller decides whether to. */
  screenshot(options?: { path?: string }): Promise<string>;
};

/** A query bound to a session. Safe to hold across an action, because it stores a query and never a ref. */
export type Locator = {
  readonly query: Query;
  /** The device this locator came from. A screenshot assertion needs the image and the tree, and a locator carries neither. */
  readonly device: Device;
  /** The factory call this locator renders back to, used in step titles and failure messages. */
  readonly description: string;
  first(): Locator;
  /** Negative indexes count from the end, so `nth(-1)` is the last match. */
  nth(index: number): Locator;
  filter(options: FilterOptions): Locator;
  tap(options?: ActionOptions): Promise<void>;
  fill(text: string, options?: FillOptions): Promise<void>;
  longPress(durationMs?: number, options?: ActionOptions): Promise<void>;
  /** Actions scroll for themselves, so this is for seeing a node rather than acting on it. */
  scrollIntoView(options?: ActionOptions): Promise<void>;
  count(): Promise<number>;
  /** The matched node's text off one fresh screen. Null when nothing matches. Ambiguity fails the way an action does. */
  textContent(): Promise<string | null>;
  expect(check: Check, options: ProbeOptions): Promise<ProbeResult>;
};

export function createDevice(session: DeviceSession, sink: ActionSink): Device {
  const build = (query: Query): Locator => createLocator(session, sink, query, device);
  let screenshots = 0;
  const device: Device = {
    options: session.options,
    getByText: (text, options) => build({ name: textMatch(text, options?.exact) }),
    getByRole: (role, options) =>
      build(
        options?.name === undefined
          ? { role }
          : { role, name: textMatch(options.name, options.exact) },
      ),
    getByTestId: (testId) => build({ testId: textMatch(testId, true) }),
    locator: build,
    scroll: (direction) =>
      sink.step(renderTitle({ kind: 'scroll', direction }), async () => {
        await session.run((device) => device.scroll(direction, session.options.actionTimeout));
      }),
    goBack: (options) => {
      const mode = options?.mode ?? (session.options.platform === 'android' ? 'system' : 'in-app');
      return sink.step(renderTitle({ kind: 'back', mode }), async () => {
        const budget = options?.timeout ?? session.options.actionTimeout;
        await session.run((device) => device.back(mode, budget));
      });
    },
    keyboard: {
      type: (text, options) =>
        sink.step(renderTitle({ kind: 'typed', typed: typedText(text, options) }), async () => {
          const budget = options?.timeout ?? session.options.actionTimeout;
          await session.run((device) => device.type(text, budget));
        }),
    },
    clearState: () => session.clearState(sink),
    clearKeychain: () => session.clearKeychain(sink),
    relaunch: () => session.relaunch(sink),
    dismissDevOverlay: () =>
      sink.step(renderTitle({ kind: 'dismiss-overlay' }), () => session.dismissDevOverlay()),
    screen: () => session.screen(),
    screenshot: (options) => {
      if (options?.path === undefined) screenshots += 1;
      const path = options?.path ?? sink.outputPath(`screenshot-${String(screenshots)}.png`);
      return sink.step(renderTitle({ kind: 'screenshot', path }), () => session.screenshot(path));
    },
  };
  return device;
}

function createLocator(
  session: DeviceSession,
  sink: ActionSink,
  query: Query,
  device: Device,
): Locator {
  const description = describeQuery(query);
  const withIndex = (index: number): Locator =>
    createLocator(session, sink, { ...query, index }, device);
  return {
    query,
    device,
    description,
    first: () => withIndex(0),
    nth: (index) => withIndex(index),
    filter: (options) =>
      createLocator(
        session,
        sink,
        { ...query, filters: [...(query.filters ?? []), filterOf(options)] },
        device,
      ),
    tap: (options) =>
      perform(session, sink, { kind: 'tap', query }, options, (device, ref, budget) =>
        device.tap(ref, budget),
      ),
    fill: (text, options) =>
      perform(
        session,
        sink,
        { kind: 'fill', query },
        options,
        (device, ref, budget) => device.fill(ref, text, budget),
        { text, secret: options?.secret ?? false },
      ),
    longPress: (durationMs, options) => {
      const held = durationMs ?? DEFAULT_LONG_PRESS_MS;
      return perform(
        session,
        sink,
        { kind: 'long-press', query, durationMs: held },
        options,
        (device, ref, budget) => device.longPress(ref, held, budget),
      );
    },
    scrollIntoView: (options) => scrollIntoView(session, sink, query, options),
    count: async () => {
      const resolution = resolve(await session.screen(), query);
      return resolution.outcome === 'many'
        ? resolution.nodes.length
        : resolution.outcome === 'one'
          ? 1
          : 0;
    },
    textContent: async () => {
      const screen = await session.screen();
      const resolution = resolve(screen, query);
      switch (resolution.outcome) {
        case 'many':
          throw ambiguous(description, resolution.nodes, screen);
        case 'none':
          return null;
        case 'one':
          return resolution.node.name ?? resolution.node.value;
        default: {
          const never: never = resolution;
          throw new Error(`unhandled resolution ${JSON.stringify(never)}`);
        }
      }
    },
    expect: (check, options) =>
      probe(
        { query, description, capture: () => session.screen(), failure: () => session.failure() },
        check,
        options,
      ),
  };
}

function filterOf(options: FilterOptions): Filter {
  return {
    hasText: options.hasText === undefined ? undefined : textMatch(options.hasText),
    hasNotText: options.hasNotText === undefined ? undefined : textMatch(options.hasNotText),
    has: options.has?.query,
    hasNot: options.hasNot?.query,
  };
}

/**
 * One action is one queued unit and one reported step. Ambiguity fails at once,
 * because waiting cannot make a locator less ambiguous. A stale ref retries
 * once, and a second one means the screen is changing faster than an action can
 * land.
 *
 * `write` makes this a write that is read back. A device keyboard drops early
 * keystrokes often enough that a fill can under-deliver and still report
 * success, so fill dispatches again until the field holds what it was given.
 * Re-filling is safe because a fill replaces the field's contents.
 *
 * The read back is two reads. Behind a controlled component the field is
 * written twice, by the driver and then by the app's own render, which can push
 * a stale string over what the driver typed. The second read, after the quiet
 * period, proves the value held. What counts as proof comes from the node's
 * role, because a secure field reports a mask. See `confirmationOf`.
 */
function perform(
  session: DeviceSession,
  sink: ActionSink,
  record: Extract<ActionRecord, { query: Query }>,
  options: ActionOptions | undefined,
  dispatch: (device: SessionDevice, ref: PinnedRef, budgetMs: number) => Promise<Settled>,
  write?: Write,
): Promise<void> {
  const timeout = options?.timeout ?? session.options.actionTimeout;
  const locator = describeQuery(record.query);
  return sink.step(renderTitle(record), async () => {
    await session.run(async (device) => {
      const deadline = Date.now() + timeout;
      const search = createScrollSearch(reportingScrolls(device, sink));
      let retriedStaleRef = false;
      let attempts = 0;
      let target: Query = record.query;
      let written: Confirmation | null = null;
      let lastActual: string | null = null;
      let screen: Screen = await device.capture();
      const unconfirmed = (expected: ExpectedValue): TouchpressError =>
        new TouchpressError({
          kind: 'fill-unconfirmed',
          locator,
          expected,
          actual: lastActual === null ? null : disclose(expected, lastActual),
          attempts,
          timeoutMs: timeout,
          screen: renderScreen(screen),
        });
      for (;;) {
        const resolution = resolve(screen, target);
        if (resolution.outcome === 'many') throw ambiguous(locator, resolution.nodes, screen);
        if (resolution.outcome === 'one') {
          const confirmation =
            write === undefined ? null : confirmationOf(resolution.node.role, write);
          // A confirmed write needs its quiet period inside the budget. Without room for
          // the wait, the two reads land back to back and prove nothing.
          if (
            confirmation !== null &&
            attempts > 0 &&
            deadline - Date.now() <= session.options.settleQuietMs
          ) {
            throw unconfirmed(expectedOf(confirmation));
          }
          let settled: Settled;
          try {
            settled = await dispatch(device, pin(screen, resolution.node), deadline - Date.now());
          } catch (error) {
            const failure = failureOf(error);
            if (failure?.kind === 'stale-ref' && !retriedStaleRef) {
              retriedStaleRef = true;
              screen = await device.capture();
              continue;
            }
            // A covered text field is a different problem, because the field is the target rather than a label for one.
            if (failure?.kind !== 'covered' || record.kind === 'fill') throw error;
            settled = await retarget(
              device,
              sink,
              dispatch,
              locator,
              screen,
              resolution.node,
              deadline - Date.now(),
            );
          }
          attempts += 1;
          if (!settled.settled) {
            sink.note('settle', `${renderTitle(record)} finished before the screen went quiet`);
          }
          if (confirmation === null || write === undefined) return;
          if (attempts === 1) {
            await sink.step(
              renderTitle({ kind: 'typed', typed: typedOf(resolution.node.role, write) }),
              () => Promise.resolve(),
              { box: true },
            );
          }
          // Android reports a text field's accessible name as its contents, so the
          // author's locator stops matching once a write lands. Track the node instead.
          target = identityOf(screen, resolution.node);
          written = confirmation;

          screen = await device.capture();
          lastActual = valueAt(screen, target);
          if (lastActual !== null && holds(confirmation, lastActual)) {
            await sleep(session.options.settleQuietMs);
            screen = await device.capture();
            const second = valueAt(screen, target);
            // A locator that stopped resolving says nothing about the value, so the read
            // that did resolve stands. Only a different value is evidence of a revert.
            if (second === null || holds(confirmation, second)) return;
            lastActual = second;
          }
          const left = deadline - Date.now();
          if (left <= 0) throw unconfirmed(expectedOf(confirmation));
          await sleep(Math.min(ACTION_POLL_MS, left));
          screen = await device.capture();
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          // The field was on screen when it was written, so what it holds is unknown
          // rather than the field being absent.
          if (written !== null) throw unconfirmed(expectedOf(written));
          throw new TouchpressError({
            kind: 'not-found',
            locator,
            timeoutMs: timeout,
            screen: renderScreen(screen),
            scrolled: search.trail(),
          });
        }
        // A write past its first attempt is looking for the node it already wrote, so a
        // scroll would follow a field that moved rather than reach a new one.
        if (attempts === 0 && (await search.step(screen, target, remaining))) {
          screen = await device.capture();
          continue;
        }
        await sleep(Math.min(ACTION_POLL_MS, remaining));
        screen = await device.capture();
      }
    });
  });
}

/**
 * The stop condition is the default tree, never the raw one. The raw tree says
 * which way to go, but a node it carries may still be off screen, so stopping
 * on it would hand an action a ref the user cannot reach.
 */
function scrollIntoView(
  session: DeviceSession,
  sink: ActionSink,
  query: Query,
  options: ActionOptions | undefined,
): Promise<void> {
  const timeout = options?.timeout ?? session.options.actionTimeout;
  const locator = describeQuery(query);
  return sink.step(renderTitle({ kind: 'scroll-into-view', query }), async () => {
    await session.run(async (device) => {
      const deadline = Date.now() + timeout;
      const search = createScrollSearch(reportingScrolls(device, sink));
      let screen = await device.capture();
      for (;;) {
        const resolution = resolve(screen, query);
        if (resolution.outcome === 'many') throw ambiguous(locator, resolution.nodes, screen);
        if (resolution.outcome === 'one') return;
        const remaining = deadline - Date.now();
        if (remaining <= 0 || !(await search.step(screen, query, remaining))) {
          throw new TouchpressError({
            kind: 'not-found',
            locator,
            timeoutMs: timeout,
            screen: renderScreen(screen),
            scrolled: search.trail(),
          });
        }
        screen = await device.capture();
      }
    });
  });
}

/** Every scroll a search takes is a nested step, so a report shows what an action did to reach its target. */
function reportingScrolls(device: SessionDevice, sink: ActionSink): ScrollDevice {
  return {
    captureRaw: () => device.captureRaw(),
    scroll: (direction, budgetMs) =>
      sink.step(renderTitle({ kind: 'scroll', direction }), () =>
        device.scroll(direction, budgetMs),
      ),
  };
}

/**
 * A React Native pressable splits the accessible name off the touch handler, so
 * a locator naming what a user reads can pin a node the driver refuses. The
 * control covering that node is what the finger would have hit, so the action
 * goes there and the report names it, rather than asking the author to describe
 * a node they cannot see.
 *
 * One hop only. A second refusal means the retarget was the wrong reading of
 * the screen, and repeating it would only walk further from what was asked for.
 */
async function retarget(
  device: SessionDevice,
  sink: ActionSink,
  dispatch: (device: SessionDevice, ref: PinnedRef, budgetMs: number) => Promise<Settled>,
  locator: string,
  screen: Screen,
  matched: ScreenNode,
  budgetMs: number,
): Promise<Settled> {
  const target = touchTargetFor(screen, matched);
  if (target === null) throw untappable(locator, screen);
  return await sink.step(
    renderTitle({ kind: 'retarget', target: describeNode(target) }),
    async () => {
      try {
        return await dispatch(device, pin(screen, target), budgetMs);
      } catch (error) {
        if (failureOf(error)?.kind !== 'covered') throw error;
        throw untappable(locator, screen);
      }
    },
    { box: true },
  );
}

function untappable(locator: string, screen: Screen): TouchpressError {
  return new TouchpressError({ kind: 'untappable', locator, screen: renderScreen(screen) });
}

function ambiguous(locator: string, nodes: readonly ScreenNode[], screen: Screen): TouchpressError {
  return new TouchpressError({
    kind: 'strict-mode',
    locator,
    matches: nodes.map((node) => describeNode(node)),
    screen: renderScreen(screen),
  });
}

type Write = { readonly text: string; readonly secret: boolean };

/**
 * What the written field proves about a write, and how much of that a message
 * may repeat back. Both come from the same question, so they cannot drift.
 *
 * A secure field reports one masking character per character it holds, so its
 * length is all it can attest to and all it can disclose. That still catches a
 * keyboard dropping keystrokes, because a dropped keystroke is a shorter mask.
 * `secret` is a plain field holding a credential, confirmed character by
 * character with only the reporting cut to a length.
 *
 * Android has no secure role. A password field is an `EditText` like any other,
 * and a Compose one reads back its mask, so a plain field confirms on either its
 * exact contents or a mask the length of what was typed, the same rule
 * agent-device applies when it verifies its own fill. The message still names
 * the exact value, because that is what the author asked the field to hold.
 *
 * The text is normalized the way `parseScreen` normalizes what it reads back,
 * so a run of spaces the field keeps and the tree collapses still confirms. A
 * mask keeps the raw length, because the field reports one character per key.
 */
type Confirmation =
  | { readonly kind: 'mask'; readonly length: number }
  | { readonly kind: 'secret'; readonly value: string; readonly length: number }
  | { readonly kind: 'open'; readonly value: string; readonly length: number };

function confirmationOf(role: Role, write: Write): Confirmation {
  const length = write.text.length;
  if (role === 'secure-text-field') return { kind: 'mask', length };
  const value = normalizeText(write.text);
  return write.secret ? { kind: 'secret', value, length } : { kind: 'open', value, length };
}

function holds(confirmation: Confirmation, actual: string): boolean {
  switch (confirmation.kind) {
    case 'mask':
      return isMask(actual, confirmation.length);
    case 'secret':
    case 'open':
      return actual === confirmation.value || isMask(actual, confirmation.length);
    default: {
      const never: never = confirmation;
      throw new Error(`unhandled confirmation ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Requiring one repeated character stops a placeholder of the right length, which
 * is what an untouched password field reports, from passing as a landed write.
 */
function isMask(actual: string, length: number): boolean {
  return actual.length === length && new Set(actual).size <= 1;
}

function expectedOf(confirmation: Confirmation): ExpectedValue {
  switch (confirmation.kind) {
    case 'mask':
      return { kind: 'masked', length: confirmation.length };
    case 'secret':
      return { kind: 'masked', length: confirmation.value.length };
    case 'open':
      return { kind: 'exact', value: confirmation.value };
    default: {
      const never: never = confirmation;
      throw new Error(`unhandled confirmation ${JSON.stringify(never)}`);
    }
  }
}

/** A blind type has no node to ask about secrecy, so only the caller can say. */
function typedText(text: string, options: TypeOptions | undefined): Typed {
  return options?.secret === true
    ? { kind: 'hidden', length: text.length }
    : { kind: 'text', value: text };
}

/** What the report says was typed, verbatim, which the normalized confirmation no longer holds. */
function typedOf(role: Role, write: Write): Typed {
  if (role === 'secure-text-field' || write.secret) {
    return { kind: 'hidden', length: write.text.length };
  }
  return { kind: 'text', value: write.text };
}

/** An actual value may be repeated back only as far as the expected one could be. */
function disclose(expected: ExpectedValue, actual: string): ExpectedValue {
  return expected.kind === 'masked'
    ? { kind: 'masked', length: actual.length }
    : { kind: 'exact', value: actual };
}

/** The field's current contents, or null once the locator stops resolving to exactly one node. */
function valueAt(screen: Screen, target: Query): string | null {
  const found = resolve(screen, target);
  return found.outcome === 'one' ? (found.node.value ?? '') : null;
}

/**
 * How the written node is found again on the next snapshot.
 *
 * A testId rarely names one node. SwiftUI puts one identifier on a field, its
 * placeholder, and the button under it, and the driver copies an ancestor's
 * identifier onto every inheriting descendant. The role narrows those to the
 * field, and failing that the field's position among nodes of its role stands
 * in. Never the raw tree index: the software keyboard inserts its windows at the
 * top of the tree, which shifts every index but adds no text field.
 */
function identityOf(screen: Screen, node: ScreenNode): Query {
  if (node.testId !== null) {
    const byTestId: Query = { role: node.role, testId: textMatch(node.testId, true) };
    const resolution = resolve(screen, byTestId);
    if (resolution.outcome === 'one' && resolution.node === node) return byTestId;
  }
  const byRole: Query = { role: node.role };
  const index = matchesOf(screen, byRole).indexOf(node);
  if (index === -1) throw new Error(`${node.ref} does not resolve under its own role`);
  return { ...byRole, index };
}
