import type { Target } from './config.ts';
import type { PinnedRef, Platform, RawSnapshot } from './screen.ts';

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/**
 * `in-app` is the navigation control the app draws. `system` is the platform
 * gesture or key, which iOS does not have.
 */
export type BackMode = 'in-app' | 'system';

/**
 * A session binds on its first command, so this rides on `open` and on every
 * command after it. A call sent without selection lands on whichever device the
 * daemon picks, which is not necessarily the one under test.
 */
export type DeviceSelection = {
  readonly platform: Platform;
  readonly name: string | null;
  /** Where the session runs. A driver reads it to skip what only a local device supports. */
  readonly target: Target;
};

/** One device the driver can see. Only the fields preflight needs, so no agent-device device shape crosses here. */
export type DeviceInfo = {
  readonly id: string;
  readonly name: string;
  readonly booted: boolean;
};

/** The session name and the device selection ride on the driver itself, so an open cannot name a different one. */
export type OpenRequest = {
  readonly app: string;
  readonly relaunch: boolean;
  /** A deep link to launch the app with, or null to launch it plainly. */
  readonly url: string | null;
  /**
   * The artifact to install before launching, or null when the app is already on the device.
   * A freshly allocated hosted instance carries no app, so its first open has to put one there.
   */
  readonly install: string | null;
};

/** Proof that a device is bound. Only `open` mints one, so a believed binding cannot drift from a real one. */
export type Binding = {
  readonly session: string;
  readonly platform: Platform;
  readonly deviceLabel: string;
  readonly appId: string;
  readonly stateDir: string | null;
  /** What lets a driver reach the device with a tool of its own. Null when the open response named none. */
  readonly udid: string | null;
};

export type Settled = {
  readonly settled: boolean;
  readonly waitedMs: number;
};

/**
 * Why an operation failed, in this library's vocabulary. Translated once, in
 * `driver/agent-device.ts`, so a test author never reads a raw driver code.
 */
export type DeviceFailure =
  | { readonly kind: 'device-busy'; readonly owner: string | null; readonly detail: string }
  | { readonly kind: 'device-missing'; readonly detail: string }
  | { readonly kind: 'app-missing'; readonly detail: string }
  | { readonly kind: 'session-rebound'; readonly boundTo: string; readonly detail: string }
  | { readonly kind: 'stale-ref'; readonly detail: string }
  | { readonly kind: 'ambiguous'; readonly detail: string }
  /**
   * The pinned node owns no touch point outside the interactive nodes drawn
   * over it, so the driver refused rather than guess which one was meant.
   */
  | { readonly kind: 'covered'; readonly detail: string }
  | { readonly kind: 'timeout'; readonly detail: string }
  | {
      readonly kind: 'unknown';
      readonly code: string;
      readonly detail: string;
      readonly logPath: string | null;
    };

export type SettleOptions = {
  readonly settleQuietMs: number;
  readonly timeoutMs: number;
};

/**
 * `default` is the driver's visible-first view, which every locator resolves
 * against. `raw` is the full provider tree. On iOS it carries the nodes a scroll
 * container moved out of the window, which is how a target is located before it
 * is on screen. On Android it carries no off-screen content, only the wrappers
 * the default view collapses away.
 */
export type Tree = 'default' | 'raw';

export type CaptureOptions = {
  readonly timeoutMs: number;
  readonly tree: Tree;
};

/**
 * Nothing crossing this port is a transport type, which is what lets the core be
 * unit-tested against a captured snapshot.
 *
 * Contract every implementation owes the core. `open` converges when called on
 * an already-open session. Mutations take a `PinnedRef` and never a selector, so
 * the driver's own matcher is never a second opinion on which node was meant.
 * Every failure throws a `TouchpressError` carrying a `DeviceFailure`.
 */
export type DeviceDriver = {
  /** Takes no session, so it is the one call that binds nothing. */
  listDevices(): Promise<readonly DeviceInfo[]>;
  open(request: OpenRequest): Promise<Binding>;
  capture(options: CaptureOptions): Promise<RawSnapshot>;
  screenshot(path: string): Promise<string>;
  tap(ref: PinnedRef, options: SettleOptions): Promise<Settled>;
  longPress(ref: PinnedRef, durationMs: number, options: SettleOptions): Promise<Settled>;
  fill(ref: PinnedRef, text: string, options: SettleOptions): Promise<Settled>;
  /** Takes no target, because the platform decides what goes back. */
  back(mode: BackMode, options: SettleOptions): Promise<Settled>;
  /**
   * Types into whatever holds focus. The one mutation with no `PinnedRef`,
   * because a field the app focused for itself may carry nothing to select on.
   */
  type(text: string, options: SettleOptions): Promise<Settled>;
  /**
   * Discards the app's stored state. Whether that reaches every store the app
   * writes to is the driver's problem, not the core's.
   */
  clearAppState(app: string): Promise<void>;
  /**
   * Resets the device's keychain, which on an iOS simulator is shared by every
   * app on it. Kept apart from `clearAppState` for that reason. A no-op on a
   * platform whose app data clear already covers the app's secure store.
   */
  resetKeychain(): Promise<void>;
  /** Returns nothing because the driver's scroll response carries no settle observation. */
  scroll(direction: ScrollDirection, options: SettleOptions): Promise<void>;
  dismissDevOverlay(): Promise<void>;
  /** Ends a session. Names one explicitly so a leftover owned by another run can be reclaimed. */
  close(session: string): Promise<void>;
};
