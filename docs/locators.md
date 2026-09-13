# Locators

A locator is a query bound to a session. Building one performs no work. Holding one across an action is safe, because it stores a query rather than a reference to a node.

## The three factories

```ts
device.getByText('Welcome');
device.getByText(/welcome/i);
device.getByText('Welcome', { exact: true });

device.getByRole('button');
device.getByRole('button', { name: 'Sign in' });
device.getByRole('text', { name: 'Rob', exact: true });

device.getByTestId('profile-email');
```

`getByText` matches a node's accessibility name or its value, the way Playwright's own `getByText` matches text. `getByRole` matches the normalized role and, optionally, the name. `getByTestId` matches the accessibility identifier, which is what a React Native `testID` becomes, and it always matches the whole string.

## The escape hatch

`device.locator(query)` takes the raw query for anything the three factories cannot express.

```ts
device.locator({ role: 'text-field', focused: true });
device.locator({ testId: { kind: 'substring', value: 'row-' }, enabled: false });
device.locator({ where: (node) => node.rect !== null && node.rect.y > 400 });
```

A query is conjunctive. Every field narrows, and an empty query matches every node. The fields are `testId`, `name`, `value`, `role`, `enabled`, `selected`, `focused`, `where`, `filters`, and `index`. `filters` is what `.filter()` appends to and `index` is what `.first()` and `.nth(n)` set.

## Matching rules

Text matching follows Playwright. The default is a case-insensitive substring after whitespace is collapsed to single spaces. `exact: true` compares the whole string, case-sensitively, still after collapsing. A `RegExp` is tested against the collapsed string.

Whitespace is normalized on both sides of every comparison, so a label the app wrapped across two lines still matches one you typed on one line.

`getByText('Rob')` matches `rob@example.com` too, because a substring match is case-insensitive. Pass `{ exact: true }` to separate them.

## Strictness

A locator that resolves to more than one node is an error, for an action and for an assertion alike. `.not` cannot turn that into a pass, and neither can waiting, because waiting cannot make a locator less ambiguous. The failure lists every match.

```
Locator resolved to 2 nodes but an action needs exactly one.

Locator: getByText('Explore')
Matches:
  @e12 [text] "Explore"
  @e35 [button] "Explore"

Narrow it with getByRole, or take one deliberately with .first() or .nth(n).
```

Take one on purpose with `.first()` or `.nth(n)`. Negative indexes count from the end, so `.nth(-1)` is the last match.

```ts
await device.getByText('Explore').first().tap();
await device.getByRole('cell').nth(-1).tap();
```

`toHaveCount(n)` is the one matcher that is happy with many. It asks how many there are.

## When the matched node cannot be tapped

Compose, SwiftUI, and some React Native components put the text you read and the control that receives the touch on different nodes. On Android the two are often siblings, an unnamed `[button]` whose rect encloses an `[other] "Back"` next to it, and on iOS the button usually sits inside the labelled container. A locator that matched the label pins a reference the driver refuses, because that node owns no touch point outside the interactive nodes drawn over it.

`tap` and `longPress` recover from that on their own. They look on the same screen for the control that covers the matched node, preferring one inside it and taking the smallest when several qualify, then dispatch there instead. The report shows both, so a passing test still says what was really pressed.

```
tap getByText('Back')
  retarget to @e45 [button]
```

One hop only. A second refusal, or a screen offering no such control, fails instead of guessing further.

```
The matched node has no touch point of its own, and no enclosing control was found.

Locator: getByText('Back')

Name the control that receives the touch, with getByRole, or with
locator({ role: 'button', where: (node) => ... }).
```

`fill` is left alone. A refused text field is the target rather than a label for one, so retargeting would type somewhere else.

## Ancestor absorption

One case is handled for you. When several matches sit on one ancestor chain and carry the same string that the query matched on, only the deepest survives.

React Native renders a `Text` as a text node wrapped in another text node holding the same string, and a pressable as a labelled container around a button. Each pair is one thing on screen, so `getByRole('text', { name: 'Rob' })` finds one node rather than two.

Matches in disjoint subtrees stay distinct. A heading that says "Explore" and a tab button that says "Explore" are two things, and the failure says so.

A query that constrains no text falls back to the node's own name for this comparison, so `getByRole('button')` does not collapse two nested buttons that say different things.

## Filtering

`filter` narrows the matches a locator already makes.

```ts
device.getByRole('other').filter({ hasText: 'Dev tools' });
device.getByRole('cell').filter({ hasNotText: 'Archived' });
device.getByRole('cell').filter({ has: device.getByRole('switch') });
device.getByRole('other').filter({ hasNot: device.getByRole('image') });
```

There are four options.

- `hasText` keeps a match when the node itself, or anything in its subtree, has a name or a value matching the text.
- `hasNotText` keeps the ones `hasText` would drop.
- `has` keeps a match when another locator resolves to something strictly inside its subtree. The node itself does not count.
- `hasNot` keeps the ones `has` would drop.

The asymmetry is deliberate, and it is the one Playwright has. `hasText` includes the node's own text. `has` means a descendant.

Text follows the same rules as `getByText`. The default is a case-insensitive substring after whitespace is collapsed, and a `RegExp` works too. There is no `exact` option, so anchor a `RegExp` with `^` and `$` when you need a whole string.

Every option narrows and so does every call, so these two mean the same thing.

```ts
device.getByRole('cell').filter({ hasText: 'Rob', hasNot: device.getByRole('switch') });
device
  .getByRole('cell')
  .filter({ hasText: 'Rob' })
  .filter({ hasNot: device.getByRole('switch') });
```

The locator inside `has` is matched on its own terms. Its fields, its own filters and its own absorption all apply. Its `.first()` and `.nth(n)` do not, because the question is whether anything in the subtree matches rather than which one.

## Filtering by text collapses the containers around it

A `hasText` filter names a string on screen, so ancestor absorption treats a chain of candidates holding that string as one thing and keeps the innermost. Candidates in disjoint subtrees stay distinct, the way they do for any other query.

That is what makes the filter usable on a React Native tree, where almost every container reports role `other`. Three nested containers on the sample app's home screen hold "Dev tools", and their own names are all different.

```
@e3  [other]
  @e4  [other] "Tab Bar"
    @e5  [other] "Live from the cloud"
      @e19 [text] "Dev tools"
```

`getByRole('other').filter({ hasText: 'Dev tools' })` resolves to `@e5`, the card that holds the text, rather than to every wrapper around it.

`hasNotText`, `has` and `hasNot` leave the compared string alone. They name structure or an absence rather than a string on screen. Absorption still runs on whatever the query would have compared without them, so a chain of same-named containers still collapses and differently named ones stay apart. That is why `getByRole('other').filter({ has: device.getByRole('button') })` can resolve to several siblings.

## Roles

Roles are normalized to one vocabulary across iOS, macOS, and Android, spelled the way `agent-device snapshot` prints them, so a failure message and a manual snapshot read alike. macOS reports the same types as iOS, so the two share a column.

| role                | iOS and macOS types it covers                         | Android classes it covers                                             |
| ------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| `application`       | `Application`                                         |                                                                       |
| `window`            | `Window`                                              |                                                                       |
| `button`            | `Button`, `Tab`                                       | `Button`, `ImageButton`                                               |
| `text`              | `StaticText`, `TextView`                              | `TextView`                                                            |
| `text-field`        | `TextField`, `SearchField`                            | `EditText`                                                            |
| `secure-text-field` | `SecureTextField`                                     |                                                                       |
| `link`              | `Link`                                                |                                                                       |
| `image`             | `Image`, `Icon`                                       | `ImageView`                                                           |
| `switch`            | `Switch`, `Toggle`                                    | `Switch`, `CheckBox`                                                  |
| `slider`            | `Slider`                                              | `SeekBar`                                                             |
| `tab-bar`           | `TabBar`                                              |                                                                       |
| `scroll-area`       | `ScrollView`, `ScrollArea`, `Table`, `CollectionView` | `ScrollView`, `HorizontalScrollView`, `RecyclerView`                  |
| `cell`              | `Cell`                                                |                                                                       |
| `alert`             | `Alert`, `Sheet`                                      |                                                                       |
| `other`             | `Other`, and anything unrecognized                    | `ViewGroup`, `FrameLayout`, `LinearLayout`, and anything unrecognized |

`secure-text-field` is iOS and macOS only. An Android password field is an `EditText`, resolves as `text-field`, and its fill confirms on the masked read-back, as [`fill`](./basics.md) describes.

`other` is a real role, not a failure signal. React Native emits many labelled container views with no semantic type. The platform spelling is kept on each node as `rawType` if you need it through `device.screen()`.

On macOS, XCUI adds close, full-screen, and minimize buttons to every window. Those nodes carry `windowChrome: true`, and no locator matches them, so `getByRole('button')` stays strict. They still appear in `screen.txt`.

The Android half of the table was read off a booted API 36 emulator running the sample app. React Native reports fully qualified class names, so the entries are `android.widget.Button`, `android.view.ViewGroup` and so on. Every React Native `View` reports `android.view.ViewGroup`, the containers carrying a `testID` included, which is why most of an Android tree is `other`.

The rows for widgets the sample app never renders, `ImageButton`, `Switch`, `CheckBox`, `SeekBar`, `HorizontalScrollView` and `RecyclerView`, are still a guess. Anything unrecognized falls through to `other`, which is always legal.

## An Android text field is named by its contents

On Android the accessibility name of an `EditText` is its text, or its placeholder while the field is empty. iOS keeps the label and the value apart. Android does not.

```
empty    @e24 [text-field] "Email"             value "Email"
filled   @e24 [text-field] "rob@example.com"   value "rob@example.com"
```

So `getByRole('text-field', { name: 'Email' })` finds that field while it is empty and stops matching the moment anything is typed into it. Name a field by its `testID` when you need a locator that survives the write.

`fill` is unaffected. It confirms what it wrote against the node it wrote to rather than against the locator you named it with, so a name-shaped locator is still a legal way to fill a field.

## A SwiftUI identifier can name several siblings

`getByTestId` is the sharpest locator in a React Native tree, where a `testID` lands on one view. It is not sharp in a SwiftUI one. SwiftUI's `.accessibilityIdentifier` applied to a container propagates to every accessibility element inside it, so one identifier in the source can be several nodes on screen.

Clerk's native sign-in view is the case that found this. It puts the identifier on the `HStack` wrapping a field, and the password step reports three siblings carrying it.

```
@e64 [text] "Enter your password"        #clerk.auth.signIn.password
@e65 [secure-text-field]                 #clerk.auth.signIn.password
@e66 [button] "Hide"                     #clerk.auth.signIn.password
```

They sit on one parent rather than one ancestor chain, so absorption leaves them alone and `getByTestId('clerk.auth.signIn.password')` is ambiguous. `agent-device` refuses the same selector with `AMBIGUOUS_MATCH`, so this is the driver's reading too, not touchpress's alone.

Narrow with the role, which is what separates them.

```ts
device.locator({
  testId: { kind: 'exact', value: 'clerk.auth.signIn.password' },
  role: 'secure-text-field',
});
```

A field can also be missing from the tree entirely. SwiftUI animates a control to near-zero opacity rather than removing it, and an element that faint is left out of the accessibility tree, so Clerk's email field appears only once something focuses it. Tap the placeholder, which is the node that carries the identifier while the field is hidden, and the field arrives.

## A locator only ever resolves against what is on screen

Every locator resolves against the driver's visible-first tree. A row a scroll container has moved out of the window is not in it until something scrolls, and actions scroll for themselves. [Basics](basics.md) covers `scrollIntoView()`.

The driver's full tree is a different thing. On iOS it carries every row of a list with rects past the container that clips them, which is how a scroll search knows which way to go. On Android it carries only wrapper views and no extra rows, so the search falls back to the container's own hint that it holds content above or below. Neither tree changes what a locator matches. A search reads the full tree to choose a direction and always stops on the visible one.
