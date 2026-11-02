export const confirmations = {
  channel: {
    title: "Change channel?",
    description:
      "Unsaved draft changes will be discarded. Submitted operations remain with their original channel; switching does not cancel or repeat them.",
    action: "Change channel",
  },
  leave: {
    title: "Leave this draft?",
    description:
      "Unsaved draft changes will be discarded. Any submitted operation stays with the captured community session; leaving does not cancel or repeat it.",
    action: "Leave draft",
  },
  delete: {
    title: "Delete this workflow?",
    description:
      "The saved workflow may remain visible. Work already running may continue.",
    action: "Delete workflow",
    cancel: "Cancel",
    destructive: true,
  },
  enable: {
    title: "Save this workflow enabled?",
    description:
      "The relay may run this workflow automatically when its trigger matches. Saving does not prove a run succeeded.",
    action: "Save enabled workflow",
  },
  dismiss: {
    title: "Dismiss this notice?",
    description:
      "Dismissal only clears this notice and its editor lock. It does not undo, cancel, or repeat a command, or confirm its outcome. Review the saved configuration before saving again; a new run request may run the workflow again. Your unsaved draft is kept.",
    action: "Dismiss notice and continue",
  },
  secret: {
    title: "Continue without this secret?",
    description:
      "This private webhook secret cannot be recovered. Copy and store it before continuing, or explicitly leave it behind.",
    action: "Continue",
    cancel: "Go back",
  },
};

export const dialogs = [
  {
    id: "search",
    name: "Search Buzz",
    group: "Shared dialogs",
    path: "App header → magnifying glass or ⌘K / Ctrl+K",
    source: "src/app/shell/PageSearch.tsx",
    frame: "Dialog",
    note: "Page destinations in the shared search palette. Live conversation search requires a community and is not connected in this fixture.",
  },
  {
    id: "join",
    name: "Join a community",
    group: "Shared dialogs",
    path: "Community picker → Join a community",
    source: "src/features/communities/CommunityDialog.tsx",
    frame: "Dialog · 3 steps",
    note: "Try wss://relay.example.test, then Continue through access and profile. Requests and publication are simulated locally.",
  },
  {
    id: "channel",
    name: "Change workflow channel",
    group: "Workflow confirmations",
    path: "Workflows → change channel with an unsaved draft",
    source: "src/bundled/workflows/WorkflowsPage.tsx",
    frame: "ConfirmAction → AlertDialog",
    note: "Protects the current draft before navigating to another channel.",
  },
  {
    id: "leave",
    name: "Leave a workflow draft",
    group: "Workflow confirmations",
    path: "Workflows → select another workflow with an unsaved draft",
    source: "src/bundled/workflows/WorkflowChannel.tsx",
    frame: "ConfirmAction → AlertDialog",
    note: "Protects unsaved edits when selecting a different configuration.",
  },
  {
    id: "delete",
    name: "Delete a workflow",
    group: "Workflow confirmations",
    path: "Workflows → saved workflow → Delete",
    source: "src/bundled/workflows/WorkflowChannel.tsx",
    frame: "ConfirmAction → AlertDialog",
    note: "Destructive confirmation with direct wording. Deletion does not confirm cancellation of running work.",
  },
  {
    id: "enable",
    name: "Enable a workflow",
    group: "Workflow confirmations",
    path: "Workflows → save a workflow enabled",
    source: "src/bundled/workflows/WorkflowEditor.tsx",
    frame: "ConfirmAction → AlertDialog",
    note: "Copy changes for an unfiltered message trigger or a schedule. Select those variants in the inspector.",
  },
  {
    id: "dismiss",
    name: "Dismiss an operation notice",
    group: "Workflow confirmations",
    path: "Workflows → operation notice → Dismiss",
    source: "src/bundled/workflows/WorkflowOperations.tsx",
    frame: "ConfirmAction → AlertDialog",
    note: "Longest confirmation copy. The inspector also exposes its pending and error states.",
  },
  {
    id: "secret",
    name: "Continue without a webhook secret",
    group: "Workflow confirmations",
    path: "Webhook secret → Continue before revealing or copying",
    source: "src/bundled/workflows/WorkflowWebhookSecretDialog.tsx",
    frame: "ConfirmAction → AlertDialog",
    note: "Cancel reads Go back rather than Keep editing; confirming discards the only copy of the secret.",
  },
  {
    id: "webhook",
    name: "Webhook secret",
    group: "Workflow dialogs",
    path: "Workflows → save a workflow that first gains a webhook trigger",
    source: "src/bundled/workflows/WorkflowWebhookSecretDialog.tsx",
    frame: "Dialog",
    note: "Shown once after the save receipt: hook URL, masked secret, reveal and copy. Leaving before revealing or copying opens the confirmation. Select the no-address variant in the inspector.",
  },
  {
    id: "attachment",
    name: "Attachment fullscreen",
    group: "Media viewers",
    path: "Attachment → fullscreen, when no review handler is supplied",
    source: "src/features/messages/MediaAttachment.tsx",
    frame: "Local media modal",
    note: "Fallback image/video stage with an explicit close control and backdrop dismissal. Sample image shown.",
  },
  {
    id: "review",
    name: "Media review",
    group: "Media viewers",
    path: "Messages → open an attachment for review",
    source: "src/features/messages/MediaReviewViewer.tsx",
    frame: "Local review modal",
    note: "Image gallery or video stage beside thread comments. Sample image and an in-memory conversation; no live relay.",
  },
] as const;

export type DialogId = (typeof dialogs)[number]["id"];
