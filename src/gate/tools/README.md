# Tool plugins

**One tool per file. Drop a file in this directory and it is loaded; the core
does not change.**

The bridge does not enumerate or validate tool names. Adding a tool = adding a
file; removing one = deleting the file or setting `enabled: false`.

## Shape of a plugin

```js
module.exports = {
  name: "reply",                    // tool name: states the intent, never an address
  description: "…",                 // shown to the agent; say when to use it
  schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },

  // one of —
  intent: "send_text",              // (1) delivery: hand off to outbound (channel/capability/cold log/ledger)
  async handler(args, ctx) { … },   // (2) action: does its own work, never delivers messages
};
```

## Two hard rules

1. **Tool names are intents, not addresses.** No `telegram_reply`-style names:
   choosing a tool must not decide the destination — outbound does. A channel
   can be requested via the optional `channel` argument:
   - omitted → outbound replies along this turn's origin
   - given → honoured, but if that plugin is down or does not support the
     intent, the failure is reported explicitly; it is never silently rerouted

2. **Delivery plugins never send by themselves.** No direct platform API calls
   in a handler. Tools that send directly bypass routing, the cold log and the
   ledger, so the bridge would not know the agent said anything.
