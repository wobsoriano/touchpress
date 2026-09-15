/**
 * The runner-independent surface. No module under `core/` imports
 * `@playwright/test` or `agent-device`, and no agent-device type crosses this
 * line. The one exception is this entry's re-export of `preflight`, which needs
 * a concrete driver.
 */

export { createDevice } from './device.ts';
export type {
  ActionOptions,
  BackOptions,
  Device,
  FillOptions,
  FilterOptions,
  Keyboard,
  Locator,
  RoleOptions,
  TextOptions,
  TypeOptions,
} from './device.ts';

export { describeCheck, evaluate } from './checks.ts';
export type { Check, CheckName, Verdict } from './checks.ts';

export { deviceNameForSlot, parseDeviceOptions, TOUCHPRESS_DEFAULTS } from './config.ts';
export type {
  CloudOptions,
  DeviceChoice,
  ReadyQuery,
  ResolvedOptions,
  Target,
  TouchpressOptions,
} from './config.ts';

export type {
  BackMode,
  Binding,
  CaptureOptions,
  DeviceDriver,
  DeviceFailure,
  DeviceInfo,
  DeviceSelection,
  OpenRequest,
  ScrollDirection,
  Settled,
  Tree,
} from './driver.ts';

export { TouchpressError } from './errors.ts';
export type { ErrorInfo, ExpectedValue } from './errors.ts';

export { captureEvidence } from './evidence.ts';

export { preflight } from '../preflight.ts';
export type { PreflightDevice, PreflightReport } from '../preflight.ts';

export { formatFailure, probe } from './probe.ts';
export type { ProbeOptions, ProbeResult, ProbeTarget } from './probe.ts';

export { describeQuery, normalizeText, textMatch } from './query.ts';
export type { Filter, Query, Role, TextMatch } from './query.ts';

export { compareScreenshot, cropScreenshot, relativeTo, sizeOf, toPixelBox } from './screenshot.ts';
export type { Comparison, CompareOptions, PixelBox, Size } from './screenshot.ts';

export { createScrollSearch, directionToward } from './scroll.ts';
export type { ScrollDevice, ScrollSearch, ScrollTrail } from './scroll.ts';

export { renderTitle, silentSink } from './report.ts';
export type { ActionRecord, ActionSink, EvidenceFile, StepOptions, Typed } from './report.ts';

export { parseScreen, renderScreen, resolve } from './screen.ts';
export type {
  PinnedRef,
  Platform,
  RawSnapshot,
  Rect,
  Resolution,
  Screen,
  ScreenNode,
} from './screen.ts';

export { openSession, sessionName } from './session.ts';
export type { DeviceSession, OpenSessionInput, SessionState } from './session.ts';
