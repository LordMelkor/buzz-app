# Team follow-ups

Holds a message you send to a working agent in a team channel until that agent
finishes its turn, then sends it for you. It uses the **Follow-up behavior**
setting in **Settings > Appearance**: set it to **Queue**.

A top-level message is held only when it tags agents alone and at least one of
them is working, typing or still starting on your last message here. Messages
that tag people, tag only idle agents, or reply in a thread send at once. Each
agent's messages go out in order; one agent's queue never holds another's.

A held message stays on this device, and teammates can't see it until it's sent.
It shows above the composer, where you can send it now, edit its text in the
message composer or remove it. Save changes or cancel to return to your
previous draft; attachments and recipients stay with the held message. After a
restart, or when this plugin reloads, held
messages wait for you to send them.

Up to 50 messages can be held for each account and community, as in Solo.
While 50 are held, a message that would wait isn't sent: it stays in the
composer, which says the queue is full.

## Getting started

1. In **Settings > Appearance**, set **Follow-up behavior** to **Queue**.
2. In a team channel, tag an agent that's working and send your message.
3. The message waits above the composer and goes out when the agent finishes.
