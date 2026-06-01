# Merge Rules

This extension suggests merges only when moving swimmers into a predefined merge target can reduce the number of heats.

## Merge Targets

A merge target is an event whose event number ends with a letter, such as `1A`, `5B`, or `12C`.

Regular numbered events, such as `1`, `5`, or `12`, are never used as merge targets.

Letter-suffixed events are treated as targets only. They are never used as source events.

If compatible source events could save heats but no loaded merge target can accept them, the extension can suggest the target event metadata to add to the meet template. The suggestion uses the same compatibility, source-group, gender-balance, and heat-saving rules as normal merge opportunities.

## Compatible Sources

A source event can merge into a target only when all of these are true:

- The source is not the target itself.
- The source event number does not end with a letter.
- Both events have stroke, distance, and age metadata.
- Stroke matches.
- Distance matches.
- The target age range fully contains the source age range.
- The target gender is either the same as the source gender, or the target gender is mixed.

For example, a `10 & Under` mixed freestyle target can accept `6 & Under Boys`, `7-8 Girls`, and `9-10 Boys` freestyle sources. A `7-8 Boys` target cannot accept a `9-10 Boys` source or a `7-8 Girls` source.

## Source Groups

The extension suggests merges from groups of source events, not from a single source event.

A suggested merge must include at least two non-empty source events.

Source groups are built from contiguous age runs. For example:

- `6 & Under + 7-8` is contiguous.
- `7-8 + 9-10` is contiguous.
- `6 & Under + 7-8 + 9-10` is contiguous.
- `6 & Under + 9-10` is not contiguous unless the matching `7-8` event exists in the loaded meet data.

Empty events can bridge an age run, but empty events are not moved. For example, if `7-8` exists but has no swimmers, then `6 & Under + 9-10` can still be considered a contiguous run through `7-8`.

## Boys and Girls

Boys-only source groups can merge into a boys target or a mixed target.

Girls-only source groups can merge into a girls target or a mixed target.

Mixed boys/girls source groups must be balanced by age. If a selected age group includes boys, the matching girls event for that same age must also be selected or must be empty. The same rule applies in the other direction.

For example:

- `7-8 Boys + 7-8 Girls` is balanced.
- `7-8 Boys + 9-10 Girls` is not balanced.
- `7-8 Boys + 9-10 Girls` can be allowed if the compatible `7-8 Girls` and `9-10 Boys` events exist but are empty.

## Heat Savings

A merge is suggested only if it saves at least one heat.

The extension compares:

- current heats in all selected source events, plus current heats already in the target
- against the heats needed after all selected source swimmers and existing target swimmers are combined

The current heat count comes from the loaded Meet Maestro heat resources. It is not recalculated from swimmer count alone.

If compatible source events would require the same number of heats after merging, no opportunity is shown.

## Multiple Options For One Target

The same target can have multiple suggested merge options.

For example, if `6 & Under`, `7-8`, and `9-10` can all merge into `10 & Under`, the extension may show:

- `6 & Under + 7-8 -> 10 & Under`
- `7-8 + 9-10 -> 10 & Under`
- `6 & Under + 7-8 + 9-10 -> 10 & Under`

The larger option is hidden only when a smaller subset saves the same number of heats or more.

For example, if `6 & Under + 7-8` saves one heat and `6 & Under + 7-8 + 9-10` also saves one heat, the larger option is hidden.

If the larger option saves more heats than every smaller subset, it remains visible.

## Missing Target Suggestions

When a heat-saving source group has no compatible letter-suffixed target, the extension may show a non-actionable suggestion for the event to add.

The suggested target uses:

- the same stroke and distance as the sources
- the narrowest age range that contains the selected sources
- a gender-specific target for boys-only or girls-only groups
- a mixed target for balanced boys/girls groups

Suggestions are hidden when an existing merge target can already accept that source group.

## More Specific Targets

When two targets can accept the same sources and save the same number of heats, the extension prefers the more specific target.

A target is more specific when it has:

- a narrower age range, or
- a specific gender instead of mixed

For example, if both `10 & Under Boys` and `10 & Under Mixed` can accept the same boys-only sources with the same heat savings, the boys target is shown and the mixed target is hidden.

## Applying Merges

After a merge is applied, the extension reloads meet data and recalculates opportunities.

The same target can be used again in a later operation if another valid multi-source merge into that target still exists.

However, a single remaining source event will not be suggested by itself. For example, if you merge `6 & Under + 7-8` into `10 & Under` first, then `9-10` alone will not be offered afterward.
