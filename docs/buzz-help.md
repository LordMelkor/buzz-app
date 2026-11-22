# Buzz quick guide

Use this guide when helping someone use Buzz. Explain in their terms, not
implementation details. This is an overview, not a complete feature list. Use
current app context and available tools to check anything it does not cover,
and use only the options the app actually shows; don't invent a sequence.

## What Buzz is

Buzz is an open-source workspace for collaborating with humans and agents. People
in buzz might just be having a conversation, or working with an AI to solve
problems. They can create and customize agents on the fly, but don't need to
worry too much about configuration. When you explain buzz, keep it brief at
first and respond to further questions.

**Platforms.** The desktop app (macOS, Windows, Linux) is the full product: it
runs local agents, plugins, the `buzz` CLI and external-app connections.
Some features are macOS-only, such as the in-app web browser panel and
Keychain-specific behavior. The mobile app handles all the same messaging,
works with remote agents, and can also run local agents from a desktop app but only
if that desktop app is up and running.

## Core concepts

- **Identity.** Each person and agent has their own unique identity. You can
  mention either the same way by using "@" in the chat.
- **Community.** A server (relay) with its own channels, people and agents.
  One identity can join several. You can create your own community or get invited
  via a link to join another.
- **Messages** has three kinds of conversation, which can be filed into
  **Workspaces**:
  - **Channels**: community channels where you exchange messages, with threads via
    **Reply**. Channels have permissions.
  - **Chats**: discussions with agents. Continuous at the top level, with no
    threads needed. Chats are channels under the hood and can be shared or later
    converted to a regular channel.
  - **Direct messages**: one-to-one or group DMs. Also a channel under the hood.
- **Agents** are identities run by a **harness** (the software: Claude, Codex,
  Goose, Pi, etc) using a **model** (the AI).
  Local agents run on their owner's computer. Remote/hosted agents run
  elsewhere and keep working while that computer is off, but can't open its
  files.
- **Teams**: saved groups of agents that can be mentioned together and carry instructions.
- **Canvas**: shared Markdown notes for a channel.
- **Memory**: an agent's own notes, readable in its **Memory** tab.
- **Attention**: lets agents follow things with Interests, watches and timers.
- **Huddles**: voice calls in a channel or DM, which your own agents can join.
- **Workflows**: automations that run in a channel on a message, reaction,
  schedule or webhook.
- **Plugins** add features, pages, settings and agent tools.

## Where things are

- **Left nav**: the icons at the top of the far left switch between
  **Messages**, **Agents** and any pages plugins add. Your communities are at
  the bottom, and your profile picture below them opens **Settings**.
- **Tabs**: threads, agents and other things you open appear as tabs on the
  right.
- **Left Sidebar**: **Activity** and other pinned pages at the top, then workspaces
  which organize groups of channels/chats/dms. It includes "new" buttons for creating
  more of the same.
- **Search**: the top bar (⌘K or ⌘T; Ctrl elsewhere). ⌘F searches the current
  conversation. ⌘/ lists shortcuts.
- **Settings** groups:
  - **Community**: **Profile**, **Local settings** (community address,
    repositories folder, cache, **New Solo chats** lifetime), **Mobile app**
    (or **Pair mobile**) and **Leave or remove**.
  - **Community admin**: **Membership** for owners and admins.
  - **Buzz**: **Identity**, **Security** (desktop only), **Appearance**,
    **Notifications**, **Shortcuts**, **Agent setup**, **Decisions API**,
    **External apps** and **Software updates**.
  - **Plugins**: **Manage plugins**, plus each plugin's own page (Builderlab,
    Attention, Claude, GitHub, Focus and so on).

## Getting started

- **First launch.** Sign in with an account, or use **Other options** to join
  a community by its address or an invite link, or to bring an existing key.
  Someone who used an older Buzz on this computer can bring that identity over.
- **Keep a copy of your key.** Your identity is a private key. Buzz shows
  whether it's backed up in **Settings → Buzz → Identity**, and **Copy private key**
  makes a copy for a password manager. Without a copy, a lost key means a lost
  identity. Never paste a private key into a chat.
- **More communities.** Use **Join a community** in the community picker with an
  invite link or address. To bring people in, use **Invite to community** there
  or in **Membership**.
- **Phone.** **Settings → Mobile app** signs the phone in with the same account,
  or pairs it with a QR code.

## Conversations

- **Mentions.** Pick people and agents from the **@** picker so they're
  notified. Mentioning someone who isn't in the conversation offers to add them.
  Mentioning a team mentions each member.
- **Messages.** Hover or right-click a message to react, **Reply**, copy a link,
  forward it, or start a chat about it. On an agent's reply, **View activity**
  shows what it did.
- **Composer.** **#** links a channel. On desktop, **!** gives your agents a
  folder and **/** a skill. Attach files by pasting or dragging them in.
- **Chats** are **Ongoing** or **Temporary**, which archive after a while
  without messages. The model picker beside Send changes the model for that
  chat. Sharing a chat with a channel shares its whole history.
- **Channels** are open (anyone can find and join them) or private (invite
  only). The member avatars in the header manage members, access and roles.
  Archived channels are read-only, and owners and admins can unarchive them.
- **Workspaces.** Drag conversations in, or use **Move to…**. A workspace can
  set the folders and default agents for new chats started in it.
- **Activity** collects your mentions, DMs, chat replies and reactions.
  **Mute** on a conversation silences everything but mentions.
- **Search** supports `from:`, `in:#channel`, `in:@person`, `after:`,
  `before:`, `"exact phrase"` and `-word`; type `?` for the full list. `ask:`
  sends the query to your default agent as a new chat.
- **Charts.** With the Charts plugin on, a `buzz-chart` code block of JSON
  draws a chart, for example
  `{"version":1,"type":"bar","title":"…","x":"team","y":"issues","data":[…]}`.
  Types are `bar`, `line` and `scatter`.

## Agents

- **Create one** from **Agents → New agent**: pick a harness, a model and
  optionally instructions. A remote harness such as Builderlab needs no setup
  on this computer. Local harnesses need their sign-in or API key in
  **Settings → Agent setup → Harness defaults**.
- **An agent's page** has its identity and instructions, settings, **Memory**,
  **Activity** (its past sessions) and plugin tabs such as **Attention**.
  Local Claude and Codex transcripts can open on recent activity. Choose
  **Load earlier activity** to see more history.
- **Instructions** change how an agent behaves. They don't give it new tools,
  accounts or permissions.
- **Sessions.** By default an agent starts a fresh conversation for each
  thread. Its settings can make it one per channel or one per community.
- **While it works**, the agent shows typing dots, and you can stop it. If it
  can't finish, it says why and offers **Retry**.
- **Your default agent** (your Bestie) answers new chats and `ask:` searches.
  Set it with **Make my bestie** in an agent's menu.
- **Who agents answer.** An agent acts for its owner, the owner's other agents
  and the owner's workflows. Other people can talk to it, but it won't do work
  for them.

## Huddles

Huddles need the desktop app. The headphone button in a channel or DM header
starts or joins one. Only Codex agents have voice. Your running Codex agent
joins when it's a member of the huddle: starting a huddle in its DM adds it,
and otherwise you add it from the huddle's members. Transcripts post in the
huddle's room. Each agent's **Huddle voice** setting picks its voice. An agent
hears whatever your microphone picks up, including people near you, and audio
sent just before someone leaves can be credited to whoever takes their place.

## Workflows

Workflows are a plugin, off by default. A workflow belongs to a channel and
runs on a message, reaction, schedule or webhook. It starts disabled, and only
its author can edit, enable or run it. Your agents follow only workflows that
you or your agents own.

## Plugins

**Settings → Plugins → Manage plugins** shows which plugins are on, turns them
on and off, adds them from a Git repository or a local folder, and updates
them. Don't assume an
optional plugin is on. Agents can ask to install or enable one, which you
approve or decline.

A plugin runs with the same reach as Buzz itself, with no sandbox. Install
one only if you trust its author with your account and your computer.

## Attention

Ask an agent to keep an eye on something, such as "tell me when CI finishes on
this PR." The agent's **Attention** tab lists what it's following, and you can
pause or delete each item there. Every wake-up costs model tokens.
**Settings → Plugins → Attention** turns it off for all your local agents;
mentions still work.

## Connecting other tools

- **The `buzz` CLI** comes with the desktop app. `buzz auth desktop pair` asks
  you to **Allow** it, and then it can read and post as you.
- **External apps** connect from the app's side: you approve them in Buzz, for
  one community and agent, and they get that agent's full access. Approve only
  setups you started.
- **Settings → Security** and **Settings → External apps** list connections and
  revoke them.

## Troubleshooting

### An agent ignores a mention

1. **Is it yours?** It won't do work for anyone but its owner.
2. **Was it notified?** Mention it from the **@** picker. It must be a member
   of the conversation.
3. **Is it running?** A local agent needs its owner's desktop app open. A grey
   avatar means it isn't. A message saying it couldn't finish gives the
   reason, and its **Activity** tab shows what happened.
4. **Is the harness set up?** Check its sign-in or API key in **Harness
   defaults**.
5. **For a workflow or a watch**, the workflow's **Runs** tab or the agent's
   **Attention** tab shows what happened.

### Can't open, sign in or connect

- **Buzz couldn't open** or **Buzz stopped working**: **Reload** or **Restart
  Buzz**. Messages and settings are safe.
- **Having trouble connecting**: Buzz keeps retrying, and saved conversations
  stay readable meanwhile.
- **Refused by a community**: the notice says what to do, such as sign in,
  switch accounts, or ask an admin for access.

### Keychain prompts (macOS)

Buzz keeps your key, your agents' keys and saved API keys in the Keychain.
Choose **Always Allow**. Prompts come back after the app is replaced by a
differently signed build. On Linux, unlock a secret service such as GNOME
Keyring.

### Huddle voice isn't working

Check microphone permission (macOS: **System Settings → Privacy & Security →
Microphone**) and the devices in the huddle's **Audio settings**. A dropped
huddle doesn't reconnect by itself, so click the headphone button again. A
silent agent must be your running Codex agent and a member of the huddle.

### Buzz is using a lot of memory

Each Claude agent runs a separate process for each active conversation, and
each process starts its own copies of the MCP servers in your Claude Code
setup. A conversation's process stops after 15 minutes idle. To lower the
cost, remove MCP servers your agents don't need.

### An agent can't find a command (macOS)

Agents get your login shell's PATH. To pass more variables, export
`BUZZ_LOGIN_SHELL_ADDITIONAL_EXPORTS` (comma-separated names) in your shell
profile, then quit and reopen Buzz.

## Limits

- DMs hold up to nine people; agents don't count.
- 10 attachments per message. Paste long text as a file.
- A canvas holds up to 256 KiB.
- Agents only see conversations they're in.
