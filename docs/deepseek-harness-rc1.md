# DeepSeek Harness rc.1 compatibility

The ClawNest Linux platform build uses DSH `0.2.2-rc.1` and the matching SDK.
It carries the existing official DSH plugin with these compatibility updates:

- Wait for Cordis loader completion without holding the readiness barrier.
- Preserve native question providers; Connect handles only owned roots after
  native `NO_PROVIDER`. Cancellation and other native errors propagate.
- Use the registry setup callback's explicit Agent, native model current/select,
  and session seq/eventAt APIs.
- Read persisted sessions through open/read/close and snapshot headers.
- Bound failed-child termination and reap processes that ignore SIGTERM.

Bundle entry and bridge asset hashes remain release-pinned and verified. Build
the plugin after changing its entry dependencies; update the embedded registry
from the resulting artifact integrity before compiling Core. A platform build
must retain the generated bundle beside Core and include the managed skills.

`platform/entry.ts` is a Linux container entrypoint: ordinary CLI arguments still
use the existing CLI. Its platform state operation returns only selected identity
and availability fields and can establish a new conversation's workspace intent.
It does not export credentials. The public installer remains Darwin-only; this
build does not claim to add an official Linux release archive.

Clawnest-managed ClawChat, Manager/browser chat, initial greetings and native Web
launch with `danger-full-access` (filesystem sandbox disabled, approval `never`).
The common generated patch and native permission plugin apply the same startup
preset to fresh and restored sessions, preserving their identity and history.
Changing a preset within a running session still uses native DSH controls; its
next managed restore reapplies the platform startup policy. This does not change
generic Connect installations, ClawChat authentication or native questions.

DSH inputs carry ClawChat turn identity in native message-source metadata rather
than the `<clawchat_turn_context>` text envelope. Direct chat reaches the model
as its original body. Groups retain structured mentions, batch content and
explicitly read-only background without transport IDs/digests. Native history
and reconnect reconciliation read the durable metadata and retain compatibility
with old sessions containing the text envelope.
