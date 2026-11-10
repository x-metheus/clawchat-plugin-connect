// Clawnest-managed startup policy; generic Connect installations retain their presets.
export const name = 'clawnest-dsh-permission';
export const inject = ['permissionPresets', 'agents'];

export function apply(ctx) {
 const initialize = ({agent}) => {
  // Native defaults only seed new sessions. Restored sessions also need the
  // owner-selected startup preset, using DSH's durable setters rather than
  // replacing session files or changing preset definitions.
  ctx.permissionPresets.set(agent.session, 'danger-full-access');
  // Native set() compares effective knobs. A delegated Auto session can
  // already match full/never while retaining the Auto identity, which native
  // restore rejects without its optional review integration.
  if (ctx.permissionPresets.permissionState(agent.session).preset !== 'danger-full-access') {
   agent.session.append('permission/preset', {preset:'danger-full-access'});
  }
 };
 // Run before native pinInitialPermission, which can reject a persisted Auto
 // preset when its optional review integration is no longer installed.
 ctx.on('agent/created', initialize, {prepend:true});
 for (const agent of ctx.agents.list()) initialize({agent});
}
