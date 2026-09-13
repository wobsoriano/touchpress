import {
  describeMatch,
  matchesText,
  normalizeText,
  type Filter,
  type Query,
  type Role,
  type TextMatch,
} from './query.ts';

export type Platform = 'ios' | 'android' | 'macos';

export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/**
 * One node of a parsed screen, not the driver's snapshot node: `label` becomes
 * `name`, `identifier` becomes `testId`, and `type` is normalized into `role`
 * with the platform spelling kept as `rawType`.
 *
 * Invariant: `parent` links form a forest rooted at nodes whose `parentIndex`
 * was absent, built once at parse time so an ancestor walk stays O(depth).
 */
export type ScreenNode = {
  readonly ref: string;
  readonly index: number;
  readonly parent: ScreenNode | null;
  readonly depth: number;
  readonly role: Role;
  readonly rawType: string;
  readonly name: string | null;
  readonly value: string | null;
  readonly testId: string | null;
  readonly rect: Rect | null;
  readonly enabled: boolean;
  readonly selected: boolean;
  readonly focused: boolean;
  /**
   * The driver's hints that a scroll container holds content out of the window.
   * The only thing that says which way to scroll on a platform whose raw tree
   * stops at the window.
   */
  readonly hiddenContentAbove: boolean;
  readonly hiddenContentBelow: boolean;
};

/**
 * A frozen observation of the device at one instant.
 *
 * Invariant: a screen is never refreshed in place. Every state-changing
 * command advances the driver's ref generation, so a screen captured before
 * one can only mint refs the driver will reject.
 */
export type Screen = {
  readonly nodes: readonly ScreenNode[];
  readonly generation: number | null;
  readonly appId: string | null;
  readonly truncated: boolean;
  readonly capturedAt: number;
};

declare const pinnedRefBrand: unique symbol;

/**
 * A ref pinned to the generation it was minted from, in the driver's
 * `@e12~s776575` form. The driver rejects a pin from a superseded generation
 * before dispatch, which turns a silent mistap into a recoverable failure.
 */
export type PinnedRef = string & { readonly [pinnedRefBrand]: true };

export type Resolution =
  | { readonly outcome: 'one'; readonly node: ScreenNode }
  | { readonly outcome: 'none'; readonly nearest: readonly ScreenNode[] }
  | { readonly outcome: 'many'; readonly nodes: readonly ScreenNode[] };

/**
 * The structural shape of the driver's snapshot response. Declared here rather
 * than imported so the core never depends on `agent-device`. The real
 * `CaptureSnapshotResult` satisfies it and so does a JSON fixture.
 */
export type RawSnapshot = {
  readonly nodes: ReadonlyArray<{
    readonly ref: string;
    readonly index: number;
    readonly type?: string;
    readonly role?: string;
    readonly label?: string;
    readonly value?: string;
    readonly identifier?: string;
    readonly rect?: Rect;
    readonly enabled?: boolean;
    readonly selected?: boolean;
    readonly focused?: boolean;
    readonly hintShowing?: boolean;
    readonly hiddenContentAbove?: boolean;
    readonly hiddenContentBelow?: boolean;
    readonly depth?: number;
    readonly parentIndex?: number;
    readonly inheritsLabel?: true;
    readonly inheritsIdentifier?: true;
  }>;
  readonly truncated?: boolean;
  readonly appBundleId?: string;
  readonly refsGeneration?: number;
};

const IOS_ROLES: Readonly<Record<string, Role>> = {
  Application: 'application',
  Window: 'window',
  Button: 'button',
  StaticText: 'text',
  TextView: 'text',
  TextField: 'text-field',
  SearchField: 'text-field',
  SecureTextField: 'secure-text-field',
  Link: 'link',
  Image: 'image',
  Icon: 'image',
  Switch: 'switch',
  Toggle: 'switch',
  Slider: 'slider',
  TabBar: 'tab-bar',
  Tab: 'button',
  ScrollView: 'scroll-area',
  ScrollArea: 'scroll-area',
  Table: 'scroll-area',
  CollectionView: 'scroll-area',
  Cell: 'cell',
  Alert: 'alert',
  Sheet: 'alert',
  Other: 'other',
};

/**
 * Observed on a booted Android emulator (API 36) snapshotting this repo's React
 * Native 0.86 sample app, except the trailing widget block, which this app never
 * renders and stays a plausible guess. `android.view.ViewGroup` is what every
 * React Native `View` reports, testID containers included, so it is stated here
 * rather than left to the `other` fall-through in `roleOf`. A password field is
 * an `EditText` too. agent-device 0.20.10 parses the tree's `password` flag but
 * does not emit it, so once it does, map it to `secure-text-field` here.
 */
const ANDROID_ROLES: Readonly<Record<string, Role>> = {
  'android.widget.Button': 'button',
  'android.widget.TextView': 'text',
  'android.widget.EditText': 'text-field',
  'android.widget.ImageView': 'image',
  'android.widget.ScrollView': 'scroll-area',
  'android.view.ViewGroup': 'other',
  'android.widget.FrameLayout': 'other',
  'android.widget.LinearLayout': 'other',

  'android.widget.ImageButton': 'button',
  'android.widget.Switch': 'switch',
  'android.widget.CheckBox': 'switch',
  'android.widget.SeekBar': 'slider',
  'android.widget.HorizontalScrollView': 'scroll-area',
  'androidx.recyclerview.widget.RecyclerView': 'scroll-area',
};

/** macOS XCUI reports the same raw types as iOS. */
const ROLES: Readonly<Record<Platform, Readonly<Record<string, Role>>>> = {
  ios: IOS_ROLES,
  android: ANDROID_ROLES,
  macos: IOS_ROLES,
};

function roleOf(rawType: string, platform: Platform): Role {
  const table = ROLES[platform];
  const direct = table[rawType];
  if (direct !== undefined) return direct;
  const short = rawType.slice(rawType.lastIndexOf('.') + 1);
  return table[short] ?? 'other';
}

/**
 * The parse boundary. Everything past it trusts its types.
 *
 * `inheritsLabel` and `inheritsIdentifier` mean the driver omitted a value that
 * string-equals the nearest ancestor's, so those are restored here rather than
 * leaving a hole a matcher would read as absent.
 */
export function parseScreen(raw: RawSnapshot, platform: Platform): Screen {
  const nodes: ScreenNode[] = [];
  const byIndex = new Map<number, ScreenNode>();
  for (const source of raw.nodes) {
    const parent =
      source.parentIndex === undefined ? null : (byIndex.get(source.parentIndex) ?? null);
    const rawType = source.type ?? source.role ?? 'Other';
    const node: ScreenNode = {
      ref: source.ref.startsWith('@') ? source.ref : `@${source.ref}`,
      index: source.index,
      parent,
      depth: source.depth ?? (parent === null ? 0 : parent.depth + 1),
      role: roleOf(rawType, platform),
      rawType,
      name: inherited(source.label, source.inheritsLabel, parent, (a) => a.name),
      value: parsedValue(source),
      testId: inherited(source.identifier, source.inheritsIdentifier, parent, (a) => a.testId),
      rect: source.rect ?? null,
      enabled: source.enabled ?? true,
      selected: source.selected ?? false,
      focused: source.focused ?? false,
      hiddenContentAbove: source.hiddenContentAbove ?? false,
      hiddenContentBelow: source.hiddenContentBelow ?? false,
    };
    nodes.push(node);
    byIndex.set(node.index, node);
  }
  return Object.freeze({
    nodes: Object.freeze(nodes),
    generation: raw.refsGeneration ?? null,
    appId: raw.appBundleId ?? null,
    truncated: raw.truncated ?? false,
    capturedAt: Date.now(),
  });
}

/**
 * On Android a field showing its hint reports the hint as its `value`, so the
 * flag is the only thing separating an empty field from one a user typed into.
 * agent-device 0.20.10's Android snapshot helper does not emit `hintShowing`
 * yet, which is why no fixture on disk carries it.
 */
function parsedValue(source: RawSnapshot['nodes'][number]): string | null {
  if (source.hintShowing === true) return '';
  return source.value === undefined ? null : normalizeText(source.value);
}

function inherited(
  own: string | undefined,
  inherits: true | undefined,
  parent: ScreenNode | null,
  read: (ancestor: ScreenNode) => string | null,
): string | null {
  if (own !== undefined) return normalizeText(own);
  if (inherits !== true) return null;
  for (let ancestor = parent; ancestor !== null; ancestor = ancestor.parent) {
    const value = read(ancestor);
    if (value !== null) return value;
  }
  return null;
}

/**
 * The single resolver, shared by actions and assertions so the two can never
 * disagree about which node was meant. Rule order: match every query field,
 * apply every `.filter()`, absorb ancestors, then `index`.
 *
 * Ancestor absorption drops a match when a descendant match carries the same
 * string the query matched on. On the sample app an `[other]` container and its
 * `[text]` child both carry "Live from the cloud", which is one thing on screen.
 * Matches in disjoint subtrees stay distinct, so "Explore" on the Explore screen
 * is still the heading and the tab button.
 */
export function resolve(screen: Screen, query: Query): Resolution {
  const distinct = matchesOf(screen, query);
  if (query.index !== undefined) {
    const picked = distinct.at(query.index);
    if (picked === undefined) return { outcome: 'none', nearest: nearestTo(screen, query) };
    return { outcome: 'one', node: picked };
  }
  const first = distinct[0];
  if (first === undefined) return { outcome: 'none', nearest: nearestTo(screen, query) };
  if (distinct.length > 1) return { outcome: 'many', nodes: distinct };
  return { outcome: 'one', node: first };
}

/**
 * Everything a query matches, before `index` and before strictness. `resolve`
 * and the `has` filters share it, so an inner query means what the same locator
 * would mean on its own.
 */
export function matchesOf(screen: Screen, query: Query): readonly ScreenNode[] {
  const matched = screen.nodes.filter(
    (node) =>
      matchesQuery(node, query) &&
      (query.filters ?? []).every((filter) => matchesFilter(screen, node, filter)),
  );
  return absorbAncestors(matched, query);
}

/** `hasText` includes the candidate's own text, while `has` needs a strict descendant. Mirrors Playwright. */
function matchesFilter(screen: Screen, node: ScreenNode, filter: Filter): boolean {
  if (filter.hasText !== undefined && !subtreeHasText(screen, node, filter.hasText)) return false;
  if (filter.hasNotText !== undefined && subtreeHasText(screen, node, filter.hasNotText)) {
    return false;
  }
  if (filter.has !== undefined && !containsMatch(screen, node, filter.has)) return false;
  if (filter.hasNot !== undefined && containsMatch(screen, node, filter.hasNot)) return false;
  return true;
}

function subtreeHasText(screen: Screen, candidate: ScreenNode, match: TextMatch): boolean {
  return screen.nodes.some(
    (node) =>
      (node === candidate || isDescendant(node, candidate)) &&
      (matchesText(match, node.name) || matchesText(match, node.value)),
  );
}

function containsMatch(screen: Screen, candidate: ScreenNode, inner: Query): boolean {
  return matchesOf(screen, inner).some((node) => isDescendant(node, candidate));
}

function matchesQuery(node: ScreenNode, query: Query): boolean {
  if (query.role !== undefined && node.role !== query.role) return false;
  if (query.testId !== undefined && !matchesText(query.testId, node.testId)) return false;
  if (query.value !== undefined && !matchesText(query.value, node.value)) return false;
  if (
    query.name !== undefined &&
    !matchesText(query.name, node.name) &&
    !matchesText(query.name, node.value)
  ) {
    return false;
  }
  if (query.enabled !== undefined && node.enabled !== query.enabled) return false;
  if (query.selected !== undefined && node.selected !== query.selected) return false;
  if (query.focused !== undefined && node.focused !== query.focused) return false;
  if (query.where !== undefined && !query.where(node)) return false;
  return true;
}

/**
 * The string the query matched this node on. Two nodes on one ancestor chain
 * sharing it are one thing on screen. A query that constrains no text falls back
 * to the node's name, so `getByRole('button')` does not collapse two nested
 * buttons that say different things.
 *
 * A `hasText` filter names a string on screen, so it contributes the same
 * pattern to every candidate and collapses a chain to the innermost container
 * holding that text. Almost every React Native container reports role `other`,
 * so without this `getByRole('other').filter({ hasText })` would match every
 * wrapper rather than the row the author meant. `hasNotText`, `has` and `hasNot`
 * name structure or an absence, so they contribute nothing.
 */
function matchedText(node: ScreenNode, query: Query): string {
  const parts: string[] = [];
  if (query.testId !== undefined) parts.push(node.testId ?? '');
  if (query.value !== undefined) parts.push(node.value ?? '');
  if (query.name !== undefined) parts.push(node.name ?? node.value ?? '');
  for (const filter of query.filters ?? []) {
    if (filter.hasText !== undefined) parts.push(describeMatch(filter.hasText));
  }
  return parts.length === 0 ? (node.name ?? '') : parts.join(' ');
}

function absorbAncestors(matched: readonly ScreenNode[], query: Query): readonly ScreenNode[] {
  return matched.filter(
    (candidate) =>
      !matched.some(
        (other) =>
          other !== candidate &&
          isDescendant(other, candidate) &&
          matchedText(other, query) === matchedText(candidate, query),
      ),
  );
}

/** `tab-bar` is left out because it is a container of buttons rather than a control that takes the touch. */
const INTERACTIVE_ROLES: ReadonlySet<Role> = new Set<Role>([
  'button',
  'link',
  'switch',
  'slider',
  'text-field',
  'secure-text-field',
  'cell',
]);

type Candidate = { readonly node: ScreenNode; readonly rect: Rect };

/**
 * The control a tap on `node` would really land on, or null when the screen
 * offers none.
 *
 * A React Native pressable puts the accessible name on one node and the touch
 * handler on another. On Android the two are siblings, so a locator that
 * matched the label pins a ref that owns no touch point of its own. The button
 * drawn under the label is the thing a finger hits, and its rect is what says
 * so.
 *
 * A descendant wins over an enclosing node, because a control inside the
 * matched node is what that node was labelling. Among several, the smallest
 * wins, so a row of buttons inside one card does not hand back the card.
 */
export function touchTargetFor(screen: Screen, node: ScreenNode): ScreenNode | null {
  const candidates: Candidate[] = [];
  for (const other of screen.nodes) {
    if (other === node || !other.enabled || !INTERACTIVE_ROLES.has(other.role)) continue;
    if (other.rect !== null) candidates.push({ node: other, rect: other.rect });
  }
  const inside = smallest(candidates.filter((candidate) => isDescendant(candidate.node, node)));
  if (inside !== null) return inside;
  const own = node.rect;
  if (own === null) return null;
  return smallest(candidates.filter((candidate) => encloses(candidate.rect, own)));
}

function encloses(outer: Rect, inner: Rect): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function smallest(candidates: readonly Candidate[]): ScreenNode | null {
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (best === null || areaOf(candidate.rect) < areaOf(best.rect)) best = candidate;
  }
  return best === null ? null : best.node;
}

function areaOf(rect: Rect): number {
  return rect.width * rect.height;
}

export function isDescendant(node: ScreenNode, ancestor: ScreenNode): boolean {
  for (let walk = node.parent; walk !== null; walk = walk.parent) {
    if (walk === ancestor) return true;
  }
  return false;
}

/** The named nodes closest to what the query asked for. A miss is usually a wording drift. */
function nearestTo(screen: Screen, query: Query): readonly ScreenNode[] {
  const wanted = wantedText(query);
  const named = screen.nodes.filter((node) => node.name !== null || node.testId !== null);
  if (wanted === null) return named.slice(0, 5);
  const target = wanted.toLowerCase();
  return named
    .map((node) => ({
      node,
      score: overlap(target, (node.name ?? node.testId ?? '').toLowerCase()),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((entry) => entry.node);
}

function wantedText(query: Query): string | null {
  const asked = (query.filters ?? []).map((filter) => filter.hasText);
  for (const match of [query.name, query.testId, query.value, ...asked]) {
    if (match !== undefined && match.kind !== 'regex') return match.value;
  }
  return null;
}

function overlap(wanted: string, candidate: string): number {
  const words = wanted.split(' ').filter((word) => word.length > 2);
  const hits = words.filter((word) => candidate.includes(word)).length;
  if (hits > 0) return hits / words.length;
  return candidate.includes(wanted) || wanted.includes(candidate) ? 0.5 : 0;
}

/**
 * With a generation this is the driver's `@e12~s776575` form, which the driver
 * rejects once that generation is superseded. Without one the bare ref is still
 * correct, because the caller acts on the very next command and a frame
 * authorizes the refs it just emitted. Weaker, not wrong, so this cannot fail.
 */
export function pin(screen: Screen, node: ScreenNode): PinnedRef {
  const ref = screen.generation === null ? node.ref : `${node.ref}~s${String(screen.generation)}`;
  return ref as PinnedRef;
}

/**
 * The one tree renderer, used by failure messages and by the `screen.txt`
 * attachment so terminal and report agree. The vocabulary is the CLI's own
 * `[role] "label"` form.
 */
export function renderScreen(screen: Screen, options?: { readonly maxNodes?: number }): string {
  const max = options?.maxNodes ?? screen.nodes.length;
  const lines = screen.nodes.slice(0, max).map((node) => renderNode(node));
  if (screen.nodes.length > max) {
    lines.push(`  ... ${String(screen.nodes.length - max)} more nodes`);
  }
  return lines.join('\n');
}

function renderNode(node: ScreenNode): string {
  const indent = '  '.repeat(node.depth);
  const name = node.name === null ? '' : ` "${node.name}"`;
  const testId = node.testId === null ? '' : ` #${node.testId}`;
  const flags = [
    node.selected ? 'selected' : null,
    node.focused ? 'focused' : null,
    node.enabled ? null : 'disabled',
    node.hiddenContentAbove ? 'more above' : null,
    node.hiddenContentBelow ? 'more below' : null,
  ]
    .filter((flag) => flag !== null)
    .map((flag) => ` [${flag}]`)
    .join('');
  return `${indent}${node.ref} [${node.role}]${name}${testId}${flags}`;
}
