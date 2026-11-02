# Sharing a Solo chat

Sharing uses ordinary channel membership. Solo project filing is private
client-side organization, independent of access; see [Solo](README.md).

## The model

- A Solo chat is a channel with the `buzz.solo` label.
- Access is membership. Sharing gives people a membership in the chat.
- A shared chat link is an ordinary message containing
  `[Chat: name](buzz://channel/<id>)`. It renders as a chat card when the target
  is a Solo chat; the `Chat:` label lets a viewer without access see it as one.
  Links carry no other share marker, and older `Session:` labels still render.

There are two ways to give access:

1. **Add a person** in the access dialog: one membership grant, no message.
2. **Share with a channel**: give the channel's current members who lack access
   a membership, then post the link there. Both entry points use
   `shareChatsWithChannel` in `src/features/solo/share.ts`.

## Access dialog

The Solo chat header's **Access** button and the conversation-row **Share…** action
open the one access dialog every conversation uses (`ChannelMembersDialog`). In a
Solo chat it is titled **Chat access**, with the chat name as its description.
Share stays in the same conversation: no metadata change, promotion to a channel,
Solo removal or automatic navigation to Messages. **Convert to channel** lives only
in the chat's actions menu. **Copy link** sits at the footer's leading edge and
copies `buzz://channel/<id>` only; its hint explains that copying grants no access.

One search field (accessible name **Search people and channels**, or **Search
people, agents and channels** for an owner who can add agents) filters current
access and lists people under **Not in this chat**, each with an **Add** button;
Enter adds the highlighted person. Adding is immediate and uses the Solo share rule
(`canShareSoloChat`), with per-person **Adding…**, error and **Retry** states. The
owner's selectable agents are offered too and join without starting a run. Where
the viewer cannot add agents, a note says to mention an agent in the chat instead.
Current access uses the channel groups (**People**, **Agents**) with Owner and
Admin tags, and each row has the channel members' actions menu, so the chat owner
can remove someone. The verified roster shows loading or failure, never treating a
failed read as an empty audience.

Invitations use the same groups and controls as channels: **Your agents** first,
then **People**, **Other agents** and **Your other agents**, omitting empty groups.
Solo still excludes agents the viewer cannot add directly. Each group uses shared
name, relationship and usage ranking, begins with four rows, and expands with its
own **Show more**. Only the viewer's client agents are suggested without typing,
and only while the viewer is the sole member. With anyone else in the roster,
search is required to offer invitations. Search still finds people and channels
for sharing; this presentation grants no additional authority.
Solo and channels intentionally share the device-local `channel-members` usage
picks, so a choice in either surface can improve its order in the other.

While searching, eligible stream/forum channels appear in a **Channels** group;
**Select** chooses one. The selected channel shows **#name** with its **N members**,
expandable to inspect participants. **Share** gives that channel's current members (agents
included, archived members skipped, at most 100 needing access) membership in the
chat, then posts one link message in the channel through the Outbox and closes.
The toast **Shared in #channel** offers **View**, which opens the posted link. If a
grant fails, the dialog shows the error and **Retry share**; a retry reads the
channel again and grants only whoever is still missing. Grants already confirmed
stay. With no channel selected, **Done** closes without writes.

The sidebar's Shared mark is status only: it uses the verified current roster and
cached non-agent evidence for an additional human. Unknown profiles remain
unclassified; absence of the indicator is **not** a privacy promise. Clicking the
indicator opens the same dialog.

## Sending a chat link in a channel

Pasting a recognized Solo chat link into a composer stages it as a chat card.
Sending that card into a channel (at channel level or in a thread) or a DM asks
**Share and send** or **Send link only**. Closing keeps the draft and sends nothing.

The conversation's members are read before asking. In a channel, the dialog names
the channel and how many members don't yet have access. In a DM, it names the
people who don't (or counts them while a name is still unknown). When everyone
already has access, or no one else is in the conversation, the message sends
without asking. If Share can't
succeed (the viewer can't share the chat, or more than 100 members need access),
the dialog explains why and offers only link-only.

**Share and send** runs the same channel share, then the composer sends the one
original message. It keeps the members it read for the prompt, so a retry after a
failed grant never widens who gets access. A failed grant leaves the message
unsent with Retry in the dialog; grants that succeeded remain. A changed draft or
leaving the composer stops further grants and sending, not already dispatched
writes. **Send link only** leaves access unchanged. Solo destinations keep their
ordinary behavior and don't ask.

Consent covers the full chat history and future messages. Sharing never
unarchives anyone or removes them from a channel, and future joins or departures
in the destination channel are not synchronized.

## Explicit conversion, separate from Share

The product owner approved this distinction on 2026-10-14: **Share** keeps the
Solo label and project filing; **Convert to channel** removes the Solo label and
the initiating viewer's project filing, so the same conversation becomes an
ordinary Team channel, either Private or Public. It changes organization and
conversation behavior for every member, never creates a new conversation or
copies history.

The Solo chat header overflow and the Solo row menu offer **Convert to channel**
for the viewer's own Solo chat.
`src/features/solo/ConvertToChannel.tsx` reuses the shared Dialog, Field,
Private/Public RadioGroup and Button. Private is the default; Public warns that the
community can view the full existing history. A selected share channel is never
granted by conversion. Cancel writes nothing and returns focus to the retained
initiating control.

The sequence is explicit, not atomic:

1. Confirm one signed kind-9002 command through the existing `channelDetails`
   owner. Fresh metadata, owner/admin authority, conflict checks,
   altered-signature rejection and exact readback remain unchanged. The edit
   removes `buzz.solo` from the channel's labels and applies the chosen
   visibility; name, lifetime and other labels are preserved.
2. Refresh Solo projects and, if this viewer filed the chat in one, clear only
   that assignment through `soloPreferences.assign(id, undefined)`. Its encrypted
   account/community record, serialization and Outbox own persistence. Other
   projects, conversations, defaults, memberships and other people's filing are
   untouched.
3. Announce **Converted to channel.** and open the same channel ID in Team. No
   new grant, notification, agent wake or transcript write occurs.

The form lives outside the disappearing Solo row. Replacement-composer autofocus
does not steal its focus. Actual navigation, connection replacement and unmount
fence subsequent steps and late completion; already-enqueued writes still belong to
their existing durable owners. No completion navigation is sent to a superseded
visit.

### Partial success and recovery

An uncertain metadata publication offers **Check status**, never automatic resend.
The pending details owner retains exact selected visibility; **Reload chat
details** recovers failed reads without losing that intent. If another details
surface confirmed the publication, fresh matching metadata can advance the retained
conversion receipt without another kind-9002 command.

`conversion.ts` retains only chat-local orchestration intent and the confirmed
metadata phase, with a shared running guard. It is not permission evidence or a
persistent transaction. After the label edit succeeds but project unfiling fails,
the dialog says **Channel converted. Finish removing it from its Solo project.**
**Finish conversion** re-reads details, confirms the label is gone and the
settings are unchanged, and retries only the preference write. Restart loses the
orchestration receipt, not access or the channel: the conversation is already an
ordinary Team channel, and a leftover project assignment for a channel without the
label is ignored by Solo.

### Ordinary behavior after conversion

Without the label, every member and agent reads the conversation as an ordinary
channel. Subsequent Claude/Codex/native-runner turns use ordinary channel
reply/typing policy. Already admitted turns retain their frozen policy;
conversion does not cancel running work. No runtime rewrite or new agent authority
is added. Old Solo routes use type-correct composer flags and ordinary recipient
controls for an ordinary channel.

The same ID, history, Canvas, members, other labels and lifetime remain. Public
uses the existing `visibility=open` wire tag and does not introduce an enforceable
View-only role.

## Explicitly deferred or blocked

- **Create new channel** was removed from the Share dialog for this slice.
- Optional creation names, saved renames and standalone lifetime use the unified
  [Chat settings](README.md#optional-naming) form, not Share. Persisted naming
  provenance, automatic-name reset and dynamic link titles remain deferred.
  Old and new generated links keep their numeric labels after a rename.
- **Can view / Can participate** is deferred to a second PR. Read-only requires
  relay-enforced authorization and a matching client capability contract; a
  cosmetic role switch or disabled composer is not sufficient. This slice shows
  neither a fake dropdown nor a static role tag.
- Direct-person DM/link delivery is not implemented. Access grants alone are not
  a dedicated invitation or share notification; explicit automatic handoff needs
  a separate product decision.
- Dynamic destination inheritance/revocation, grant provenance and removal
  permissions remain unimplemented. Standalone creation/lifetime editing belongs
  to Chat settings, not a dependency of sharing or conversion and not a Share
  option. No provenance is inferred from links or membership.

## Validation

`share.test.ts` covers grants, channel audiences, archived members, retry without
repeated grants and the share blockers. `ChannelMembersDialog.solo.test.tsx` and
`chat-link-sharing.test.tsx` cover the dialog and the composer prompt.
Live relay ACLs, cross-account discovery and no-wake behavior are separate
checks.
