# End-user run of block/buzz-app#2878 at 4e108350d

Desktop app built on a separate Linux machine from a test branch that merges #3725 (f26a1060f), #3726 (4f31f7798) and #2878 (4e108350d), against a local relay built from block/buzz#9589 (3df54db74) and the mention-groups plugin. Throwaway identities only.

| File | What it shows |
| --- | --- |
| `e2e/group-row.png` | `@mrm` lists the people rows, then the plugin's Groups row "mrm, 4 people, 1 agent" |
| `e2e/chip-click.png` | Clicking the row inserts one `@mrm · 4` mention chip |
| `e2e/arrow-selected.png` | ArrowDown moves the selection to the group row |
| `e2e/chip-keys.png` | Enter inserts the same single `@mrm · 4` chip |
| `e2e/before-send.png` | The chip with the typed text, before sending |
| `e2e/sent-timeline.png` | The timeline shows `@mrm please review the deck` as plain text |
